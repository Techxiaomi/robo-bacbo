from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FAST = ROOT / "robo-sync-pilot" / "tests" / "test_bug038_contract.py"

FAST.write_text('''import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "robo.py").read_text(encoding="utf-8")


class Bug038FastPathContract(unittest.TestCase):
    def test_preparacao_nao_financeira_antecede_janela(self):
        inicio = SOURCE.index("def executar_aposta_na_tela")
        fim = SOURCE.index("def parsear_valor_monetario", inicio)
        corpo = SOURCE[inicio:fim]
        self.assertLess(corpo.index("saldo_antes = ler_saldo_atual(page)"), corpo.index("aguardar_janela_aposta(page, aposta, planos)"))
        self.assertNotIn("preselecionar_ficha_unica_antes_da_janela(page, planos)", corpo)
        self.assertNotIn("aguardando 1500ms para estabilização visual das fichas", SOURCE)
        self.assertIn("alvo_temporal = resolved_base + 8.0", SOURCE)

    def test_fast_path_nao_remove_gate_financeiro(self):
        inicio = SOURCE.index("def executar_aposta_na_tela")
        fim = SOURCE.index("def parsear_valor_monetario", inicio)
        corpo = SOURCE[inicio:fim]
        self.assertIn("contexto_atual = avaliar_contexto_janela_aposta(aposta)", corpo)
        self.assertIn('if contexto_atual["estado"] != "ABERTA"', corpo)
        self.assertIn("clicar_alvo_financeiro_playwright(page, alvo_elemento)", corpo)

    def test_janela_real_e_clique_simples(self):
        self.assertIn('"waitingforbets", "closingbets", "acceptingbets", "betting"', SOURCE)
        self.assertIn("ultimo_resolved_monotonic = 0.0", SOURCE)
        self.assertIn("resolved_monotonic_aceite", SOURCE)
        self.assertIn("alvo_temporal = resolved_base + 8.0", SOURCE)
        self.assertIn("janela real alvo em +8000ms", SOURCE)
        self.assertIn("page.wait_for_timeout(25)", SOURCE)
        self.assertIn("page.wait_for_timeout(2500)", SOURCE)
        self.assertEqual(SOURCE.count("elemento.click(timeout=2000)"), 2)
        self.assertIn("page.wait_for_timeout(150)", SOURCE)
        self.assertIn("page.wait_for_timeout(120)", SOURCE)
        self.assertNotIn("def clique_fisico_humano(page, elemento):", SOURCE)
        self.assertNotIn("page.mouse.move", SOURCE)
        self.assertNotIn('elemento.dispatch_event("pointerdown")', SOURCE)
        self.assertNotIn('elemento.evaluate("el => el.click()")', SOURCE)
        self.assertIn('button[aria-label="Close"]', SOURCE)
        self.assertIn('button[aria-label="Fechar"]', SOURCE)
        self.assertIn('[class*="close" i]', SOURCE)
        self.assertIn('fechar.click(force=True, timeout=1200)', SOURCE)
        atraso = SOURCE.index("page.wait_for_timeout(2500)")
        primeira_leitura = SOURCE.index("saldo_atual = ler_saldo_atual(page)", atraso)
        self.assertLess(atraso, primeira_leitura)

    def test_loop_executor_polling_rapido(self):
        self.assertIn("page.wait_for_timeout(50)", SOURCE)


if __name__ == "__main__":
    unittest.main()
''', encoding="utf-8")

print("Contrato BUG-046 alinhado ao Resolved+8s e clique Playwright simples.")
