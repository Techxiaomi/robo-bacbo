from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / 'robo-bacbo' / 'bot2_coletor.js'
ENGINE = ROOT / 'robo-bacbo' / 'auto_pilot_ia.js'
TEST = ROOT / 'robo-bacbo' / 'test' / 'auto_pilot_lifecycle.test.js'


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: esperado 1 marcador, encontrado {count}')
    return text.replace(old, new, 1)


backend = BACKEND.read_text(encoding='utf-8')
backend = replace_once(
    backend,
    """        await conexao.query(
            'DELETE FROM historico_resultados WHERE estrategia_id LIKE ?',
            [`ia_${roboId}_%`]
        );
""",
    """        const prefixoHistoricoIa = `ia_${roboId}_`;
        await conexao.query(
            'DELETE FROM historico_resultados WHERE LEFT(estrategia_id, ?) = ?',
            [prefixoHistoricoIa.length, prefixoHistoricoIa]
        );
""",
    'prefixo exato do histórico IA',
)
BACKEND.write_text(backend, encoding='utf-8')

engine = ENGINE.read_text(encoding='utf-8')
engine = replace_once(
    engine,
    "            const [mapaLive] = [await historicoLive([id])];\n",
    "            const mapaLive = await historicoLive([id]);\n",
    'leitura direta do histórico live',
)
ENGINE.write_text(engine, encoding='utf-8')

test = TEST.read_text(encoding='utf-8')
test = replace_once(
    test,
    "    assert.match(backend, /DELETE FROM historico_resultados WHERE estrategia_id LIKE/);\n",
    "    assert.match(backend, /DELETE FROM historico_resultados WHERE LEFT\\(estrategia_id, \\?\\) = \\?/);\n",
    'contrato da limpeza exata',
)
TEST.write_text(test, encoding='utf-8')

print('Polimento de histórico IA aplicado.')
