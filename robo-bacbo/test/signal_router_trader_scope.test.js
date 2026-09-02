'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    filterTargetsByAccountIds,
    FinancialTraderScopeResolver
} = require('../signal_router_trader_scope');

function financialSignal(overrides = {}) {
    return {
        signal_id: '550e8400-e29b-41d4-a716-446655440000',
        action: 'place_bet',
        table_key: 'bacbo_int',
        exposure_cents: 500,
        ...overrides
    };
}

function operatingTrader(config = { account_ids: [4, 1, 4] }) {
    return {
        trader_id: 9,
        config_json: JSON.stringify({ stop_loss: 250, ...config }),
        saldo_inicial: 100,
        saldo_atual: 100,
        ativo: 1,
        status_operacao: 'OPERANDO',
        table_key: 'bacbo_int'
    };
}

test('resolve trader scope from authoritative audit order and config account_ids', async () => {
    const calls = [];
    const dbPool = {
        async query(sql, params) {
            calls.push({ sql, params });
            if (/auditoria_ordens/.test(sql)) return [[operatingTrader()]];
            if (/betting_house_tables/.test(sql)) return [[{ account_id: 1 }, { account_id: 4 }]];
            throw new Error('unexpected query');
        }
    };

    const resolver = new FinancialTraderScopeResolver({ dbPool });
    const scope = await resolver.resolve(financialSignal());

    assert.equal(scope.trader_id, 9);
    assert.equal(scope.table_key, 'bacbo_int');
    assert.deepEqual(scope.account_ids, [1, 4]);
    assert.equal(scope.risk.approved, true);
    assert.equal(scope.risk.aggregate_exposure, 10);
    assert.equal(calls.length, 2);
    assert.match(calls[0].sql, /auditoria_ordens/);
    assert.match(calls[0].sql, /executor_order_id/);
    assert.deepEqual(calls[0].params, [
        '550e8400-e29b-41d4-a716-446655440000',
        'bacbo_int'
    ]);
});

test('resolver uses legacy junction only when config has no account_ids', async () => {
    let call = 0;
    const dbPool = {
        async query(sql, params) {
            call += 1;
            if (call === 1) return [[operatingTrader({})]];
            if (call === 2) {
                assert.match(sql, /auto_trader_account_bindings/);
                assert.deepEqual(params, [9]);
                return [[{ account_id: 4 }, { account_id: 1 }]];
            }
            assert.match(sql, /betting_house_tables/);
            return [[{ account_id: 1 }, { account_id: 4 }]];
        }
    };

    const resolver = new FinancialTraderScopeResolver({ dbPool });
    const scope = await resolver.resolve(financialSignal());
    assert.deepEqual(scope.account_ids, [1, 4]);
    assert.equal(call, 3);
});

test('financial scope fails closed when trader is not operating', async () => {
    const dbPool = {
        async query() {
            return [[{
                ...operatingTrader({ account_ids: [1] }),
                ativo: 0,
                status_operacao: 'DESLIGADO'
            }]];
        }
    };

    const resolver = new FinancialTraderScopeResolver({ dbPool });
    await assert.rejects(
        () => resolver.resolve(financialSignal()),
        /SIGNAL_ROUTER_TRADER_SCOPE_TRADER_NOT_OPERATING/
    );
});

test('fanout filter ignores every online target outside trader binding', () => {
    const targets = [
        { account_id: 1, command_channel: 'auto_trader_commands:1:bacbo_int' },
        { account_id: 4, command_channel: 'auto_trader_commands:4:bacbo_int' },
        { account_id: 7, command_channel: 'auto_trader_commands:7:bacbo_int' }
    ];

    const filtered = filterTargetsByAccountIds(targets, [4, 1]);
    assert.deepEqual(filtered.map(item => item.account_id), [1, 4]);
    assert.equal(filtered.some(item => item.account_id === 7), false);
});

test('router source applies trader scope before online discovery and launcher keeps dry run locked', () => {
    const routerSource = fs.readFileSync(
        path.join(__dirname, '..', 'scripts', 'signal_router.js'),
        'utf8'
    );
    const launcherSource = fs.readFileSync(
        path.join(__dirname, '..', '..', 'atalhos', '07_SIGNAL_ROUTER.cmd'),
        'utf8'
    );

    const scopeIndex = routerSource.indexOf('traderScopeResolver.resolve(signal)');
    const filterIndex = routerSource.indexOf('filterTargetsByAccountIds(targets, traderScope.account_ids)');
    const onlineIndex = routerSource.indexOf('resolveOnlineTargets(publisher, targets)');

    assert.ok(scopeIndex >= 0, 'trader scope resolver must be present');
    assert.ok(filterIndex > scopeIndex, 'binding/risk scope must run before target filtering');
    assert.ok(onlineIndex > filterIndex, 'online discovery must inspect only already-bound targets');
    assert.match(routerSource, /SIGNAL_ROUTER_TRADER_SCOPE_REJECTED/);
    assert.match(routerSource, /ignored_unbound=/);
    assert.match(launcherSource, /SIGNAL_ROUTER_FINANCIAL_DRY_RUN=true/);
    assert.doesNotMatch(launcherSource, /SIGNAL_ROUTER_FINANCIAL_DRY_RUN=false/);
});
