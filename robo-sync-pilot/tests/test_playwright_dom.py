import ast
import contextlib
import http.server
import re
import threading
import time
import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError


ROOT = Path(__file__).resolve().parents[1]
ROBO_PATH = ROOT / "robo.py"


def carregar_funcoes_reais():
    fonte = ROBO_PATH.read_text(encoding="utf-8")
    arvore = ast.parse(fonte, filename=str(ROBO_PATH))
    nomes = {
        "normalizar_apostas_recebidas",
        "parsear_valor_monetario",
        "ler_saldo_atual",
        "extrair_trilhas_roadmap_dom",
        "identidade_rodada_evolution",
        "atualizar_estado_mesa_player",
        "stage_evolution_apostavel",
        "avaliar_contexto_janela_aposta",
        "primeiro_elemento_apostavel",
        "elemento_apostavel",
        "localizar_ficha_apostavel",
        "inspecionar_frame_apostavel",
        "localizar_contexto_apostavel",
        "localizar_frame_apostavel",
        "clicar_superficie_ficha_playwright",
        "selecionar_ficha_com_confirmacao",
        "formatar_diagnostico_janela",
        "aguardar_janela_aposta",
        "confirmar_aceite_financeiro_aposta",
        "executar_aposta_na_tela",
    }
    corpo = [
        no for no in arvore.body
        if isinstance(no, (ast.FunctionDef, ast.AsyncFunctionDef)) and no.name in nomes
    ]
    encontrados = {no.name for no in corpo}
    faltantes = nomes - encontrados
    if faltantes:
        raise RuntimeError(f"Funcoes nao encontradas em robo.py: {sorted(faltantes)}")

    modulo = ast.Module(body=corpo, type_ignores=[])
    ast.fix_missing_locations(modulo)
    executor_pronto = threading.Event()
    executor_pronto.set()
    namespace = {
        "re": re,
        "time": time,
        "PlaywrightTimeoutError": PlaywrightTimeoutError,
        "CASINO_BALANCE_SELECTOR": ".saldo-teste",
        "EXECUTOR_BETTING_WINDOW_TIMEOUT_SECONDS": 1.5,
        "EXECUTOR_BET_ACCEPTANCE_TIMEOUT_SECONDS": 0.35,
        "EXECUTOR_BET_ACCEPTANCE_TOLERANCE": 0.10,
        "COLLECTOR_PLAYER_STATE_STALE_SECONDS": 20.0,
        "executor_pronto": executor_pronto,
        "estado_mesa_lock": threading.Lock(),
        "estado_mesa": {
            "stage": "Resolved",
            "atualizado_em_ms": 0,
            "round_id": "",
            "round_resolvido": False,
        },
        "coletor_seq": 0,
    }
    exec(compile(modulo, str(ROBO_PATH), "exec"), namespace)
    return namespace


FUNCOES = carregar_funcoes_reais()
parsear_valor_monetario = FUNCOES["parsear_valor_monetario"]
ler_saldo_atual = FUNCOES["ler_saldo_atual"]
executar_aposta_na_tela = FUNCOES["executar_aposta_na_tela"]
extrair_trilhas_roadmap_dom = FUNCOES["extrair_trilhas_roadmap_dom"]
confirmar_aceite_financeiro_aposta = FUNCOES["confirmar_aceite_financeiro_aposta"]
ler_saldo_atual_real = FUNCOES["ler_saldo_atual"]
confirmar_aceite_financeiro_aposta_real = FUNCOES["confirmar_aceite_financeiro_aposta"]


