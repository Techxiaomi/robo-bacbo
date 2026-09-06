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
        tree = ast.parse(source)

        helper = None
        for node in tree.body:
            if (
                isinstance(node, ast.FunctionDef)
                and node.name == "_frame_with_visible_betting_surface"
            ):
                helper = node
                break

        self.assertIsNotNone(helper)

        executable_body = list(helper.body)
        if (
            executable_body
            and isinstance(executable_body[0], ast.Expr)
            and isinstance(executable_body[0].value, ast.Constant)
            and isinstance(executable_body[0].value.value, str)
        ):
            executable_body = executable_body[1:]

        trial_keywords = []
        for statement in executable_body:
            for node in ast.walk(statement):
                if not isinstance(node, ast.Call):
                    continue
                for keyword in node.keywords:
                    if keyword.arg != "trial":
                        continue
                    if isinstance(keyword.value, ast.Constant):
                        trial_keywords.append(keyword.value.value)
                    else:
                        trial_keywords.append("DYNAMIC")

        self.assertNotIn(True, trial_keywords)
        self.assertNotIn("DYNAMIC", trial_keywords)

        helper_source = ast.get_source_segment(source, helper) or ""
        self.assertIn("bacbo-betting-grid", helper_source)
        self.assertIn("bacbo-bet-spot-Player", helper_source)
        self.assertIn("bacbo-bet-spot-Tie", helper_source)
        self.assertIn("bacbo-bet-spot-Banker", helper_source)

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
