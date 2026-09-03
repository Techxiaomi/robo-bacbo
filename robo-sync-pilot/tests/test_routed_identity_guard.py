import types
import unittest

from routed_identity_guard import install_routed_identity_guard


class RoutedIdentityGuardTests(unittest.TestCase):
    def _config(self):
        return {
            "session": {
                "account_id": 4,
                "session_id": "account-4:bacbo_int",
            },
            "table": {
                "table_key": "bacbo_int",
            },
        }

    def _robo(self):
        calls = {
            "process": [],
            "finalize": [],
            "publish": [],
        }

        def process(playwright, session, command):
            calls["process"].append((playwright, session, command))
            return "processed"

        def finalize(order_id, status, **kwargs):
            calls["finalize"].append((order_id, status, kwargs))

        def publish(payload):
            calls["publish"].append(payload)
            return 1

        robo = types.SimpleNamespace(
            processar_comando_playwright=process,
            finalizar_order_id=finalize,
            publicar_redis=publish,
        )
        return robo, calls

    def _place_bet(self, **overrides):
        command = {
            "action": "place_bet",
            "order_id": "Etapa3-Identity-001",
            "routed_account_id": 4,
            "routed_session_id": "account-4:bacbo_int",
            "routed_table_key": "bacbo_int",
        }
        command.update(overrides)
        return command

    def _sync_balance(self, **overrides):
        command = {
            "action": "sync_balance",
            "request_id": "activation-balance-001",
            "routed_account_id": 4,
            "routed_session_id": "account-4:bacbo_int",
            "routed_table_key": "bacbo_int",
        }
        command.update(overrides)
        return command

    def test_identidade_exata_preserva_fluxo_original(self):
        robo, calls = self._robo()
        self.assertTrue(install_routed_identity_guard(robo, self._config()))

        result = robo.processar_comando_playwright(
            object(),
            {"page": object()},
            self._place_bet(),
        )

        self.assertEqual(result, "processed")
        self.assertEqual(len(calls["process"]), 1)
        self.assertEqual(calls["finalize"], [])
        self.assertEqual(calls["publish"], [])

    def test_place_bet_da_mesa_errada_falha_fechado_sem_playwright(self):
        robo, calls = self._robo()
        install_routed_identity_guard(robo, self._config())

        result = robo.processar_comando_playwright(
            object(),
            {"page": object()},
            self._place_bet(routed_table_key="bacbo_br"),
        )

        self.assertIsNone(result)
        self.assertEqual(calls["process"], [])
        self.assertEqual(len(calls["finalize"]), 1)
        order_id, status, kwargs = calls["finalize"][0]
        self.assertEqual(order_id, "etapa3-identity-001")
        self.assertEqual(status, "FALHOU")
        self.assertIn("LIVE_BRIDGE_ROUTED_IDENTITY_MISMATCH", kwargs["motivo"])
        self.assertIn("expected_table=bacbo_int", kwargs["motivo"])
        self.assertIn("received_table=bacbo_br", kwargs["motivo"])

    def test_sessao_errada_falha_fechado(self):
        robo, calls = self._robo()
        install_routed_identity_guard(robo, self._config())

        robo.processar_comando_playwright(
            object(),
            {"page": object()},
            self._place_bet(routed_session_id="account-4:bacbo_br"),
        )

        self.assertEqual(calls["process"], [])
        self.assertEqual(len(calls["finalize"]), 1)
        self.assertIn("received_session=account-4:bacbo_br", calls["finalize"][0][2]["motivo"])

    def test_metadados_roteados_ausentes_nao_sao_aceitos_em_place_bet(self):
        robo, calls = self._robo()
        install_routed_identity_guard(robo, self._config())

        robo.processar_comando_playwright(
            object(),
            {"page": object()},
            {
                "action": "place_bet",
                "order_id": "missing-route-001",
            },
        )

        self.assertEqual(calls["process"], [])
        self.assertEqual(len(calls["finalize"]), 1)
        motivo = calls["finalize"][0][2]["motivo"]
        self.assertIn("received_account=<missing>", motivo)
        self.assertIn("received_session=<missing>", motivo)
        self.assertIn("received_table=<missing>", motivo)

    def test_sync_balance_com_identidade_exata_preserva_fluxo_original(self):
        robo, calls = self._robo()
        install_routed_identity_guard(robo, self._config())

        result = robo.processar_comando_playwright(
            object(),
            {"page": object()},
            self._sync_balance(),
        )

        self.assertEqual(result, "processed")
        self.assertEqual(len(calls["process"]), 1)
        self.assertEqual(calls["publish"], [])
        self.assertEqual(calls["finalize"], [])

    def test_sync_balance_sem_metadata_falha_fechado_sem_playwright(self):
        robo, calls = self._robo()
        install_routed_identity_guard(robo, self._config())

        result = robo.processar_comando_playwright(
            object(),
            {"page": object()},
            {
                "action": "sync_balance",
                "request_id": "activation-balance-missing-route-001",
            },
        )

        self.assertIsNone(result)
        self.assertEqual(calls["process"], [])
        self.assertEqual(calls["finalize"], [])
        self.assertEqual(len(calls["publish"]), 1)
        payload = calls["publish"][0]
        self.assertEqual(payload["action"], "balance_error")
        self.assertEqual(payload["request_id"], "activation-balance-missing-route-001")
        self.assertIn("LIVE_BRIDGE_ROUTED_IDENTITY_MISMATCH", payload["error"])
        self.assertIn("received_account=<missing>", payload["error"])
        self.assertIn("received_session=<missing>", payload["error"])
        self.assertIn("received_table=<missing>", payload["error"])

    def test_sync_balance_mal_roteado_publica_erro_correlacionado_sem_playwright(self):
        robo, calls = self._robo()
        install_routed_identity_guard(robo, self._config())

        robo.processar_comando_playwright(
            object(),
            {"page": object()},
            {
                "action": "sync_balance",
                "request_id": "balance-route-001",
                "routed_account_id": 1,
                "routed_session_id": "account-1:bacbo_int",
                "routed_table_key": "bacbo_int",
            },
        )

        self.assertEqual(calls["process"], [])
        self.assertEqual(calls["finalize"], [])
        self.assertEqual(len(calls["publish"]), 1)
        payload = calls["publish"][0]
        self.assertEqual(payload["action"], "balance_error")
        self.assertEqual(payload["request_id"], "balance-route-001")
        self.assertIn("LIVE_BRIDGE_ROUTED_IDENTITY_MISMATCH", payload["error"])

    def test_sync_balance_metadata_parcial_continua_fail_closed(self):
        robo, calls = self._robo()
        install_routed_identity_guard(robo, self._config())

        robo.processar_comando_playwright(
            object(),
            {"page": object()},
            {
                "action": "sync_balance",
                "request_id": "balance-partial-001",
                "routed_account_id": 4,
            },
        )

        self.assertEqual(calls["process"], [])
        self.assertEqual(len(calls["publish"]), 1)
        self.assertIn("LIVE_BRIDGE_ROUTED_IDENTITY_MISMATCH", calls["publish"][0]["error"])

    def test_reinstalacao_com_identidade_diferente_e_proibida(self):
        robo, _ = self._robo()
        install_routed_identity_guard(robo, self._config())

        other = self._config()
        other["table"]["table_key"] = "bacbo_br"
        other["session"]["session_id"] = "account-4:bacbo_br"

        with self.assertRaisesRegex(
            RuntimeError,
            "LIVE_BRIDGE_ROUTED_IDENTITY_GUARD_RECONFIGURATION_FORBIDDEN",
        ):
            install_routed_identity_guard(robo, other)


if __name__ == "__main__":
    unittest.main()
