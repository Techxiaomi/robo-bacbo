from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

TRIAL_TIMEOUT_MS = 1200


@dataclass
class Candidate:
    source: str
    css: str
    tag: str
    data_role: str
    data_value: str
    pointer_events: str
    visibility: str
    display: str
    opacity: str
    width: float
    height: float
    disabled: bool
    aria_disabled: str
    contains_chip: bool
    actionable: bool = False
    trial_error: str = ""


def _sanitize(text: Any, limit: int = 700) -> str:
    value = " ".join(str(text or "").replace("\r", " ").replace("\n", " ").split())
    return value[:limit]


def _candidate_from_raw(raw: dict) -> Candidate:
    return Candidate(
        source=str(raw.get("source") or ""),
        css=str(raw.get("css") or ""),
        tag=str(raw.get("tag") or ""),
        data_role=str(raw.get("dataRole") or ""),
        data_value=str(raw.get("dataValue") or ""),
        pointer_events=str(raw.get("pointerEvents") or ""),
        visibility=str(raw.get("visibility") or ""),
        display=str(raw.get("display") or ""),
        opacity=str(raw.get("opacity") or ""),
        width=float(raw.get("width") or 0),
        height=float(raw.get("height") or 0),
        disabled=bool(raw.get("disabled")),
        aria_disabled=str(raw.get("ariaDisabled") or ""),
        contains_chip=bool(raw.get("containsChip")),
    )


def _dom_candidates(chip):
    return chip.evaluate(
        r"""
        chip => {
            function esc(value) {
                if (window.CSS && CSS.escape) return CSS.escape(String(value));
                return String(value).replace(/([ !"#$%&'()*+,./:;<=>?@[\]^`{|}~])/g, '\\$1');
            }

            function selectorFor(el) {
                if (!el || el.nodeType !== 1) return '';
                const id = el.getAttribute('id');
                if (id) return '#' + esc(id);

                const role = el.getAttribute('data-role');
                const value = el.getAttribute('data-value');
                if (role && value) {
                    return '[data-role="' + esc(role) + '"][data-value="' + esc(value) + '"]';
                }
                if (role) {
                    try {
                        const candidate = '[data-role="' + esc(role) + '"]';
                        if (document.querySelectorAll(candidate).length === 1) return candidate;
                    } catch (_) {}
                }

                const parts = [];
                let node = el;
                while (node && node.nodeType === 1 && node !== document.documentElement) {
                    const tag = node.tagName.toLowerCase();
                    let nth = 1;
                    let sibling = node.previousElementSibling;
                    while (sibling) {
                        if (sibling.tagName && sibling.tagName.toLowerCase() === tag) nth++;
                        sibling = sibling.previousElementSibling;
                    }
                    parts.unshift(tag + ':nth-of-type(' + nth + ')');
                    node = node.parentElement;
                    if (parts.length >= 8) break;
                }
                return parts.join(' > ');
            }

            function describe(el, source) {
                if (!el || el.nodeType !== 1) return null;
                const style = getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return {
                    source,
                    css: selectorFor(el),
                    tag: String(el.tagName || '').toLowerCase(),
                    dataRole: String(el.getAttribute('data-role') || ''),
                    dataValue: String(el.getAttribute('data-value') || ''),
                    pointerEvents: String(style.pointerEvents || ''),
                    visibility: String(style.visibility || ''),
                    display: String(style.display || ''),
                    opacity: String(style.opacity || ''),
                    width: Number(rect.width || 0),
                    height: Number(rect.height || 0),
                    disabled: Boolean(el.disabled || el.getAttribute('disabled') !== null),
                    ariaDisabled: String(el.getAttribute('aria-disabled') || ''),
                    containsChip: Boolean(el === chip || el.contains(chip))
                };
            }

            const rect = chip.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const result = [];
            const seen = new Set();

            function add(el, source) {
                if (!el || seen.has(el)) return;
                seen.add(el);
                const desc = describe(el, source);
                if (desc) result.push(desc);
            }

            add(chip, 'VISUAL_CHIP');
            const hit = document.elementFromPoint(cx, cy);
            add(hit, 'ELEMENT_FROM_POINT');

            let hitParent = hit ? hit.parentElement : null;
            for (let i = 0; hitParent && i < 6; i++) {
                add(hitParent, 'HIT_ANCESTOR_' + (i + 1));
                hitParent = hitParent.parentElement;
            }

            let parent = chip.parentElement;
            for (let i = 0; parent && i < 8; i++) {
                add(parent, 'CHIP_ANCESTOR_' + (i + 1));
                if (parent.children) {
                    for (const child of Array.from(parent.children)) {
                        if (child !== chip) add(child, 'ANCESTOR_' + (i + 1) + '_CHILD');
                    }
                }
                parent = parent.parentElement;
            }

            add(chip.previousElementSibling, 'PREVIOUS_SIBLING');
            add(chip.nextElementSibling, 'NEXT_SIBLING');
            return result;
        }
        """
    )


