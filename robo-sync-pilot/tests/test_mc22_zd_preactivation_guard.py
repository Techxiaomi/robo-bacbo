import unittest

from mesa_tipminer_scope import (
    MESA_PADRAO_CODIGO,
    TIPMINER_ROUND_ID_PADRAO,
    resolver_tipminer_round_id,
)


class MC22ZDPreactivationGuardTests(
    unittest.TestCase
):
    def test_int_preserva_round_legado(
        self,
    ):
        self.assertEqual(
            MESA_PADRAO_CODIGO,
            "BACBO_INT",
        )

        self.assertEqual(
            resolver_tipminer_round_id(
                "BACBO_INT",
                {},
            ),
            TIPMINER_ROUND_ID_PADRAO,
        )

    def test_nao_padrao_sem_round_falha_fechado(
        self,
    ):
        with self.assertRaisesRegex(
            RuntimeError,
            "TIPMINER_BACBO_ROUND_ID obrigatorio",
        ):
            resolver_tipminer_round_id(
                "MESA_TESTE_2",
                {},
            )

    def test_nao_padrao_aceita_round_explicito(
        self,
    ):
        self.assertEqual(
            resolver_tipminer_round_id(
                "mesa_teste_2",
                {
                    "TIPMINER_BACBO_ROUND_ID":
                        "round-teste-2"
                },
            ),
            "round-teste-2",
        )

    def test_round_explicito_tambem_substitui_default_int(
        self,
    ):
        self.assertEqual(
            resolver_tipminer_round_id(
                "BACBO_INT",
                {
                    "TIPMINER_BACBO_ROUND_ID":
                        "round-int-explicito"
                },
            ),
            "round-int-explicito",
        )


if __name__ == "__main__":
    unittest.main()
