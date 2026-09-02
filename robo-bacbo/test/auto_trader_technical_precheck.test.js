'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    avaliarPrecheckTecnicoPlano
} = require('../auto_trader_round_arbiter');

const root = path.resolve(__dirname, '..');

test('precheck rejeita exposição acima do cap por bridge', () => {
    const result = avaliarPrecheckTecnicoPlano(
        {
            ok: true,
            exposicao_etapa: 15
        },
        {
            global_router_cap: 20,
            per_bridge_cap: 5
        }
    );

    assert.deepEqual(result, {
        permitido: false,
        motivo: 'PER_BRIDGE_EXPOSURE_LIMIT_EXCEEDED',
        exposicao: 15,
        per_bridge_cap: 5
    });
});

test('precheck permite exposição igual ou inferior ao cap por bridge', () => {
    assert.equal(
        avaliarPrecheckTecnicoPlano(
            { ok: true, exposicao_etapa: 5 },
            { per_bridge_cap: 5 }
        ).permitido,
        true
    );

    assert.equal(
        avaliarPrecheckTecnicoPlano(
            { ok: true, exposicao_etapa: 2.5 },
            { per_bridge_cap: 5 }
        ).permitido,
        true
    );
});

test('precheck falha fechado com exposição ou cap técnico inválido', () => {
    assert.equal(
        avaliarPrecheckTecnicoPlano(
            { ok: true, exposicao_etapa: 0 },
            { per_bridge_cap: 5 }
        ).motivo,
        'EXPOSICAO_TECNICA_INVALIDA'
    );

    assert.equal(
        avaliarPrecheckTecnicoPlano(
            { ok: true, exposicao_etapa: 5 },
            { per_bridge_cap: 0 }
        ).motivo,
        'TECHNICAL_PER_BRIDGE_CAP_INVALID'
    );
});

test('MC21 executa precheck antes de saldo, intenção e Router', () => {
    const source = fs.readFileSync(
        path.join(root, 'auto_trader_round_arbiter.js'),
        'utf8'
    );

    const planoIndex = source.indexOf(
        'const planoDireto = deps.calcularPlanoAposta'
    );

    const precheckIndex = source.indexOf(
        'const precheckTecnico = avaliarPrecheckTecnicoPlano'
    );

    const balanceGateIndex = source.indexOf(
        'deps.autorizarNovaEntradaFinanceiraTrader(trader)'
    );

    const intentIndex = source.indexOf(
        'deps.criarIntencaoOrdem(conexaoIntencao'
    );

    const routerIndex = source.indexOf(
        'deps.enviarOrdemAoExecutor('
    );

    assert.ok(planoIndex >= 0);
    assert.ok(precheckIndex > planoIndex);
    assert.ok(balanceGateIndex > precheckIndex);
    assert.ok(intentIndex > precheckIndex);
    assert.ok(routerIndex > intentIndex);

    assert.match(
        source,
        /MC21 TECHNICAL PRECHECK[\s\S]*ZERO intenção, ZERO Router/
    );
});
