from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLAYWRIGHT_TEST = ROOT / "robo-sync-pilot" / "tests" / "test_playwright_dom.py"
PURE_SUITE = ROOT / "robo-bacbo" / "support" / "pure-logic-suite.js"


def replace_once(path, old, new, label):
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"BUG-038 follow-up: esperado 1 match para {label}, encontrado {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    PLAYWRIGHT_TEST,
    '        "selecionar_ficha_com_confirmacao",\n        "formatar_diagnostico_janela",',
    '        "selecionar_ficha_com_confirmacao",\n        "preselecionar_ficha_unica_antes_da_janela",\n        "formatar_diagnostico_janela",',
    "loader AST do helper de pre-selecao",
)

replace_once(
    PURE_SUITE,
    '    assert.match(executorPythonSource, /hit_elemento\\.click\\(timeout=2000\\)/);',
    '    assert.match(executorPythonSource, /hit_elemento\\.click\\(timeout=700\\)/);\n'
    '    assert.match(executorPythonSource, /preselecionar_ficha_unica_antes_da_janela/);\n'
    '    assert.match(executorPythonSource, /page\\.wait_for_timeout\\(25\\)/);\n'
    '    assert.match(executorPythonSource, /alvo_elemento\\.click\\(timeout=750\\)/);',
    "contrato BUG-028/038 de latencia",
)

print("BUG-038 follow-up de testes aplicado.")
