import ast
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ROBO = ROOT / "robo.py"
SOURCE = ROBO.read_text(encoding="utf-8")
TREE = ast.parse(SOURCE)


def fonte_funcao(nome):
    for node in TREE.body:
        if isinstance(node, ast.FunctionDef) and node.name == nome:
            linhas = SOURCE.splitlines()
            return "\n".join(
                linhas[node.lineno - 1:node.end_lineno]
            )
    raise AssertionError(
        f"funcao ausente: {nome}"
    )


class Mc24ExecutorGateContract(unittest.TestCase):
    def test_gate_espera_plano_inteiro_acionavel(self):
        gate = fonte_funcao(
            "aguardar_janela_apostas_aberta"
        )

        self.assertIn(
            "localizar_frame_aposta(",
            gate
        )

        self.assertIn(
            "planos",
            gate
        )

        self.assertNotIn(
            "wait_for_selector",
            gate
        )

        self.assertNotIn(
            "BETTING_CHIP_SELECTOR,",
            gate
        )

    def test_frame_exige_actionability_e_hit_test(self):
        frame = fonte_funcao(
            "localizar_frame_aposta"
        )

        self.assertIn(
            "trial=True",
            frame
        )

        self.assertIn(
            "resolver_ponto_seguro_alvo",
            frame
        )

        self.assertIn(
            'plano["cliques_necessarios"]',
            frame
        )

    def test_execucao_nao_usa_force_na_ficha(self):
        executar = fonte_funcao(
            "executar_place_bet"
        )

        self.assertIn(
            "aguardar_janela_apostas_aberta(page, planos)",
            executar
        )

        self.assertNotIn(
            "ficha_elemento.click(force=True",
            executar
        )

    def test_ficha_explicitamente_selecionada_nao_e_reclicada(self):
        frame = fonte_funcao(
            "localizar_frame_aposta"
        )

        executar = fonte_funcao(
            "executar_place_bet"
        )

        helper = fonte_funcao(
            "ficha_explicitamente_selecionada"
        )

        self.assertIn(
            "aria-pressed",
            helper
        )

        self.assertIn(
            "aria-selected",
            helper
        )

        self.assertIn(
            "data-selected",
            helper
        )

        self.assertIn(
            "aceitar_selecionada=True",
            frame
        )

        self.assertIn(
            "ficha_explicitamente_selecionada",
            frame
        )

        self.assertIn(
            "if not ficha_explicitamente_selecionada(ficha_elemento):",
            executar
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
