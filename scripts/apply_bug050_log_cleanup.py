from pathlib import Path

root = Path(__file__).resolve().parents[1]
py = root / 'robo-sync-pilot' / 'robo.py'
js = root / 'robo-bacbo' / 'bot2_coletor.js'

p = py.read_text(encoding='utf-8')
old = '"DOM presente, clicando com force=True sem aguardar actionability."'
new = '"DOM presente; ficha em fast path com force=True e alvos financeiros com hit-test seguro."'
if old not in p:
    raise SystemExit('mensagem antiga do fast path nao encontrada')
p = p.replace(old, new, 1)
py.write_text(p, encoding='utf-8')

s = js.read_text(encoding='utf-8')
old_block = """    console.log(\n        `📤 EXECUTOR | order_id=${orderId} | plano=${planoLog} | `\n        + `exposição=R$${Number(exposicaoLog || 0).toFixed(2)}`\n    );\n"""
new_block = """    console.log(\n        `📤 EXECUTOR | order_id=${orderId} | plano=${planoLog} | `\n        + `exposição=R$${Number(exposicaoLog || 0).toFixed(2)} | aguardando execução física e prova de débito`\n    );\n"""
if old_block not in s:
    raise SystemExit('bloco de log de envio nao encontrado')
s = s.replace(old_block, new_block, 1)
old_ok = """        console.log(\n            `✅ EXECUTOR | order_id=${orderId} | plano=${planoLog} | método=${evidenciaLog.metodo || 'n/a'} | `\n            + `saldo=${Number(evidenciaLog.saldo_antes).toFixed(2)}→${Number(evidenciaLog.saldo_depois).toFixed(2)} | `\n            + `débito=R$${Number(evidenciaLog.debito_observado || 0).toFixed(2)} | `\n            + `esperado=R$${Number(evidenciaLog.exposicao_esperada || exposicaoLog || 0).toFixed(2)}`\n        );\n"""
new_ok = """        console.log(\n            `✅ EXECUTOR | order_id=${orderId} | plano=${planoLog} | método=${evidenciaLog.metodo || 'n/a'} | `\n            + `saldo=${Number(evidenciaLog.saldo_antes).toFixed(2)}→${Number(evidenciaLog.saldo_depois).toFixed(2)} | `\n            + `débito=R$${Number(evidenciaLog.debito_observado || 0).toFixed(2)} | `\n            + `esperado=R$${Number(evidenciaLog.exposicao_esperada || exposicaoLog || 0).toFixed(2)} | `\n            + `aceite financeiro confirmado`\n        );\n"""
if old_ok not in s:
    raise SystemExit('bloco de log de sucesso nao encontrado')
s = s.replace(old_ok, new_ok, 1)
js.write_text(s, encoding='utf-8')
