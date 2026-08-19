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
        "identidade_rodada_evolution",
        "atualizar_estado_mesa_player",
        "avaliar_contexto_janela_aposta",
        "elemento_apostavel",
        "localizar_frame_apostavel",
        "aguardar_janela_aposta",
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
            "args": {"game": {"stage": "Betting"}}
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
            self.assertEqual(frame.evaluate("window.__chipClicks"), 0)
            self.assertEqual(frame.evaluate("window.__targetClicks"), 0)
        finally:
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
