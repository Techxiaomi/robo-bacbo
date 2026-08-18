from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / 'robo-bacbo' / 'bot2_coletor.js'

fonte = BACKEND.read_text(encoding='utf-8')

antiga = '''async function calcularAssertividadePersistidaEstrategia(est) {
    const [baselineRows] = await dbPool.query(
        'SELECT green_direto, gale1, gale2, red, ties_json FROM estrategias WHERE id=? LIMIT 1',
        [est.id]
    );

    if (baselineRows.length === 0) return 0;

    const base = baselineRows[0];
    let greens = (Number(base.green_direto) || 0)
        + (Number(base.gale1) || 0)
        + (Number(base.gale2) || 0)
        + contarTiesLegados(base.ties_json);
    let reds = Number(base.red) || 0;

    const [historicoRows] = await dbPool.query(
        `SELECT tipo_resultado, COUNT(*) AS qtd
         FROM historico_resultados
         WHERE estrategia_id=?
         GROUP BY tipo_resultado`,
        [est.id]
    );

    for (const row of historicoRows) {
        const qtd = Number(row.qtd) || 0;
        if (row.tipo_resultado === 'GREEN' || row.tipo_resultado === 'TIE') greens += qtd;
        else if (row.tipo_resultado === 'RED') reds += qtd;
    }

    const total = greens + reds;
    return total > 0 ? (greens / total) * 100 : 0;
}
'''

nova = '''async function calcularAssertividadePersistidaEstrategia(est) {
    // Estratégias IA são avaliadas pela mesma janela bruta usada pelo robô proprietário.
    // Isso evita iniciar em 0% e também evita duplicar a amostra minerada nos contadores live.
    if (est && est.is_dinamico) {
        const roboDono = ROBOS_MEMORIA.find(
            robo => Number(robo.id) === Number(est.robo_dono_id)
        );
        const rangeConfig = Number(roboDono?.config?.auto_tuning?.range);
        const rangeDinamico = Number.isFinite(rangeConfig)
            ? Math.max(100, Math.min(10000, Math.trunc(rangeConfig)))
            : 1000;
        const dadosDinamicos = historicoGirosAnalitico.slice(-rangeDinamico);
        const detalhes = calcularDetalhesPadraoNoHistorico(
            est,
            dadosDinamicos,
            Date.now()
        ).geral;
        const greens = (Number(detalhes.green_direto) || 0)
            + (Number(detalhes.gale1) || 0)
            + (Number(detalhes.gale2) || 0)
            + contarTiesLegados(detalhes.ties);
        const reds = Number(detalhes.red) || 0;
        const total = greens + reds;
        return total > 0 ? (greens / total) * 100 : 0;
    }

    const [baselineRows] = await dbPool.query(
        'SELECT green_direto, gale1, gale2, red, ties_json FROM estrategias WHERE id=? LIMIT 1',
        [est.id]
    );

    if (baselineRows.length === 0) return 0;

    const base = baselineRows[0];
    let greens = (Number(base.green_direto) || 0)
        + (Number(base.gale1) || 0)
        + (Number(base.gale2) || 0)
        + contarTiesLegados(base.ties_json);
    let reds = Number(base.red) || 0;

    const [historicoRows] = await dbPool.query(
        `SELECT tipo_resultado, COUNT(*) AS qtd
         FROM historico_resultados
         WHERE estrategia_id=?
         GROUP BY tipo_resultado`,
        [est.id]
    );

    for (const row of historicoRows) {
        const qtd = Number(row.qtd) || 0;
        if (row.tipo_resultado === 'GREEN' || row.tipo_resultado === 'TIE') greens += qtd;
        else if (row.tipo_resultado === 'RED') reds += qtd;
    }

    const total = greens + reds;
    return total > 0 ? (greens / total) * 100 : 0;
}
'''

quantidade = fonte.count(antiga)
if quantidade != 1:
    raise RuntimeError(f'Esperava uma função antiga exata; encontrado {quantidade}')

BACKEND.write_text(fonte.replace(antiga, nova, 1), encoding='utf-8')
print('Assertividade dinâmica do Auto Pilot IA aplicada.')
