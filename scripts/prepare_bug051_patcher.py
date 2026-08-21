from pathlib import Path

p = Path('scripts/apply_bug051_autotrader_hardening.py')
text = p.read_text(encoding='utf-8')

text = text.replace(
    "UI = Path('robo-bacbo/public/index.html')",
    "UI = Path('robo-bacbo/public/dashboard-app.html')"
)

old = '''ui = replace_once(\n    ui,\n    "<th style=\\"width:13%\\">Saldo do modelo</th>",\n    "<th style=\\"width:13%\\">Saldo real pós-liquidação</th>",\n    'PDF post settlement header'\n)'''
new = '''ui = replace_once(\n    ui,\n    "Saldo do modelo",\n    "Saldo real pós-liquidação",\n    'PDF post settlement header'\n)'''

if old not in text:
    raise RuntimeError('bloco do cabeçalho PDF não encontrado no aplicador')
text = text.replace(old, new, 1)
p.write_text(text, encoding='utf-8')
print('BUG-051 patcher preparado para dashboard-app e cabeçalho robusto.')