def _looks_interactive(candidate: Candidate) -> bool:
    if not candidate.css:
        return False
    if candidate.pointer_events == "none":
        return False
    if candidate.display == "none":
        return False
    if candidate.visibility == "hidden":
        return False
    if candidate.opacity == "0":
        return False
    if candidate.width <= 0 or candidate.height <= 0:
        return False
    if candidate.disabled:
        return False
    if candidate.aria_disabled.lower() == "true":
        return False
    return True


def probe_chip_interactive_locator(frame, value, *, trial_timeout_ms: int = TRIAL_TIMEOUT_MS) -> dict:
    value_text = str(value)
    chip_selector = f'[data-role="chip"][data-value="{value_text}"]'
    chips = frame.locator(chip_selector)

    if chips.count() <= 0:
        return {
            "ok": False,
            "chip_selector": chip_selector,
            "interactive_selector": None,
            "interactive_source": None,
            "reason": "CHIP_NOT_FOUND",
            "candidates": [],
        }

    chip = chips.first
    if not chip.is_visible():
        return {
            "ok": False,
            "chip_selector": chip_selector,
            "interactive_selector": None,
            "interactive_source": None,
            "reason": "CHIP_NOT_VISIBLE",
            "candidates": [],
        }

    candidates = []
    for raw in _dom_candidates(chip):
        candidate = _candidate_from_raw(raw)
        candidates.append(candidate)

        print(
            "CHIP_PROBE_CANDIDATE "
            f"value={value_text} source={candidate.source} css={candidate.css!r} "
            f"tag={candidate.tag!r} data_role={candidate.data_role!r} "
            f"data_value={candidate.data_value!r} pointer_events={candidate.pointer_events!r} "
            f"visibility={candidate.visibility!r} display={candidate.display!r} "
            f"opacity={candidate.opacity!r} size={candidate.width}x{candidate.height}"
        )

        if not _looks_interactive(candidate):
            continue

        locator = frame.locator(candidate.css).first
        try:
            locator.click(trial=True, timeout=trial_timeout_ms)
            candidate.actionable = True
            print(
                "CHIP_PROBE_ACTIONABLE "
                f"value={value_text} source={candidate.source} locator={candidate.css!r}"
            )
            return {
                "ok": True,
                "chip_selector": chip_selector,
                "interactive_selector": candidate.css,
                "interactive_source": candidate.source,
                "reason": None,
                "candidates": [asdict(item) for item in candidates],
            }
        except Exception as error:
            candidate.trial_error = _sanitize(error)
            print(
                "CHIP_PROBE_TRIAL_REJECTED "
                f"value={value_text} source={candidate.source} locator={candidate.css!r} "
                f"error={candidate.trial_error}"
            )

    return {
        "ok": False,
        "chip_selector": chip_selector,
        "interactive_selector": None,
        "interactive_source": None,
        "reason": "NO_ACTIONABLE_CANDIDATE",
        "candidates": [asdict(item) for item in candidates],
    }


def assert_chip_ui_actionable(frame, value):
    result = probe_chip_interactive_locator(frame, value)
    assert result["ok"], (
        f"Nenhum elemento interativo valido encontrado para a ficha {value}. "
        f"visual={result['chip_selector']} reason={result.get('reason')}"
    )
    assert result["interactive_selector"], (
        f"Probe retornou sucesso sem locator para ficha {value}"
    )
    print(
        "CHIP_PROBE_ASSERT_OK "
        f"value={value} interactive_locator={result['interactive_selector']!r} "
        f"source={result['interactive_source']}"
    )
    return result
