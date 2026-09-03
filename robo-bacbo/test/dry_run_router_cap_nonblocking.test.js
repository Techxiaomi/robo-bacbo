'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildDryRunConsolidated } = require('../scripts/signal_router');

test('dry-run consolidado permanece sem dispatch independentemente do valor simulado', () => {
    const signal = {
        signal_id: '550e8400-e29b-41d4-a716-446655440099',
        action: 'place_bet',
        table_key: 'bacbo_int',
        alvo: 'PlayerWon',
        valor: 10,
        valor_base: 10,
        exposure_cents: 1000
    };
    const targets = [
        { account_id: 1, session_id: 'account-1:bacbo_int', table_key: 'bacbo_int' },
        { account_id: 4, session_id: 'account-4:bacbo_int', table_key: 'bacbo_int' }
    ];

    const result = buildDryRunConsolidated(signal, targets, 123);
    assert.equal(result.dry_run, true);
    assert.equal(result.expected_accounts, 2);
    assert.equal(result.executor_status, 'FALHOU');
    assert.equal(result.confirmacao, null);
    assert.ok(result.accounts.every(item => item.motivo === 'SIGNAL_ROUTER_FINANCIAL_DRY_RUN_NO_DISPATCH'));
});
