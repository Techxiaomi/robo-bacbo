from pathlib import Path

path = Path(__file__).resolve().parents[1] / "robo-bacbo" / "support" / "pure-logic-suite.js"
text = path.read_text(encoding="utf-8")
old = '    assert.match(executorPythonSource, /alvo_elemento\\.click\\(timeout=750\\)/);\n'
new = (
    '    assert.match(executorPythonSource, /clicar_alvo_financeiro_playwright\\(alvo_elemento\\)/);\n'
    '    assert.match(executorPythonSource, /confirmar_aceite_financeiro_aposta\\(/);\n'
    '    assert.match(executorPythonSource, /CLIQUE SEM ACEITE COMPROVADO/);\n'
)
if text.count(old) != 1:
    raise SystemExit(f"BUG-039: esperado 1 contrato obsoleto de clique direto, encontrado {text.count(old)}")
text = text.replace(old, new, 1)
path.write_text(text, encoding="utf-8")
print("Contrato Node BUG-039 atualizado para superfície real + confirmação por perna.")