HTML = {
    "/balance-main.html": """<!doctype html>
<html><body>
  <div class="saldo-teste">Saldo disponível: R$ 1.234,56</div>
</body></html>""",
    "/balance-frame.html": """<!doctype html>
<html><body>
  <div>saldo fora do frame ausente</div>
  <iframe src="/balance-inner.html"></iframe>
</body></html>""",
    "/balance-inner.html": """<!doctype html>
<html><body>
  <span class="saldo-teste">US$ 9,876.54</span>
</body></html>""",
    "/roadmap.html": """<!doctype html>
<html><body><iframe src="/roadmap-frame.html"></iframe></body></html>""",
    "/roadmap-frame.html": """<!doctype html>
<html><body>
  <div class="bead-road" aria-label="Histórico de resultados">
    <span class="bead player"></span><span class="bead banker"></span>
    <span class="bead tie"></span><span class="bead banker"></span>
    <span class="bead player"></span><span class="bead banker"></span>
  </div>
</body></html>""",
    "/game.html": """<!doctype html>
<html><body>
  <iframe src="/game-frame.html"></iframe>
</body></html>""",
    "/game-frame.html": """<!doctype html>
<html><body>
<script>
  window.__chipClicks = {"25a": 0, "25b": 0, "10": 0, "5": 0};
  window.__targetClicks = {"playerA": 0, "playerB": 0, "banker": 0, "tie": 0};
</script>
  <div data-role="chip" data-value="25" data-id="25a" onclick="window.__chipClicks['25a']++">25-A</div>
  <div data-role="chip" data-value="25" data-id="25b" onclick="window.__chipClicks['25b']++">25-B</div>
  <div data-role="chip" data-value="10" data-id="10" onclick="window.__chipClicks['10']++">10</div>
  <div data-role="chip" data-value="5" data-id="5" onclick="window.__chipClicks['5']++">5</div>
  <button data-role="bacbo-bet-spot-Player" data-id="playerA" onclick="window.__targetClicks['playerA']++">Player A</button>
  <button data-role="bacbo-bet-spot-Player" data-id="playerB" onclick="window.__targetClicks['playerB']++">Player B</button>
  <button data-role="bacbo-bet-spot-Banker" onclick="window.__targetClicks['banker']++">Banker</button>
  <button data-role="bacbo-bet-spot-Tie" onclick="window.__targetClicks['tie']++">Tie</button>
</body></html>""",
}

HTML["/game-partial.html"] = """<!doctype html>
<html><body><iframe src="/game-partial-frame.html"></iframe></body></html>"""
HTML["/game-partial-frame.html"] = """<!doctype html>
<html><body>
<script>window.__targetClicks = 0;</script>
<div data-role="chip" data-value="10">10</div>
<button data-role="bacbo-bet-spot-Player"
  onclick="window.__targetClicks++; this.remove()">Player descartável</button>
</body></html>"""

HTML["/game-delayed.html"] = """<!doctype html>
<html><body><iframe src="/game-delayed-frame.html"></iframe></body></html>"""
HTML["/game-delayed-frame.html"] = """<!doctype html>
<html><body>
<script>
  window.__chipClicks = 0;
  window.__targetClicks = 0;
  window.__openedAt = 0;
  window.__firstClickAt = 0;
  setTimeout(() => { document.getElementById('chip10').style.display = 'block'; }, 300);
  setTimeout(() => {
    window.__openedAt = performance.now();
    document.getElementById('player').style.display = 'block';
  }, 850);
  function markClick(kind) {
    if (!window.__firstClickAt) window.__firstClickAt = performance.now();
    if (kind === 'chip') window.__chipClicks++;
    else window.__targetClicks++;
  }
</script>
<div id="chip10" style="display:none" data-role="chip" data-value="10" onclick="markClick('chip')">10</div>
<button id="player" style="display:none" data-role="bacbo-bet-spot-Player" onclick="markClick('target')">Player</button>
</body></html>"""

HTML["/game-closed.html"] = """<!doctype html>
<html><body><iframe src="/game-closed-frame.html"></iframe></body></html>"""
HTML["/game-closed-frame.html"] = """<!doctype html>
<html><body>
<script>window.__chipClicks = 0; window.__targetClicks = 0;</script>
<div style="display:none" data-role="chip" data-value="10" onclick="window.__chipClicks++">10</div>
<button style="display:none" data-role="bacbo-bet-spot-Player" onclick="window.__targetClicks++">Player</button>
</body></html>"""

