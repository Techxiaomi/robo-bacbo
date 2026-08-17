from pathlib import Path

p = Path("scripts/apply_bug014c.py")
text = p.read_text(encoding="utf-8")
old = '    """,\n    "remove risco serial CURRENT_STATE"'
new = '    "",\n    "remove risco serial CURRENT_STATE"'
if text.count(old) != 1:
    raise SystemExit(f"CURRENT_STATE empty replacement: esperado 1, encontrado {text.count(old)}")
text = text.replace(old, new, 1)
old = '    """,\n    "remove handoff serial risk"'
new = '    "",\n    "remove handoff serial risk"'
if text.count(old) != 1:
    raise SystemExit(f"handoff empty replacement: esperado 1, encontrado {text.count(old)}")
text = text.replace(old, new, 1)
p.write_text(text, encoding="utf-8")
print("aspas vazias do aplicador BUG-014C corrigidas")
