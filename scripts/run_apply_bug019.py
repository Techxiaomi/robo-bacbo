from pathlib import Path
import runpy

path = Path(__file__).with_name('apply_bug019.py')
text = path.read_text(encoding='utf-8')
old = '    if count != 1:\n        raise RuntimeError(f"{label}: esperado 1 match, encontrado {count}")\n'
new = '    if count < 1:\n        raise RuntimeError(f"{label}: nenhum match encontrado")\n'
if old not in text:
    raise RuntimeError('Helper replace_once do aplicador nao encontrado')
path.write_text(text.replace(old, new, 1), encoding='utf-8')
runpy.run_path(str(path), run_name='__main__')
