import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "robo.py").read_text(encoding="utf-8")


class Bug038FastPathContract(unittest.TestCase):
    def test_preparacao_nao_financeira_antecede_janela(self):
        inicio = SOURCE.index("def executar_aposta_na_tela")
        fim = SOURCE.index("def parsear_valor_monetario", inicio)
        corpo = SOURCE[inicio:fim]
        self.assertLess(corpo.index("saldo_antes = ler_saldo_atual(page)"), corpo.index("aguardar_janela_aposta(page, aposta, planos)"))
        self.assertLess(corpo.index("preselecionar_ficha_unica_antes_da_janela(page, planos)"), corpo.index("aguardar_janela_aposta(page, aposta, planos)"))

    def test_fast_path_nao_remove_gate_financeiro(self):
        inicio = SOURCE.index("def executar_aposta_na_tela")
        fim = SOURCE.index("def parsear_valor_monetario", inicio)
        corpo = SOURCE[inicio:fim]
        self.assertIn("contexto_atual = avaliar_contexto_janela_aposta(aposta)", corpo)
        self.assertIn('if contexto_atual["estado"] != "ABERTA"', corpo)
        self.assertIn("clicar_alvo_financeiro_playwright(alvo_elemento)", corpo)

    def test_latencias_artificiais_criticas_foram_reduzidas(self):
        inicio = SOURCE.index("def selecionar_ficha_com_confirmacao")
        fim = SOURCE.index("def confirmar_aceite_financeiro_aposta", inicio)
        trecho = SOURCE[inicio:fim]
        self.assertNotIn("page.wait_for_timeout(120)", trecho)
        self.assertIn("page.wait_for_timeout(25)", trecho)
        self.assertIn("page.wait_for_timeout(1500)", SOURCE)
        self.assertIn("page.wait_for_timeout(2000)", SOURCE)
        self.assertIn('position={"x": largura / 2.0, "y": altura / 2.0}', SOURCE)
        self.assertNotIn("hit_elemento.click", SOURCE)

    def test_loop_executor_polling_rapido(self):
        self.assertIn("page.wait_for_timeout(50)", SOURCE)


if __name__ == "__main__":
    unittest.main()