HTML["/game-selected.html"] = """<!doctype html>
<html><body><iframe src="/game-selected-frame.html"></iframe></body></html>"""
HTML["/game-selected-frame.html"] = """<!doctype html>
<html><body>
<script>window.__chipClicks = 0; window.__targetClicks = 0;</script>
<button disabled aria-pressed="true" data-role="chip" data-value="25"
  onclick="window.__chipClicks++">25 selecionada</button>
<button data-role="bacbo-bet-spot-Banker"
  onclick="window.__targetClicks++">Banker</button>
</body></html>"""

HTML["/game-chip-animating.html"] = """<!doctype html>
<html><body><iframe src="/game-chip-animating-frame.html"></iframe></body></html>"""
HTML["/game-chip-animating-frame.html"] = """<!doctype html>
<html><head><style>
@keyframes mover { from { transform: translateX(0); } to { transform: translateX(20px); } }
#chip5 { animation: mover 0.8s linear; }
</style></head><body>
<script>window.__chipClicks = 0; window.__targetClicks = 0;</script>
<button id="chip5" data-role="chip" data-value="5"
  onclick="window.__chipClicks++">5</button>
<button data-role="bacbo-bet-spot-Banker"
  onclick="window.__targetClicks++">Banker</button>
</body></html>"""

HTML["/game-chip-overlay.html"] = """<!doctype html>
<html><body><iframe src="/game-chip-overlay-frame.html"></iframe></body></html>"""
HTML["/game-chip-overlay-frame.html"] = """<!doctype html>
<html><head><style>
#wrap { position: relative; width: 100px; height: 40px; }
#chip5, #surface { position: absolute; inset: 0; }
#surface { z-index: 2; }
</style></head><body>
<script>window.__surfaceClicks = 0; window.__surfacePointerDown = 0; window.__targetClicks = 0;</script>
<div id="wrap">
  <div id="chip5" data-role="chip" data-value="5">5</div>
  <div id="surface" onpointerdown="window.__surfacePointerDown++" onclick="
    window.__surfaceClicks++;
    document.getElementById('chip5').classList.add('selected');
  ">superfície</div>
</div>
<button data-role="bacbo-bet-spot-Player"
  onclick="window.__targetClicks++">Player</button>
</body></html>"""

HTML["/game-chip-roundtrip.html"] = """<!doctype html>
<html><body><iframe src="/game-chip-roundtrip-frame.html"></iframe></body></html>"""
HTML["/game-chip-roundtrip-frame.html"] = """<!doctype html>
<html><head><style>
.wrap { position: relative; width: 100px; height: 40px; margin-bottom: 5px; }
.chip, .surface { position: absolute; inset: 0; }
.surface { z-index: 2; }
</style></head><body>
<script>
window.__surfaceClicks = 0; window.__targetClicks = 0; window.__selectedValue = 5;
function escolher(valor) {
  window.__surfaceClicks++;
  window.__selectedValue = valor;
  document.getElementById('chip5').className = valor === 5 ? 'chip' : 'chip nao-atual';
}
</script>
<div class="wrap"><div id="chip5" class="chip" data-role="chip" data-value="5">5</div>
  <div class="surface" onclick="escolher(5)">superfície 5</div></div>
<div class="wrap"><div class="chip" data-role="chip" data-value="10">10</div>
  <div class="surface" onclick="escolher(10)">superfície 10</div></div>
<button data-role="bacbo-bet-spot-Player" onclick="window.__targetClicks++">Player</button>
</body></html>"""

HTML["/opaque-hidden.html"] = """<!doctype html>
<html><body><iframe src="/table-shell.html"></iframe></body></html>"""
HTML["/table-shell.html"] = """<!doctype html>
<html><body>
<script>
  window.__chipClicks = {hidden: 0, visible: 0};
  window.__targetClicks = {hidden: 0, visible: 0};
</script>
<div style="display:none" data-role="chip" data-value="10.0"
  onclick="window.__chipClicks.hidden++">10 oculto</div>
<button style="display:none" data-role="bacbo-bet-spot-Player"
  onclick="window.__targetClicks.hidden++">Player oculto</button>
<div data-role="chip" data-value="10,00"
  onclick="window.__chipClicks.visible++">10 visível</div>
<button data-role="bacbo-bet-spot-Player"
  onclick="window.__targetClicks.visible++">Player visível</button>
</body></html>"""

