import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
LIVE_BRIDGE = ROOT / "live_bridge.py"


class LiveBridgeInactivityPopupContractTests(unittest.TestCase):
    def test_keep_alive_closes_and_logs_inactivity_popup(self):
        source = LIVE_BRIDGE.read_text(encoding="utf-8")

        self.assertIn("KEEP_ALIVE_INTERVAL_SECONDS = 15.0", source)
        self.assertIn("if robo.fechar_popup_inatividade(page):", source)
        self.assertIn(
            'print("LIVE_BRIDGE_INACTIVITY_POPUP_DISMISSED=true")',
            source,
        )
        self.assertIn("_require_adapter_session_healthy(page)", source)

    def test_headless_contract_remains_enabled(self):
        source = LIVE_BRIDGE.read_text(encoding="utf-8")

        self.assertIn('print("LIVE_BRIDGE_BROWSER_HEADLESS=true")', source)
        self.assertIn(
            "playwright.chromium.launch(headless=True, args=BROWSER_ARGS)",
            source,
        )
        self.assertNotIn(
            "playwright.chromium.launch(headless=False, args=BROWSER_ARGS)",
            source,
        )


if __name__ == "__main__":
    unittest.main()
