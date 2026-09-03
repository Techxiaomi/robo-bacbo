'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { avaliarPrecheckTecnicoPlano } = require('../auto_trader_round_arbiter');

test('dry-run permite plano acima do cap tecnico somente para homologacao sem dispatch', () => {
    const plano = { ok: true, exposicao_etapa: 10 };
    const caps = { per_bridge_cap: 5 };

    const result = avaliarPrecheckTecnicoPlano(plano, caps, { financial_dry_run: true });

    assert.equal(result.permitido, true);
    assert.equal(result.dry_run_cap_bypass, true);
    assert.equal(result.motivo, 'DRY_RUN_TECHNICAL_CAP_BYPASS');
    assert.equal(result.exposicao, 10);
    assert.equal(result.per_bridge_cap, 5);
});

test('fora de dry-run plano acima do cap continua fail-closed', () => {
    const plano = { ok: true, exposicao_etapa: 10 };
    const caps = { per_bridge_cap: 5 };

    const result = avaliarPrecheckTecnicoPlano(plano, caps, { financial_dry_run: false });

    assert.equal(result.permitido, false);
    assert.equal(result.dry_run_cap_bypass, false);
    assert.equal(result.motivo, 'PER_BRIDGE_EXPOSURE_LIMIT_EXCEEDED');
});
