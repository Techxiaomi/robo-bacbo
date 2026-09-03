from pathlib import Path
import unittest


class LiveBridgeHeadlessContractTests(unittest.TestCase):
    def test_live_bridge_launches_chromium_headless(self):
        source = (Path(__file__).resolve().parents[1] / "live_bridge.py").read_text(encoding="utf-8")

        self.assertIn(
            'playwright.chromium.launch(headless=True, args=BROWSER_ARGS)',
            source,
        )
        self.assertNotIn(
            'playwright.chromium.launch(headless=False, args=BROWSER_ARGS)',
            source,
        )
        self.assertIn('LIVE_BRIDGE_BROWSER_HEADLESS=true', source)


if __name__ == "__main__":
    unittest.main()
