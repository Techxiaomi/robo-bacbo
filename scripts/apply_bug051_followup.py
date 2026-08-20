from pathlib import Path


def replace_once(path, old, new, label):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: esperado 1, encontrado {count}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')

# O saldo precisa chegar ao Node com frequência compatível com a barreira financeira de 5s.
replace_once(
    'robo-sync-pilot/robo.py',
    'float(os.getenv("BALANCE_SYNC_HEARTBEAT_SECONDS", "60"))',
    'float(os.getenv("BALANCE_SYNC_HEARTBEAT_SECONDS", "4"))',
    'heartbeat saldo 4s'
)
replace_once(
    'robo-sync-pilot/robo.py',
    'BALANCE_SYNC_HEARTBEAT_SECONDS = 60.0',
    'BALANCE_SYNC_HEARTBEAT_SECONDS = 4.0',
    'fallback heartbeat saldo 4s'
)

# Contratos antigos anteriores ao BUG-049/050.
replace_once(
    'robo-bacbo/support/pure-logic-suite.js',
    'test("BUG-046: executor ancora a janela em Resolved + 8s e Node preserva o callback", () => {',
    'test("BUG-046/049: executor ancora a janela em Resolved + 8.5s e Node preserva o callback", () => {',
    'nome teste 8.5s'
)
replace_once(
    'robo-bacbo/support/pure-logic-suite.js',
    'assert.match(executorPythonSource, /alvo_temporal = resolved_base \\+ 8\\.0/);',
    'assert.match(executorPythonSource, /alvo_temporal = resolved_base \\+ 8\\.5/);',
    'regex 8.5s'
)
replace_once(
    'robo-sync-pilot/tests/test_pure_logic.py',
    'self.assertIn("permaneceu inalterado", resultado["motivo"])',
    'self.assertIn("não sofreu débito adicional", resultado["motivo"])',
    'mensagem saldo por perna'
)

# A validação geral deve funcionar até em trader desligado legado; política Tie completa
# só é obrigatória quando o motor será ativado.
p = Path('robo-bacbo/bot2_coletor.js')
text = p.read_text(encoding='utf-8')
old = "    const politicaEmpate = validarPoliticaProtecao(cf);\n    if (!politicaEmpate.ok) return { ok: false, motivo: politicaEmpate.motivo };\n\n"
if text.count(old) != 1:
    raise RuntimeError(f'validator tie unconditional: esperado 1, encontrado {text.count(old)}')
text = text.replace(old, '', 1)
old_block = "        const validacaoConfig = validarConfigAutoTrader(config || {});\n        if (!validacaoConfig.ok) {\n            return res.status(400).json({\n                sucesso: false,\n                erro: 'config_auto_trader_invalida',\n                mensagem: validacaoConfig.motivo\n            });\n        }"
new_block = old_block + "\n        if (novoAtivo) {\n            const politicaEmpate = validarPoliticaProtecao(config || {});\n            if (!politicaEmpate.ok) {\n                return res.status(400).json({\n                    sucesso: false, erro: 'protecao_empate_invalida', mensagem: politicaEmpate.motivo\n                });\n            }\n        }"
if text.count(old_block) != 2:
    raise RuntimeError(f'validator route blocks: esperado 2, encontrado {text.count(old_block)}')
text = text.replace(old_block, new_block)
p.write_text(text, encoding='utf-8')

print('BUG-051 follow-up aplicado.')
