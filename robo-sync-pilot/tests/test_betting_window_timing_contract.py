import ast
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TIMING = ROOT / "betting_window_timing.py"
LIVE_BRIDGE = ROOT / "live_bridge.py"


class BettingWindowTimingContract(unittest.TestCase):
    def test_two_phase_timing_is_bounded(self):
        source = TIMING.read_text(encoding="utf-8")
        tree = ast.parse(source)
        self.assertIsNotNone(tree)
        self.assertIn("BETTING_WINDOW_OPEN_GRACE_MS = 12000", source)
        self.assertIn("BETTING_WINDOW_TOTAL_TIMEOUT_MS = 25000", source)
        self.assertIn("open_deadline", source)
        self.assertIn("total_deadline", source)

    def test_open_detection_uses_visible_bacbo_dom_not_chip_trial(self):
        source = TIMING.read_text(encoding="utf-8")
        self.assertIn("_frame_with_visible_betting_surface", source)
        self.assertIn("[data-role='bacbo-betting-grid']", source)
        self.assertIn("bacbo-bet-spot-Player", source)
        self.assertIn("bacbo-bet-spot-Tie", source)
        self.assertIn("bacbo-bet-spot-Banker", source)
        self.assertIn("evidence=VISIBLE_BACBO_DOM", source)

        helper = source.split("def _frame_with_visible_betting_surface", 1)[1]
        helper = helper.split("def _probe_chip_dom", 1)[0]
        self.assertNotIn("trial=True", helper)
        self.assertNotIn("force=True", helper)

    def test_full_plan_gate_remains_authoritative(self):
        source = TIMING.read_text(encoding="utf-8")
        self.assertGreaterEqual(source.count("robo.localizar_frame_aposta(page, planos)"), 2)
        self.assertIn("robo.ErroJanelaApostasTimeout", source)
        self.assertIn("robo.pagina_indica_conexao_caida(page)", source)

    def test_timeout_logs_identify_exact_phase_without_changing_policy(self):
        source = TIMING.read_text(encoding="utf-8")
        self.assertIn("BETTING_WINDOW_TIMEOUT_PHASE=OPEN", source)
        self.assertIn("reason=BETTING_DOM_NOT_VISIBLE", source)
        self.assertIn("BETTING_WINDOW_TIMEOUT_PHASE=FULL_PLAN", source)
        self.assertIn("reason=PLAN_NOT_FULLY_ACTIONABLE", source)
        self.assertIn("elapsed_ms=", source)
        self.assertIn("limit_ms=", source)

    def test_live_bridge_installs_only_timing_layer(self):
        source = LIVE_BRIDGE.read_text(encoding="utf-8")
        self.assertIn("import betting_window_timing", source)
        self.assertIn("betting_window_timing.install(robo)", source)
        self.assertNotIn("financial_dry_run", source)
        self.assertNotIn("ARMED_REVIEW", source)


if __name__ == "__main__":
    unittest.main(verbosity=2)
