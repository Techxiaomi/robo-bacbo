from pathlib import Path
import json

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"


def detalhes_periodo():
    return {
        "green_direto": 1,
        "gale1": 1,
        "gale2": 0,
        "red": 1,
        "ties": {"direto": {"4x": 1}, "gale1": {}, "gale2": {}},
        "max_green_seq": 3,
        "max_red_seq": 1,
    }


def responder_json(route, payload, status=200):
    route.fulfill(
        status=status,
        content_type="application/json",
        body=json.dumps(payload, ensure_ascii=False),
    )


def main():
    loader_html = (PUBLIC / "index.html").read_text(encoding="utf-8")
    app_html = (PUBLIC / "dashboard-app.html").read_text(encoding="utf-8")
    dashboard_js = (PUBLIC / "dashboard-ui.js").read_text(encoding="utf-8")
    enhancements_js = (PUBLIC / "ui-enhancements.js").read_text(encoding="utf-8")
    lab_js = (PUBLIC / "lab-enhancements.js").read_text(encoding="utf-8")

    estrategia = {
        "id": "est-1",
        "nome": "Padrao Teste",
        "origem": "Origem A",
        "padrao": '["Player","Banker"]',
        "entrada": "Player",
        "gales": 0,
        "proteger_empate": True,
        "ativo": True,
        "is_dinamico": False,
        "detalhes": {
            "24h": detalhes_periodo(),
            "hoje": detalhes_periodo(),
            "semana": detalhes_periodo(),
            "mes": detalhes_periodo(),
            "geral": detalhes_periodo(),
        },
    }
    robo = {
        "id": 7,
        "nome": "Robo Teste",
        "tag_visual": "[TESTE]",
        "cor_hex": "#17a2b8",
        "ativo": True,
        "enviar_web": True,
        "enviar_telegram": False,
        "greens_consecutivos": 4,
        "reds_consecutivos": 0,
        "stop_reds_seguidos": 0,
        "config": {"origens": ["Origem A"], "avulsos": [], "excecoes": []},
        "destinatarios": [],
        "qtd_padroes_ia": 0,
        "detalhes": {
            "24h": detalhes_periodo(),
            "hoje": detalhes_periodo(),
            "semana": detalhes_periodo(),
            "mes": detalhes_periodo(),
            "geral": detalhes_periodo(),
        },
    }

    socket_stub = """
        window.__socketHandlers = Object.create(null);
        window.io = function () {
            return {
                on: function (evento, callback) {
                    window.__socketHandlers[evento] = callback;
                }
            };
        };
    """

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page_errors = []
        page.on("pageerror", lambda error: page_errors.append(str(error)))

        def handle(route):
            url = route.request.url
            path = url.split("?", 1)[0]

            if path == "http://bacbo.test/":
                route.fulfill(status=200, content_type="text/html", body=loader_html)
                return
            if path == "http://bacbo.test/dashboard-app.html":
                route.fulfill(status=200, content_type="text/html", body=app_html)
                return
            if path == "http://bacbo.test/dashboard-ui.js":
                route.fulfill(status=200, content_type="application/javascript", body=dashboard_js)
                return
            if path == "http://bacbo.test/ui-enhancements.js":
                route.fulfill(status=200, content_type="application/javascript", body=enhancements_js)
                return
            if path == "http://bacbo.test/lab-enhancements.js":
                route.fulfill(status=200, content_type="application/javascript", body=lab_js)
                return
            if path == "http://bacbo.test/socket.io/socket.io.js":
                route.fulfill(status=200, content_type="application/javascript", body=socket_stub)
                return
            if "cdn.jsdelivr.net/npm/chart.js" in url:
                route.fulfill(status=200, content_type="application/javascript", body="window.Chart = function() {};" )
                return
            if "cdnjs.cloudflare.com/ajax/libs/html2pdf.js" in url:
                route.fulfill(status=200, content_type="application/javascript", body="window.html2pdf = function() {};" )
                return
            if path == "http://bacbo.test/api/estrategias":
                responder_json(route, [estrategia])
                return
            if path == "http://bacbo.test/api/origens":
                responder_json(route, [{"id": 1, "nome": "Origem A"}])
                return
            if path == "http://bacbo.test/api/robos":
                responder_json(route, [robo])
                return
            if path == "http://bacbo.test/api/auto-traders":
                responder_json(route, [])
                return
            if path == "http://bacbo.test/api/dashboard-stats":
                responder_json(route, {
                    "sinais": 6,
                    "greens": 4,
                    "reds": 2,
                    "ties": 1,
                    "max_green_seq": 3,
                    "max_red_seq": 2,
                    "assertividade": "66.7%",
                })
                return

            route.fulfill(status=404, content_type="text/plain", body="not found")

        page.route("**/*", handle)
        page.goto("http://bacbo.test/", wait_until="domcontentloaded")

        page.wait_for_function(
            """
            () => document.querySelectorAll('#sintonizador-web option').length === 2
                && document.querySelectorAll('#select-origem-dash option').length === 2
                && document.querySelectorAll('#select-robo-dash option').length === 2
                && document.querySelectorAll('#select-origem-filtro option').length === 2
            """,
            timeout=10000,
        )

        page.wait_for_function(
            """
            () => document.getElementById('dash-sinais')?.innerText === '6'
                && document.getElementById('dash-greens')?.innerText === '4'
                && document.getElementById('dash-reds')?.innerText === '2'
                && document.getElementById('dash-ties')?.innerText === '1'
                && document.getElementById('dash-max-green')?.innerText.includes('3')
                && document.getElementById('dash-max-red')?.innerText.includes('2')
                && document.getElementById('dash-assertividade')?.innerText === '66.7%'
            """,
            timeout=10000,
        )

        page.wait_for_function(
            """
            () => {
                const texto = document.getElementById('lista-robos')?.innerText || '';
                return texto.includes('Robo Teste')
                    && texto.includes('24H')
                    && texto.includes('Hoje')
                    && texto.includes('Semana')
                    && texto.includes('Mês')
                    && texto.includes('Geral')
                    && texto.includes('Maior sequência Green')
                    && texto.includes('Maior sequência Red')
                    && texto.includes('🔥 3');
            }
            """,
            timeout=10000,
        )

        page.wait_for_function(
            """
            () => document.querySelectorAll('#bk-entrada option').length === 5
                && document.querySelectorAll('#bk-range option').length === 7
                && document.querySelectorAll('#mn-range option').length === 7
                && document.querySelectorAll('#bk-dashboard-range option').length === 7
                && !document.getElementById('bk-prot')
                && typeof window.rodarBacktestManualAprimorado === 'function'
                && typeof window.atualizarDashboardBacktestPorRange === 'function'
            """,
            timeout=10000,
        )

        opcoes = page.evaluate(
            """
            () => ({
                sintonia: Array.from(document.querySelectorAll('#sintonizador-web option')).map(o => o.textContent.trim()),
                origemDash: Array.from(document.querySelectorAll('#select-origem-dash option')).map(o => o.textContent.trim()),
                roboDash: Array.from(document.querySelectorAll('#select-robo-dash option')).map(o => o.textContent.trim()),
                origemPadroes: Array.from(document.querySelectorAll('#select-origem-filtro option')).map(o => o.textContent.trim()),
                sinais: document.getElementById('dash-sinais').innerText,
                greens: document.getElementById('dash-greens').innerText,
                reds: document.getElementById('dash-reds').innerText,
                ties: document.getElementById('dash-ties').innerText,
                maxGreen: document.getElementById('dash-max-green').innerText,
                maxRed: document.getElementById('dash-max-red').innerText,
                assertividade: document.getElementById('dash-assertividade').innerText,
                dashboardOrdem: Array.from(document.querySelectorAll('#dashboard-resumo-grid > .dash-box')).map(card => card.querySelector('span')?.textContent.trim()),
                cardRobo: document.getElementById('lista-robos').innerText,
                autoTraderTexto: document.getElementById('nav-btn-autotrader').innerText.trim(),
                labModos: Array.from(document.querySelectorAll('#bk-entrada option')).map(o => ({ value: o.value, label: o.textContent.trim() })),
                labSelecionado: document.getElementById('bk-entrada').value,
                labRanges: Array.from(document.querySelectorAll('#bk-range option')).map(o => ({ value: o.value, label: o.textContent.trim() })),
                minerRanges: Array.from(document.querySelectorAll('#mn-range option')).map(o => ({ value: o.value, label: o.textContent.trim() })),
                minerSelecionado: document.getElementById('mn-range').value,
                dashboardBacktestRanges: Array.from(document.querySelectorAll('#bk-dashboard-range option')).map(o => ({ value: o.value, label: o.textContent.trim() })),
                dashboardBacktestSelecionado: document.getElementById('bk-dashboard-range').value,
                socketRegistrado: typeof window.__socketHandlers.alerta_painel === 'function'
            })
            """
        )

        assert "Robo Teste" in opcoes["sintonia"], opcoes
        assert "Origem A" in opcoes["origemDash"], opcoes
        assert "Robo Teste" in opcoes["roboDash"], opcoes
        assert "Origem A" in opcoes["origemPadroes"], opcoes
        assert opcoes["sinais"] == "6", opcoes
        assert opcoes["greens"] == "4", opcoes
        assert opcoes["reds"] == "2", opcoes
        assert opcoes["ties"] == "1", opcoes
        assert "3" in opcoes["maxGreen"], opcoes
        assert "2" in opcoes["maxRed"], opcoes
        assert opcoes["assertividade"] == "66.7%", opcoes
        assert opcoes["dashboardOrdem"] == [
            "Sinais Disparados", "Greens", "Empates", "Reds", "Maior Sequência", "Assertividade"
        ], opcoes
        assert "Entradas: 4" in opcoes["cardRobo"], opcoes
        assert "Empates: 1" in opcoes["cardRobo"], opcoes
        assert "Reds: 1" in opcoes["cardRobo"], opcoes
        assert opcoes["autoTraderTexto"] == "📈 Auto-Trader", opcoes
        assert [item["value"] for item in opcoes["labModos"]] == [
            "AUTO", "PLAYER", "PLAYER_TIE", "BANKER", "BANKER_TIE"
        ], opcoes
        assert opcoes["labSelecionado"] == "AUTO", opcoes
        assert "Automático" in opcoes["labModos"][0]["label"], opcoes
        assert "Player +" in opcoes["labModos"][2]["label"], opcoes
        assert "Banker +" in opcoes["labModos"][4]["label"], opcoes
        ranges_esperados = ["100", "200", "500", "1000", "2000", "5000", "MAX"]
        assert [item["value"] for item in opcoes["labRanges"]] == ranges_esperados, opcoes
        assert [item["value"] for item in opcoes["minerRanges"]] == ranges_esperados, opcoes
        assert [item["value"] for item in opcoes["dashboardBacktestRanges"]] == ranges_esperados, opcoes
        assert "Toda a Base (Max)" in opcoes["labRanges"][-1]["label"], opcoes
        assert opcoes["minerSelecionado"] == "1000", opcoes
        assert opcoes["dashboardBacktestSelecionado"] == "MAX", opcoes
        assert opcoes["socketRegistrado"] is True, opcoes

        page.evaluate(
            """
            () => {
                girosInMemoria = [];
                for (let i = 0; i < 10; i++) {
                    girosInMemoria.push({ resultado: 'Player', id_sessao: 99, multiplicador: '4x' });
                }
                for (let i = 0; i < 100; i++) {
                    girosInMemoria.push({ resultado: i % 2 === 0 ? 'Banker' : 'Player', id_sessao: 99, multiplicador: '4x' });
                }
                document.getElementById('bk-dashboard-range').value = 'MAX';
                window.atualizarDashboardBacktestPorRange();
            }
            """
        )
        assert page.locator('#bk-max-p').inner_text() == "10"

        page.evaluate(
            """
            () => {
                const select = document.getElementById('bk-dashboard-range');
                select.value = '100';
                select.dispatchEvent(new Event('change'));
            }
            """
        )
        assert page.locator('#bk-max-p').inner_text() == "1"

        page.evaluate("() => window.mudarPeriodoCardRobo('geral')")
        page.wait_for_function(
            "() => Array.from(document.querySelectorAll('#lista-robos .box-tempo')).some(el => el.classList.contains('ativo') && el.innerText.includes('Geral'))",
            timeout=5000,
        )

        page.evaluate(
            """
            () => {
                girosInMemoria = [
                    {resultado:'Player', id_sessao:1, multiplicador:'4x'},
                    {resultado:'Banker', id_sessao:1, multiplicador:'4x'},
                    {resultado:'Player', id_sessao:1, multiplicador:'4x'},
                    {resultado:'Player', id_sessao:1, multiplicador:'4x'},
                    {resultado:'Banker', id_sessao:1, multiplicador:'4x'},
                    {resultado:'Tie', id_sessao:1, multiplicador:'4x'},
                    {resultado:'Player', id_sessao:1, multiplicador:'4x'},
                    {resultado:'Banker', id_sessao:1, multiplicador:'4x'},
                    {resultado:'Banker', id_sessao:1, multiplicador:'4x'},
                    {resultado:'Player', id_sessao:1, multiplicador:'4x'},
                    {resultado:'Banker', id_sessao:1, multiplicador:'4x'},
                    {resultado:'Tie', id_sessao:1, multiplicador:'4x'}
                ];
                bkPadraoAtual = [];
                bkAdd('Player');
                bkAdd('Banker');
                document.getElementById('bk-gales').value = '0';
                document.getElementById('bk-range').value = 'MAX';
                window.rodarBacktestManual();
            }
            """
        )

        page.wait_for_function(
            """
            () => document.getElementById('bk-resultados-auto')?.style.display === 'block'
                && document.querySelectorAll('#bk-auto-grid .bk-auto-card').length === 4
            """,
            timeout=5000,
        )

        auto = page.evaluate(
            """
            () => ({
                singleDisplay: document.getElementById('bk-resultados-box').style.display,
                autoDisplay: document.getElementById('bk-resultados-auto').style.display,
                cards: Array.from(document.querySelectorAll('#bk-auto-grid .bk-auto-card')).map(card => ({
                    modo: card.dataset.bkModo,
                    texto: card.innerText,
                    assertividade: Number.parseFloat(card.querySelector('.bk-auto-assert')?.textContent || '0'),
                    ocorrencias: card.querySelector('.bk-auto-ocorrencias strong')?.textContent || ''
                }))
            })
            """
        )
        assert auto["singleDisplay"] == "none", auto
        assert auto["autoDisplay"] == "block", auto
        assert [card["modo"] for card in auto["cards"]] == [
            "PLAYER_TIE", "BANKER_TIE", "PLAYER", "BANKER"
        ], auto
        assert [card["assertividade"] for card in auto["cards"]] == sorted(
            [card["assertividade"] for card in auto["cards"]], reverse=True
        ), auto
        for card_auto in auto["cards"]:
            assert "Greens" in card_auto["texto"], auto
            assert "Empates" in card_auto["texto"], auto
            assert "Reds" in card_auto["texto"], auto
            assert "Ocorrências" in card_auto["texto"], auto
            assert card_auto["ocorrencias"] == "4", auto
            assert "vitórias em" not in card_auto["texto"], auto

        page.evaluate(
            """
            () => {
                document.getElementById('bk-entrada').value = 'PLAYER_TIE';
                window.rodarBacktestManual();
            }
            """
        )
        page.wait_for_function(
            """
            () => document.getElementById('bk-resultados-box')?.style.display === 'block'
                && document.getElementById('bk-resultados-auto')?.style.display === 'none'
            """,
            timeout=5000,
        )

        page.evaluate(
            """
            () => window.__socketHandlers.alerta_painel({
                tipo: 'ENTRADA',
                nome: 'Padrao Teste',
                entrada: 'Player',
                assertividade: 87.5,
                padrao: ['Player', 'Banker'],
                robosNotificados: [{ id: 7, tag_visual: '[TESTE]', cor_hex: '#17a2b8' }]
            })
            """
        )

        page.wait_for_function(
            "document.getElementById('container-card-ativo').style.display === 'block'",
            timeout=5000,
        )
        card = page.evaluate(
            """
            () => ({
                display: document.getElementById('container-card-ativo').style.display,
                conteudo: document.getElementById('conteudo-card-ativo').innerText,
                titulo: document.getElementById('banner-titulo').innerText,
                acao: document.getElementById('banner-acao').innerText
            })
            """
        )
        assert card["display"] == "block", card
        assert "Padrao Teste" in card["conteudo"], card
        assert "SINAL: PADRAO TESTE" in card["titulo"], card
        assert "PLAYER" in card["acao"], card

        assert not page_errors, f"Erros JavaScript na pagina: {page_errors}"
        browser.close()

    print("UX-006A Backtest ranges, dashboard filter and Auto-Trader icon browser smoke: PASS")


if __name__ == "__main__":
    main()
