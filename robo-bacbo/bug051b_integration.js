"use strict";

const fs = require('fs');
const path = require('path');

const basePath = path.join(__dirname, 'bug051b_integration.phase0.js');
let source = fs.readFileSync(basePath, 'utf8');

function replaceExactly(label, before, after) {
    const first = source.indexOf(before);
    if (first < 0) throw new Error(`SIGNAL-CYCLE-01: trecho ausente em integração: ${label}`);
    if (source.indexOf(before, first + before.length) >= 0) {
        throw new Error(`SIGNAL-CYCLE-01: trecho duplicado/ambíguo em integração: ${label}`);
    }
    source = source.slice(0, first) + after + source.slice(first + before.length);
}

replaceExactly(
    'ultimo coletor seq no snapshot publico',
`    return {
        pronto: true,
        orientacao: estadoCanonicoEvolution.orientacao,
        history,
        coletor_sessao: estadoCanonicoEvolution.coletor_sessao,
        atualizado_em: estadoCanonicoEvolution.atualizado_em
    };`,
`    return {
        pronto: true,
        orientacao: estadoCanonicoEvolution.orientacao,
        history,
        coletor_sessao: estadoCanonicoEvolution.coletor_sessao,
        ultimo_coletor_seq: estadoCanonicoEvolution.ultimo_coletor_seq,
        atualizado_em: estadoCanonicoEvolution.atualizado_em
    };`
);

replaceExactly(
    'callback recovery apos road',
`    const reconciliacao = await enfileirarReconciliacaoRoad(
        () => reconciliarSnapshotComLedger(dados, historyNormalizado)
    );
    res.status(200).json({`,
`    const reconciliacao = await enfileirarReconciliacaoRoad(
        () => reconciliarSnapshotComLedger(dados, historyNormalizado)
    );

    if (
        estadoCanonicoEvolution.pronto === true
        && typeof global.__signalCycleRecoveryFromRoad === 'function'
    ) {
        const snapshotRecuperacao = obterHistoricoCanonicoLive();
        Promise.resolve(global.__signalCycleRecoveryFromRoad(snapshotRecuperacao)).catch(erroRecuperacao => {
            console.error(
                `❌ SIGNAL CYCLE | recuperação pós-ROAD falhou: ${String(erroRecuperacao?.message || erroRecuperacao)}`
            );
        });
    }

    res.status(200).json({`
);

module._compile(source, __filename);
