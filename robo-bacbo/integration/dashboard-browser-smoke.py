from pathlib import Path
import json

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"


def detalhes_periodo():
    return {
        "green_direto": 1,
        "gale1": 0,
        "gale2": 0,
        "red": 0,
        "ties": {"direto": {}, "gale1": {}, "gale2": {}},
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
        "config": {},
        "destinatarios": [],
        "qtd_padroes_ia": 0,
        "detalhes": {},
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
                    "sinais": 4,
                    "greens": 3,
                    "reds": 1,
                    "assertividade": "75.0%",
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
            () => document.getElementById('dash-sinais')?.innerText === '4'
                && document.getElementById('dash-greens')?.innerText === '3'
                && document.getElementById('dash-reds')?.innerText === '1'
                && document.getElementById('dash-assertividade')?.innerText === '75.0%'
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
                assertividade: document.getElementById('dash-assertividade').innerText,
                socketRegistrado: typeof window.__socketHandlers.alerta_painel === 'function'
            })
            """
        )

        assert "Robo Teste" in opcoes["sintonia"], opcoes
        assert "Origem A" in opcoes["origemDash"], opcoes
        assert "Robo Teste" in opcoes["roboDash"], opcoes
        assert "Origem A" in opcoes["origemPadroes"], opcoes
        assert opcoes["sinais"] == "4", opcoes
        assert opcoes["greens"] == "3", opcoes
        assert opcoes["reds"] == "1", opcoes
        assert opcoes["assertividade"] == "75.0%", opcoes
        assert opcoes["socketRegistrado"] is True, opcoes

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

    print("BUG-017 dashboard browser smoke: PASS")


if __name__ == "__main__":
    main()
