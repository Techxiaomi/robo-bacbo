import unittest
from unittest.mock import patch

import live_bridge


class LiveBridgeTechnicalCapsTests(unittest.TestCase):
    def _base_config(self, *, enabled, max_exposure):
        return {
            "house": {
                "id": 1,
                "adapter_key": "brasil-da-sorte",
                "home_url": "https://example.test/",
            },
            "table": {
                "table_key": "bacbo_int",
                "game_url": "https://example.test/bacbo",
            },
            "session": {
                "account_id": 1,
                "session_id": "account-1:bacbo_int",
                "redis_command_channel": "auto_trader_commands:1:bacbo_int",
                "redis_response_channel": "auto_trader_responses:1:bacbo_int",
            },
            "safety": {
                "armed": True,
                "mode": "controlled",
                "technical_caps_enabled": enabled,
                "max_exposure": max_exposure,
            },
        }

    def test_validate_config_preserva_caps_desabilitados_sem_sentinel(self):
        config = self._base_config(enabled=False, max_exposure=500.0)

        with patch.object(live_bridge.robo, "auto_trader_habilitado", return_value=True):
            table_key, enabled, max_exposure, session = live_bridge._validate_config(config)

        self.assertEqual(table_key, "bacbo_int")
        self.assertFalse(enabled)
        self.assertEqual(max_exposure, 500.0)
        self.assertEqual(session["account_id"], 1)

    def test_caps_desabilitados_nao_rejeitam_exposicao_acima_do_valor_configurado(self):
        command = {
            "action": "place_bet",
            "order_id": "caps-disabled-001",
            "apostas": [
                {"alvo": "PlayerWon", "valor": 10},
                {"alvo": "Tie", "valor": 5},
            ],
        }
        session = {"page": object()}

        with (
            patch.object(live_bridge, "_require_adapter_session_healthy"),
            patch.object(live_bridge.robo, "processar_comando_playwright") as processar,
            patch.object(live_bridge.robo, "finalizar_order_id") as finalizar,
        ):
            live_bridge._process_controlled_command(
                object(),
                session,
                command,
                False,
                5.0,
            )

        processar.assert_called_once()
        finalizar.assert_not_called()

    def test_caps_habilitados_rejeitam_exposicao_acima_do_valor_editavel(self):
        command = {
            "action": "place_bet",
            "order_id": "caps-enabled-001",
            "apostas": [
                {"alvo": "BankerWon", "valor": 10},
                {"alvo": "Tie", "valor": 5},
            ],
        }
        session = {"page": object()}

        with (
            patch.object(live_bridge, "_require_adapter_session_healthy"),
            patch.object(live_bridge.robo, "processar_comando_playwright") as processar,
            patch.object(live_bridge.robo, "finalizar_order_id") as finalizar,
        ):
            live_bridge._process_controlled_command(
                object(),
                session,
                command,
                True,
                10.0,
            )

        processar.assert_not_called()
        finalizar.assert_called_once()
        args, kwargs = finalizar.call_args
        self.assertEqual(args[0], "caps-enabled-001")
        self.assertEqual(args[1], "FALHOU")
        self.assertIn("LIVE_BRIDGE_MAX_EXPOSURE_EXCEEDED", kwargs["motivo"])

    def test_valor_configurado_fora_do_limite_administrativo_falha_fechado(self):
        config = self._base_config(enabled=True, max_exposure=100000.0)

        with patch.object(live_bridge.robo, "auto_trader_habilitado", return_value=True):
            with self.assertRaisesRegex(RuntimeError, "LIVE_BRIDGE_MAX_EXPOSURE_OUT_OF_RANGE"):
                live_bridge._validate_config(config)


if __name__ == "__main__":
    unittest.main()
