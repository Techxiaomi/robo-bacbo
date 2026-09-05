import unittest

from diagnostics.evolution_chip_dom_probe import (
    Candidate,
    _looks_interactive,
    probe_chip_interactive_locator,
)


class FakeLocator:
    def __init__(self, *, count_value=1, visible=True, trial_error=None):
        self._count = count_value
        self._visible = visible
        self._trial_error = trial_error
        self.first = self

    def count(self):
        return self._count

    def is_visible(self):
        return self._visible

    def click(self, *, trial=False, timeout=None):
        if trial is not True:
            raise AssertionError("probe must never execute a real click")
        if self._trial_error is not None:
            raise self._trial_error
        return None

    def evaluate(self, script):
        return [
            {
                "source": "VISUAL_CHIP",
                "css": '[data-role="chip"][data-value="25"]',
                "tag": "div",
                "dataRole": "chip",
                "dataValue": "25",
                "pointerEvents": "none",
                "visibility": "visible",
                "display": "block",
                "opacity": "1",
                "width": 30.0,
                "height": 30.0,
                "disabled": False,
                "ariaDisabled": "",
                "containsChip": True,
            },
            {
                "source": "ELEMENT_FROM_POINT",
                "css": '[data-role="chip-stack"] > div:nth-of-type(2)',
                "tag": "div",
                "dataRole": "",
                "dataValue": "",
                "pointerEvents": "auto",
                "visibility": "visible",
                "display": "block",
                "opacity": "1",
                "width": 40.0,
                "height": 40.0,
                "disabled": False,
                "ariaDisabled": "",
                "containsChip": False,
            },
        ]


class FakeFrame:
    def __init__(self):
        self.visual = FakeLocator()
        self.interactive = FakeLocator()

    def locator(self, selector):
        if selector == '[data-role="chip"][data-value="25"]':
            return self.visual
        if selector == '[data-role="chip-stack"] > div:nth-of-type(2)':
            return self.interactive
        return FakeLocator(count_value=0)


class EvolutionChipDomProbeTests(unittest.TestCase):
    def test_visual_chip_with_pointer_events_none_is_rejected(self):
        candidate = Candidate(
            source="VISUAL_CHIP",
            css='[data-role="chip"][data-value="25"]',
            tag="div",
            data_role="chip",
            data_value="25",
            pointer_events="none",
            visibility="visible",
            display="block",
            opacity="1",
            width=30,
            height=30,
            disabled=False,
            aria_disabled="",
            contains_chip=True,
        )
        self.assertFalse(_looks_interactive(candidate))

    def test_probe_resolves_actionable_hit_target_using_trial_only(self):
        result = probe_chip_interactive_locator(FakeFrame(), "25")
        self.assertTrue(result["ok"])
        self.assertEqual(result["interactive_source"], "ELEMENT_FROM_POINT")
        self.assertEqual(
            result["interactive_selector"],
            '[data-role="chip-stack"] > div:nth-of-type(2)',
        )

    def test_missing_chip_fails_closed(self):
        class MissingFrame:
            def locator(self, selector):
                return FakeLocator(count_value=0)

        result = probe_chip_interactive_locator(MissingFrame(), "25")
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "CHIP_NOT_FOUND")


if __name__ == "__main__":
    unittest.main(verbosity=2)
