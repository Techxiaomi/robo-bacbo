from pathlib import Path
import json

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"


def detalhes_periodo(green=1, gale1=1, gale2=0, red=1, tie=1, max_green=3, max_red=1):
    return {
        "green_direto": green,
        "gale1": gale1,
        "gale2": gale2,
        "red": red,
        "ties": {"direto": {"4x": tie} if tie else {}, "gale1": {}, "gale2": {}},
        "max_green_seq": max_green,
        "max_red_seq": max_red,
    }


def detalhes_todos(periodo):
    return {
        "24h": periodo,
        "hoje": periodo,
        "semana": periodo,
        "mes": periodo,
        "geral": periodo,
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

    estrategia_manual = {
        "id": "est-1",
        "nome": "Padrao Teste",
        "origem": "Origem A",
        "padrao": '["Player","Banker"]',
        "entrada": "Player",
        "gales": 0,
        "proteger_empate": True,
        "ativo": True,
        "is_dinamico": "0",
        "robo_dono_id": None,
        "detalhes": detalhes_todos(detalhes_periodo()),
    }
    estrategia_dinamica = {
        "id": "ia-7",
        "nome": "Padrao Dinamico",
        "origem": "AUTO_PILOT_IA:7",
        "padrao": '["Banker","Player"]',
        "entrada": "Banker",
        "gales": 0,
        "proteger_empate": False,
        "ativo": True,
        "is_dinamico": "1",
        "robo_dono_id": 7,
        "detalhes": detalhes_todos(detalhes_periodo()),
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
        "detalhes": detalhes_todos(detalhes_periodo()),
    }
    robo_alpha = {
        **robo,
        "id": 8,
        "nome": "Alpha",
        "tag_visual": "[ALPHA]",
        "ativo": False,
        "detalhes": detalhes_todos(detalhes_periodo(green=4, gale1=0, red=0, tie=0, max_green=4, max_red=0)),
    }
    robo_charlie = {
        **robo,
        "id": 9,
        "nome": "Charlie",
        "tag_visual": "[CHARLIE]",
        "ativo": True,
        "detalhes": detalhes_todos(detalhes_periodo(green=1, gale1=0, red=4, tie=0, max_green=1, max_red=4)),
    }
    robos_ordenacao = [robo, robo_alpha, robo_charlie]

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
                responder_json(route, [estrategia_manual, estrategia_dinamica])
                return
            if path == "http://bacbo.test/api/origens":
                responder_json(route, [{"id": 1, "nome": "Origem A"}, {"id": 2, "nome": "Auto Pilot 01"}])
                return
            if path == "http://bacbo.test/api/robos":
                # Mantém o fixture histórico dos seletores; os robôs adicionais são
                # injetados depois somente para provar a ordenação dos cards.
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
                && document.querySelectorAll('#select-origem-dash option').length === 3
                && document.querySelectorAll('#select-robo-dash option').length === 2
                && document.querySelectorAll('#select-origem-filtro option').length === 3
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
                    && texto.includes('🔥 3')
                    && document.querySelectorAll('#select-ordem-robos option').length === 8;
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
                valoresOrigemPadroes: Array.from(document.querySelectorAll('#select-origem-filtro option')).map(o => o.value),
                sinais: document.getElementById('dash-sinais').innerText,
                greens: document.getElementById('dash-greens').innerText,
                reds: document.getElementById('dash-reds').innerText,
                ties: document.getElementById('dash-ties').innerText,
                maxGreen: document.getElementById('dash-max-green').innerText,
                maxRed: document.getElementById('dash-max-red').innerText,
                assertividade: document.getElementById('dash-assertividade').innerText,
                dashboardOrdem: Array.from(document.querySelectorAll('#dashboard-resumo-grid > .dash-box')).map(card => card.querySelector('span')?.textContent.trim()),
                cardRobo: document.getElementById('lista-robos').innerText,
                ordemRobos: Array.from(document.querySelectorAll('#select-ordem-robos option')).map(o => ({ value:o.value, label:o.textContent.trim() })),
                ordemRobosSelecionada: document.getElementById('select-ordem-robos').value,
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
        assert any("Origem A" in item for item in opcoes["origemPadroes"]), opcoes
        assert any("Auto - IA — Robo Teste" in item for item in opcoes["origemPadroes"]), opcoes
        assert not any("Auto Pilot 01" in item for item in opcoes["origemPadroes"]), opcoes
        assert "MANUAL:Origem%20A" in opcoes["valoresOrigemPadroes"], opcoes
        assert "IA:7" in opcoes["valoresOrigemPadroes"], opcoes
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
        assert [item["value"] for item in opcoes["ordemRobos"]] == [
            "status", "nome", "assert", "entradas", "max_green", "max_red", "recentes", "antigos"
        ], opcoes
        assert opcoes["ordemRobosSelecionada"] == "status", opcoes
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

        page.select_option("#select-origem-filtro", "TODAS")
        page.select_option("#select-tipo-filtro", "MANUAIS")
        manuais = page.locator("#lista-padroes .card")
        assert manuais.count() == 1, manuais.all_inner_texts()
        assert "Padrao Teste" in manuais.first.inner_text()
        assert "Padrao Dinamico" not in manuais.first.inner_text()

        page.select_option("#select-tipo-filtro", "DINAMICOS")
        dinamicos = page.locator("#lista-padroes .card")
        assert dinamicos.count() == 1, dinamicos.all_inner_texts()
        assert "Padrao Dinamico" in dinamicos.first.inner_text()
        assert "Padrao Teste" not in dinamicos.first.inner_text()

        page.select_option("#select-tipo-filtro", "TODOS")
        page.select_option("#select-origem-filtro", "IA:7")
        fonte_ia = page.locator("#lista-padroes .card")
        assert fonte_ia.count() == 1, fonte_ia.all_inner_texts()
        assert "Padrao Dinamico" in fonte_ia.first.inner_text()

        page.select_option("#select-origem-filtro", "MANUAL:Origem%20A")
        fonte_manual = page.locator("#lista-padroes .card")
        assert fonte_manual.count() == 1, fonte_manual.all_inner_texts()
        assert "Padrao Teste" in fonte_manual.first.inner_text()

        # BUG-019: o formulário do Auto-Trader expõe política de Tie por percentual
        # ou valor e mostra os valores efetivos após arredondamento e Gales.
        tie_ui = page.evaluate(
            """
            () => {
                const modo = document.getElementById('at-tie-modo');
                const pct = document.getElementById('at-tie-percent');
                const valor = document.getElementById('at-tie-valor');
                const stake = document.getElementById('at-stake');
                const g1 = document.getElementById('at-gale1');
                const g2 = document.getElementById('at-gale2');
                if (!modo || !pct || !valor || !stake || !g1 || !g2) return null;

                stake.value = '100';
                g1.value = '2';
                g2.value = '4';
                modo.value = 'PERCENTUAL';
                pct.value = '5';
                window.toggleProtecaoEmpateAutoTrader();
                const percentual = document.getElementById('at-tie-preview').innerText;

                modo.value = 'VALOR';
                valor.value = '10';
                window.toggleProtecaoEmpateAutoTrader();
                const fixo = document.getElementById('at-tie-preview').innerText;

                modo.value = 'PERCENTUAL';
                pct.value = '5';
                window.toggleProtecaoEmpateAutoTrader();
                window.addFicha(5);
                const aposFicha = document.getElementById('at-tie-preview').innerText;

                return {
                    modos: Array.from(modo.options).map(o => o.value),
                    percentual,
                    fixo,
                    aposFicha,
                    boxPercentDisplay: document.getElementById('box-at-tie-percent').style.display,
                    boxValorDisplay: document.getElementById('box-at-tie-valor').style.display
                };
            }
            """
        )
        assert tie_ui is not None, tie_ui
        assert tie_ui["modos"] == ["PERCENTUAL", "VALOR"], tie_ui
        assert "Cor R$ 100 + Tie R$ 5" in tie_ui["percentual"], tie_ui
        assert "Cor R$ 200 + Tie R$ 10" in tie_ui["percentual"], tie_ui
        assert "Cor R$ 400 + Tie R$ 20" in tie_ui["percentual"], tie_ui
        assert "Cor R$ 100 + Tie R$ 10" in tie_ui["fixo"], tie_ui
        assert "Cor R$ 200 + Tie R$ 20" in tie_ui["fixo"], tie_ui
        assert "Cor R$ 400 + Tie R$ 40" in tie_ui["fixo"], tie_ui
        assert "Cor R$ 105 + Tie R$ 5" in tie_ui["aposFicha"], tie_ui
        assert tie_ui["boxPercentDisplay"] == "flex", tie_ui
        assert tie_ui["boxValorDisplay"] == "none", tie_ui

        # Isola a prova de ordenação dos cards da regra dos seletores globais.
        page.evaluate(
            """robos => {
                robosGlobais = robos;
                window.renderizarCardsRobos();
            }""",
            robos_ordenacao,
        )
        page.wait_for_function("() => document.querySelectorAll('#lista-robos > .card').length === 3", timeout=5000)

        def ordem_cards():
            return page.evaluate(
                "() => Array.from(document.querySelectorAll('#lista-robos > .card')).map(card => card.dataset.roboNome)"
            )

        assert ordem_cards() == ["Charlie", "Robo Teste", "Alpha"]

        def mudar_ordem(criterio, esperado):
            page.evaluate(
                """criterio => {
                    const select = document.getElementById('select-ordem-robos');
                    select.value = criterio;
                    select.dispatchEvent(new Event('change'));
                }""",
                criterio,
            )
            atual = ordem_cards()
            assert atual == esperado, {"criterio": criterio, "ordem": atual}

        mudar_ordem("nome", ["Alpha", "Charlie", "Robo Teste"])
        mudar_ordem("assert", ["Alpha", "Robo Teste", "Charlie"])
        mudar_ordem("entradas", ["Charlie", "Alpha", "Robo Teste"])
        mudar_ordem("max_green", ["Alpha", "Robo Teste", "Charlie"])
        mudar_ordem("max_red", ["Charlie", "Robo Teste", "Alpha"])
        mudar_ordem("recentes", ["Charlie", "Alpha", "Robo Teste"])
        mudar_ordem("antigos", ["Robo Teste", "Alpha", "Charlie"])
        mudar_ordem("status", ["Charlie", "Robo Teste", "Alpha"])

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

    print("UX-006B robot card ordering + prior dashboard/backtest smoke: PASS")


if __name__ == "__main__":
    main()
