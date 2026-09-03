# Legacy executor tests

These tests are preserved for historical reference only and are intentionally outside `robo-sync-pilot/tests`, so `python -m unittest discover -s tests -v` validates only contracts for the current executor architecture.

Quarantined suites:

- `legacy_pure_logic.py`: mixed contracts for removed collector/journal/window APIs plus older parser expectations.
- `legacy_playwright_dom.py`: monolithic DOM betting flow built around removed functions such as `executar_aposta_na_tela`, `confirmar_aceite_financeiro_aposta`, and `stage_evolution_apostavel`.

Do not restore removed production APIs merely to make these historical tests pass. If a legacy behavior is still required, add a focused contract for the current implementation under `tests/`.
