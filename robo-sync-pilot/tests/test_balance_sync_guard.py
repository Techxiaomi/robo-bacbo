import importlib
import types
import unittest

import balance_sync_guard


class BalanceSyncGuardTests(unittest.TestCase):
    def _fresh_guard(self):
        return importlib.reload(balance_sync_guard)

    @staticmethod
    def _fake_robo(process_impl):
        published = []

        def publicar_redis(payload):
            published.append(dict(payload))
            return True

        def publicar_saldo_redis(balance):
            return publicar_redis({"action": "balance_update", "balance": float(balance)})

        module = types.SimpleNamespace(
            processar_comando_playwright=process_impl,
            publicar_redis=publicar_redis,
            publicar_saldo_redis=publicar_saldo_redis,
        )
        return module, published

    def test_sync_balance_retries_and_preserves_request_id(self):
        guard = self._fresh_guard()
        attempts = []

        def process(_playwright, _session, command):
            attempts.append(command["action"])
            if len(attempts) < 3:
                raise RuntimeError("saldo temporariamente indisponivel")
            fake.publicar_saldo_redis(15.0)

        fake, published = self._fake_robo(process)
        self.assertTrue(guard.install_balance_sync_guard(fake))

        fake.processar_comando_playwright(None, {}, {
            "action": "sync_balance",
            "request_id": "req-123",
        })

        self.assertEqual(len(attempts), 3)
        self.assertEqual(published, [{
            "action": "balance_update",
            "balance": 15.0,
            "request_id": "req-123",
        }])

    def test_sync_balance_terminal_error_is_nonfatal(self):
        guard = self._fresh_guard()

        def process(_playwright, _session, _command):
            raise RuntimeError("saldo ausente")

        fake, published = self._fake_robo(process)
        guard.install_balance_sync_guard(fake)

        fake.processar_comando_playwright(None, {}, {
            "action": "sync_balance",
            "request_id": "req-err",
        })

        self.assertEqual(published[-1]["action"], "balance_error")
        self.assertEqual(published[-1]["request_id"], "req-err")
        self.assertIn("saldo ausente", published[-1]["error"])

    def test_place_bet_is_not_retried_or_intercepted(self):
        guard = self._fresh_guard()
        calls = []

        def process(_playwright, _session, command):
            calls.append(command["action"])
            return "financial-original-path"

        fake, published = self._fake_robo(process)
        guard.install_balance_sync_guard(fake)

        result = fake.processar_comando_playwright(None, {}, {"action": "place_bet"})

        self.assertEqual(result, "financial-original-path")
        self.assertEqual(calls, ["place_bet"])
        self.assertEqual(published, [])


if __name__ == "__main__":
    unittest.main()