HTML["/game-balance-accepted.html"] = """<!doctype html>
<html><body>
<div class="saldo-teste">R$ 1.000,00</div>
<iframe src="/game-balance-accepted-frame.html"></iframe>
</body></html>"""
HTML["/game-balance-accepted-frame.html"] = """<!doctype html>
<html><body>
<div data-role="chip" data-value="5">5</div>
<button data-role="bacbo-bet-spot-Player" onclick="
  window.top.document.querySelector('.saldo-teste').textContent='R$ 995,00';
">Player</button>
</body></html>"""

HTML["/game-balance-unchanged.html"] = """<!doctype html>
<html><body>
<div class="saldo-teste">R$ 1.000,00</div>
<iframe src="/game-frame.html"></iframe>
</body></html>"""


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        corpo = HTML.get(self.path)
        if corpo is None:
            self.send_response(404)
            self.end_headers()
            return
        dados = corpo.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(dados)))
        self.end_headers()
        self.wfile.write(dados)

    def log_message(self, format, *args):
        return


class PlaywrightDomIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.servidor = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.porta = cls.servidor.server_address[1]
        cls.thread_servidor = threading.Thread(target=cls.servidor.serve_forever, daemon=True)
        cls.thread_servidor.start()

        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        with contextlib.suppress(Exception):
            cls.browser.close()
        with contextlib.suppress(Exception):
            cls.playwright.stop()
        with contextlib.suppress(Exception):
            cls.servidor.shutdown()
        with contextlib.suppress(Exception):
            cls.servidor.server_close()

    def nova_pagina(self, caminho):
        pagina = self.browser.new_page()
        pagina.goto(f"http://127.0.0.1:{self.porta}{caminho}", wait_until="load")
        return pagina

    def setUp(self):
        FUNCOES["ler_saldo_atual"] = lambda _page: 1000.0
        FUNCOES["confirmar_aceite_financeiro_aposta"] = lambda _page, saldo, exposicao: {
            "confirmada": True,
            "metodo": "SALDO_DEBITADO",
            "saldo_antes": float(saldo),
            "saldo_depois": float(saldo) - float(exposicao),
            "exposicao_esperada": float(exposicao),
            "debito_observado": float(exposicao),
            "confirmada_em": int(time.time() * 1000),
        }

    def tearDown(self):
        FUNCOES["ler_saldo_atual"] = ler_saldo_atual_real
        FUNCOES["confirmar_aceite_financeiro_aposta"] = confirmar_aceite_financeiro_aposta_real

    def frame_jogo(self, pagina):
        pagina.locator("iframe").wait_for(state="attached")
        for frame in pagina.frames:
            if "game" in frame.url and "frame" in frame.url:
                frame.locator("div[data-role='chip']").first.wait_for(state="visible")
                return frame
        self.fail("Frame controlado de jogo nao encontrado")

    def test_parse_monetario_real_continua_compativel(self):
        self.assertEqual(parsear_valor_monetario("R$ 1.234,56"), 1234.56)
        self.assertEqual(parsear_valor_monetario("US$ 9,876.54"), 9876.54)
        self.assertIsNone(parsear_valor_monetario("sem saldo"))

    def test_ler_saldo_no_dom_principal(self):
        pagina = self.nova_pagina("/balance-main.html")
        try:
            self.assertEqual(ler_saldo_atual(pagina), 1234.56)
        finally:
            pagina.close()

    def test_ler_saldo_dentro_de_iframe(self):
        pagina = self.nova_pagina("/balance-frame.html")
        try:
            pagina.locator("iframe").wait_for(state="attached")
            self.assertEqual(ler_saldo_atual(pagina), 9876.54)
        finally:
            pagina.close()

    def test_bug037_aceite_so_e_executada_apos_debito_exato_do_saldo(self):
        pagina = self.nova_pagina("/game-balance-accepted.html")
        FUNCOES["ler_saldo_atual"] = ler_saldo_atual_real
        FUNCOES["confirmar_aceite_financeiro_aposta"] = confirmar_aceite_financeiro_aposta_real
        try:
            resultado = executar_aposta_na_tela(pagina, {"alvo": "PlayerWon", "valor": 5})
            self.assertEqual(resultado["status"], "EXECUTADA")
            self.assertEqual(resultado["confirmacao"]["metodo"], "SALDO_DEBITADO")
            self.assertEqual(resultado["confirmacao"]["debito_observado"], 5.0)
        finally:
            pagina.close()

    def test_bug037_cliques_com_saldo_inalterado_ficam_ambiguos(self):
        pagina = self.nova_pagina("/game-balance-unchanged.html")
        FUNCOES["ler_saldo_atual"] = ler_saldo_atual_real
        FUNCOES["confirmar_aceite_financeiro_aposta"] = confirmar_aceite_financeiro_aposta_real
        try:
            resultado = executar_aposta_na_tela(pagina, {"alvo": "PlayerWon", "valor": 5})
            self.assertEqual(resultado["status"], "AMBIGUA")
            self.assertEqual(resultado["cliques_alvo"], 1)
            self.assertIn("permaneceu inalterado", resultado["motivo"])
        finally:
            pagina.close()

    def test_bug037_sem_saldo_legivel_bloqueia_antes_do_alvo(self):
        pagina = self.nova_pagina("/game.html")
        FUNCOES["ler_saldo_atual"] = ler_saldo_atual_real
        FUNCOES["confirmar_aceite_financeiro_aposta"] = confirmar_aceite_financeiro_aposta_real
        try:
            frame = self.frame_jogo(pagina)
            resultado = executar_aposta_na_tela(pagina, {"alvo": "PlayerWon", "valor": 5})
            self.assertEqual(resultado["status"], "FALHOU")
            self.assertEqual(resultado["cliques_alvo"], 0)
            self.assertEqual(frame.evaluate("window.__targetClicks.playerA"), 0)
        finally:
            pagina.close()

    def test_extrai_trilha_semantica_da_roadmap_no_iframe(self):
        pagina = self.nova_pagina("/roadmap.html")
        try:
            pagina.locator("iframe").wait_for(state="attached")
            extraido = extrair_trilhas_roadmap_dom(pagina)
            self.assertGreaterEqual(extraido["diagnostico"]["trilhas"], 1)
            self.assertIn(["P", "B", "T", "B", "P", "B"], extraido["trilhas"])
        finally:
            pagina.close()

    def test_aposta_controlada_decompoe_35_em_25_mais_10_e_usa_first(self):
        pagina = self.nova_pagina("/game.html")
        try:
            frame = self.frame_jogo(pagina)
            resultado = executar_aposta_na_tela(pagina, {"alvo": "PlayerWon", "valor": 35})

            self.assertEqual(resultado["status"], "EXECUTADA")
            self.assertEqual(resultado["cliques_alvo"], 2)
            chips = frame.evaluate("window.__chipClicks")
            alvos = frame.evaluate("window.__targetClicks")
            self.assertEqual(chips, {"25a": 1, "25b": 0, "10": 1, "5": 0})
            self.assertEqual(alvos["playerA"], 2)
            self.assertEqual(alvos["playerB"], 0)
            self.assertEqual(alvos["banker"], 0)
            self.assertEqual(alvos["tie"], 0)
        finally:
            pagina.close()

    def test_aposta_controlada_abaixo_da_ficha_minima_nao_clica(self):
        pagina = self.nova_pagina("/game.html")
        try:
            frame = self.frame_jogo(pagina)
            resultado = executar_aposta_na_tela(pagina, {"alvo": "PlayerWon", "valor": 4})

            self.assertEqual(resultado["status"], "FALHOU")
            self.assertEqual(resultado["cliques_alvo"], 0)
            chips = frame.evaluate("window.__chipClicks")
            alvos = frame.evaluate("window.__targetClicks")
            self.assertTrue(all(valor == 0 for valor in chips.values()))
            self.assertTrue(all(valor == 0 for valor in alvos.values()))
        finally:
            pagina.close()

    def test_falha_apos_primeiro_clique_de_alvo_e_ambigua(self):
        pagina = self.nova_pagina("/game-partial.html")
        try:
            frame = self.frame_jogo(pagina)
            resultado = executar_aposta_na_tela(pagina, {"alvo": "PlayerWon", "valor": 20})

            self.assertEqual(resultado["status"], "AMBIGUA")
            self.assertEqual(resultado["cliques_alvo"], 1)
            self.assertEqual(frame.evaluate("window.__targetClicks"), 1)
        finally:
            pagina.close()

    def test_bug028_frame_opaco_usa_elementos_acionaveis_em_vez_do_primeiro(self):
        pagina = self.nova_pagina("/opaque-hidden.html")
        try:
            pagina.locator("iframe").wait_for(state="attached")
            frame = next(f for f in pagina.frames if "table-shell" in f.url)
            resultado = executar_aposta_na_tela(pagina, {"alvo": "PlayerWon", "valor": 10})

            self.assertEqual(resultado["status"], "EXECUTADA")
            self.assertEqual(frame.evaluate("window.__chipClicks"), {"hidden": 0, "visible": 1})
            self.assertEqual(frame.evaluate("window.__targetClicks"), {"hidden": 0, "visible": 1})
        finally:
            pagina.close()

    def configurar_janela(self, seq, stage="Resolved", timeout=1.5):
        FUNCOES["coletor_seq"] = seq
        FUNCOES["EXECUTOR_BETTING_WINDOW_TIMEOUT_SECONDS"] = timeout
        FUNCOES["executor_pronto"].set()
        with FUNCOES["estado_mesa_lock"]:
            FUNCOES["estado_mesa"]["stage"] = stage
            FUNCOES["estado_mesa"]["atualizado_em_ms"] = int(time.time() * 1000)

    @staticmethod
    def ordem_sincronizada(seq, valor=10):
        return {
            "order_id": "123e4567-e89b-42d3-a456-426614174000",
            "alvo": "PlayerWon",
            "valor": valor,
            "sincronizar_janela": True,
            "coletor_seq_aceite": seq,
            "stage_aceite": "Resolved",
        }

    def test_bug018_aguarda_stage_e_dom_acionavel_antes_do_primeiro_clique(self):
        pagina = self.nova_pagina("/game-delayed.html")
        self.configurar_janela(10, "Resolved", timeout=2.0)
        timer = threading.Timer(0.35, lambda: FUNCOES["atualizar_estado_mesa_player"]({
            "args": {"game": {"stage": "AcceptingBets"}}
        }))
        timer.start()
        try:
            resultado = executar_aposta_na_tela(pagina, self.ordem_sincronizada(10))
            frame = next(f for f in pagina.frames if "game-delayed-frame" in f.url)
            tempos = frame.evaluate("({opened: window.__openedAt, clicked: window.__firstClickAt, chip: window.__chipClicks, target: window.__targetClicks})")

            self.assertEqual(resultado["status"], "EXECUTADA")
            self.assertEqual(tempos["chip"], 1)
            self.assertEqual(tempos["target"], 1)
            self.assertGreater(tempos["opened"], 0)
            self.assertGreaterEqual(tempos["clicked"], tempos["opened"] - 5)
        finally:
            timer.cancel()
            pagina.close()

    def test_bug018_janela_que_nunca_abre_expira_sem_cliques(self):
        pagina = self.nova_pagina("/game-closed.html")
        self.configurar_janela(20, "Betting", timeout=0.45)
        try:
            resultado = executar_aposta_na_tela(pagina, self.ordem_sincronizada(20))
            frame = next(f for f in pagina.frames if "game-closed-frame" in f.url)
            self.assertEqual(resultado["status"], "EXPIRADA")
            self.assertEqual(resultado["cliques_alvo"], 0)
            self.assertIn("stage=Betting", resultado["motivo"])
            self.assertIn("fichas_prontas=0/1", resultado["motivo"])
            self.assertIn("alvos=0/1", resultado["motivo"])
            self.assertEqual(frame.evaluate("window.__chipClicks"), 0)
            self.assertEqual(frame.evaluate("window.__targetClicks"), 0)
        finally:
            pagina.close()

    def test_bug030_ficha_explicitamente_selecionada_nao_exige_novo_clique(self):
        pagina = self.nova_pagina("/game-selected.html")
        self.configurar_janela(22, "AcceptingBets", timeout=1.0)
        try:
            resultado = executar_aposta_na_tela(
                pagina,
                {
                    "order_id": "123e4567-e89b-42d3-a456-426614174001",
                    "alvo": "BankerWon",
                    "valor": 25,
                    "sincronizar_janela": True,
                    "coletor_seq_aceite": 22,
                    "stage_aceite": "Resolved",
                },
            )
            frame = next(f for f in pagina.frames if "game-selected-frame" in f.url)
            self.assertEqual(resultado["status"], "EXECUTADA")
            self.assertEqual(frame.evaluate("window.__chipClicks"), 0)
            self.assertEqual(frame.evaluate("window.__targetClicks"), 1)
        finally:
            pagina.close()

    def test_bug031_ficha_visivel_pode_aguardar_estabilidade_sem_exposicao(self):
        pagina = self.nova_pagina("/game-chip-animating.html")
        self.configurar_janela(23, "AcceptingBets", timeout=2.0)
        try:
            resultado = executar_aposta_na_tela(
                pagina,
                {
                    "order_id": "123e4567-e89b-42d3-a456-426614174002",
                    "alvo": "BankerWon",
                    "valor": 5,
                    "sincronizar_janela": True,
                    "coletor_seq_aceite": 23,
                    "stage_aceite": "Resolved",
                },
            )
            frame = next(f for f in pagina.frames if "game-chip-animating-frame" in f.url)
            self.assertEqual(resultado["status"], "EXECUTADA")
            self.assertEqual(frame.evaluate("window.__chipClicks"), 1)
            self.assertEqual(frame.evaluate("window.__targetClicks"), 1)
        finally:
            pagina.close()

    def test_bug032_superficie_interceptora_confirma_ficha_antes_do_alvo(self):
        pagina = self.nova_pagina("/game-chip-overlay.html")
        self.configurar_janela(24, "AcceptingBets", timeout=3.0)
        try:
            resultado = executar_aposta_na_tela(
                pagina,
                {
                    "order_id": "123e4567-e89b-42d3-a456-426614174003",
                    "alvo": "PlayerWon",
                    "valor": 5,
                    "sincronizar_janela": True,
                    "coletor_seq_aceite": 24,
                    "stage_aceite": "Resolved",
                },
            )
            frame = next(f for f in pagina.frames if "game-chip-overlay-frame" in f.url)
            self.assertEqual(resultado["status"], "EXECUTADA")
            self.assertEqual(frame.evaluate("window.__surfaceClicks"), 1)
            self.assertEqual(frame.evaluate("window.__surfacePointerDown"), 1)
            self.assertEqual(frame.evaluate("window.__targetClicks"), 1)
        finally:
            pagina.close()

    def test_bug036_ficha_sem_marcador_dom_usa_input_real_uma_unica_vez(self):
        pagina = self.nova_pagina("/game-chip-roundtrip.html")
        self.configurar_janela(26, "AcceptingBets", timeout=4.0)
        try:
            resultado = executar_aposta_na_tela(
                pagina,
                {
                    "order_id": "123e4567-e89b-42d3-a456-426614174004",
                    "alvo": "PlayerWon",
                    "valor": 5,
                    "sincronizar_janela": True,
                    "coletor_seq_aceite": 26,
                    "stage_aceite": "Resolved",
                },
            )
            frame = next(f for f in pagina.frames if "game-chip-roundtrip-frame" in f.url)
            self.assertEqual(resultado["status"], "EXECUTADA")
            self.assertEqual(frame.evaluate("window.__selectedValue"), 5)
            self.assertEqual(frame.evaluate("window.__surfaceClicks"), 1)
            self.assertEqual(frame.evaluate("window.__targetClicks"), 1)
        finally:
            pagina.close()

    def test_bug028_stage_dealing_nao_autoriza_dom_visivel(self):
        pagina = self.nova_pagina("/game.html")
        self.configurar_janela(25, "Dealing", timeout=1.0)

        def resolver_sem_aposta():
            FUNCOES["coletor_seq"] = 26
            FUNCOES["atualizar_estado_mesa_player"]({"args": {"game": {"stage": "Resolved"}}})

        timer = threading.Timer(0.2, resolver_sem_aposta)
        timer.start()
        try:
            frame = self.frame_jogo(pagina)
            resultado = executar_aposta_na_tela(pagina, self.ordem_sincronizada(25))
            self.assertEqual(resultado["status"], "EXPIRADA")
            self.assertEqual(frame.evaluate("window.__chipClicks")["10"], 0)
            self.assertEqual(frame.evaluate("window.__targetClicks")["playerA"], 0)
        finally:
            timer.cancel()
            pagina.close()

    def test_bug018_novo_resolved_invalida_ordem_sem_cliques(self):
        pagina = self.nova_pagina("/game-closed.html")
        self.configurar_janela(30, "Resolved", timeout=1.5)

        def avancar_rodada():
            FUNCOES["coletor_seq"] = 31
            FUNCOES["atualizar_estado_mesa_player"]({"args": {"game": {"stage": "Resolved"}}})

        timer = threading.Timer(0.2, avancar_rodada)
        timer.start()
        try:
            resultado = executar_aposta_na_tela(pagina, self.ordem_sincronizada(30))
            frame = next(f for f in pagina.frames if "game-closed-frame" in f.url)
            self.assertEqual(resultado["status"], "EXPIRADA")
            self.assertIn("Nova rodada", resultado["motivo"])
            self.assertIn("última inspeção:", resultado["motivo"])
            self.assertIn("fichas_prontas=", resultado["motivo"])
            self.assertIn("alvos=", resultado["motivo"])
            self.assertEqual(frame.evaluate("window.__chipClicks"), 0)
            self.assertEqual(frame.evaluate("window.__targetClicks"), 0)
        finally:
            timer.cancel()
            pagina.close()

    def test_bug018_desconexao_enquanto_aguarda_falha_sem_cliques(self):
        pagina = self.nova_pagina("/game-closed.html")
        self.configurar_janela(40, "Resolved", timeout=1.5)
        timer = threading.Timer(0.2, FUNCOES["executor_pronto"].clear)
        timer.start()
        try:
            resultado = executar_aposta_na_tela(pagina, self.ordem_sincronizada(40))
            frame = next(f for f in pagina.frames if "game-closed-frame" in f.url)
            self.assertEqual(resultado["status"], "FALHOU")
            self.assertIn("indisponível", resultado["motivo"])
            self.assertEqual(frame.evaluate("window.__chipClicks"), 0)
            self.assertEqual(frame.evaluate("window.__targetClicks"), 0)
        finally:
            timer.cancel()
            FUNCOES["executor_pronto"].set()
            pagina.close()



    def test_bug019_ordem_composta_prevalida_e_executa_principal_mais_tie(self):
        pagina = self.nova_pagina("/game.html")
        try:
            frame = self.frame_jogo(pagina)
            resultado = executar_aposta_na_tela(pagina, {"apostas": [
                {"alvo": "PlayerWon", "valor": 10},
                {"alvo": "Tie", "valor": 5}
            ]})
            self.assertEqual(resultado["status"], "EXECUTADA")
            self.assertEqual(resultado["cliques_alvo"], 2)
            chips = frame.evaluate("window.__chipClicks")
            alvos = frame.evaluate("window.__targetClicks")
            self.assertEqual(chips["10"], 1)
            self.assertEqual(chips["5"], 1)
            self.assertEqual(alvos["playerA"], 1)
            self.assertEqual(alvos["tie"], 1)
        finally:
            pagina.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
