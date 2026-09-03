'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    filterTargetsByAccountIds,
    assertSignalMatchesAuditIntent,
    FinancialTraderScopeResolver
} = require('../signal_router_trader_scope');

function financialSignal(overrides = {}) {
    return {
        signal_id: '550e8400-e29b-41d4-a716-446655440000',
        action: 'place_bet',
        table_key: 'bacbo_int',
        alvo: 'PlayerWon',
        valor: 5,
        apostas: null,
        exposure_cents: 500,
        ...overrides
    };
}

function operatingTrader(config = { account_ids: [4, 1, 4] }, overrides = {}) {
    return {
        trader_id: 9,
        audit_alvo: 'PlayerWon',
        audit_risco_total: 5,
        audit_valor_entrada: 5,
        audit_valor_empate: 0,
        audit_status_ordem: 'PREPARANDO',
        config_json: JSON.stringify({ stop_loss: 250, stop_win: 100, ...config }),
        saldo_inicial: 100,
        saldo_atual: 100,
        ativo: 1,
        status_operacao: 'OPERANDO',
        table_key: 'bacbo_int',
        ...overrides
    };
}

function systemConfigResult(sql) {
    if (/CREATE TABLE IF NOT EXISTS system_configs/.test(sql)) return [{ affectedRows: 0 }];
    if (/INSERT IGNORE INTO system_configs/.test(sql)) return [{ affectedRows: 0 }];
    if (/SELECT config_key, config_value/.test(sql)) {
        return [[
            { config_key: 'global_router_cap', config_value: '20.00' },
            { config_key: 'per_bridge_cap', config_value: '5.00' },
            { config_key: 'financial_dry_run', config_value: 'true' }
        ]];
    }
    return null;
}

test('resolve trader scope from authoritative audit order and logs full risk hierarchy', async () => {
    const calls = [];
    const logs = [];
    const dbPool = {
        async query(sql, params) {
            calls.push({ sql, params });
            if (/auditoria_ordens/.test(sql)) return [[operatingTrader()]];
            if (/betting_house_tables/.test(sql)) return [[{ account_id: 1 }, { account_id: 4 }]];
            const systemResult = systemConfigResult(sql);
            if (systemResult) return systemResult;
            throw new Error('unexpected query');
        }
    };

    const resolver = new FinancialTraderScopeResolver({
        dbPool,
        log: { log: message => logs.push(message) }
    });
    const scope = await resolver.resolve(financialSignal());

    assert.equal(scope.trader_id, 9);
    assert.equal(scope.table_key, 'bacbo_int');
    assert.deepEqual(scope.account_ids, [1, 4]);
    assert.equal(scope.risk.approved, true);
    assert.equal(scope.risk.aggregate_exposure, 10);
    assert.equal(scope.risk.trader_limits.stop_loss, 250);
    assert.deepEqual(scope.risk.technical_caps, {
        global_exposure: 20,
        per_bridge_exposure: 5
    });
    assert.match(logs[0], /RISK_POLICY_HIERARCHY/);
    assert.match(logs[0], /trader_stop_loss=250\.00/);
    assert.match(logs[0], /technical_global_cap=20\.00/);
    assert.match(logs[0], /technical_bridge_cap=5\.00/);
    assert.match(logs[0], /config_source=system_configs/);
    assert.match(logs[0], /per_account_exposure=5\.00/);

    const auditCalls = calls.filter(item => /auditoria_ordens/.test(item.sql));
    const eligibilityCalls = calls.filter(item => /betting_house_tables/.test(item.sql));
    const configReads = calls.filter(item => /SELECT config_key, config_value/.test(item.sql));
    assert.equal(auditCalls.length, 1);
    assert.equal(eligibilityCalls.length, 1);
    assert.equal(configReads.length, 1);
    assert.deepEqual(auditCalls[0].params, [
        '550e8400-e29b-41d4-a716-446655440000',
        'bacbo_int'
    ]);
    assert.match(auditCalls[0].sql, /ao\.status_ordem AS audit_status_ordem/);
    assert.match(auditCalls[0].sql, /ao\.risco_total AS audit_risco_total/);
});

test('resolver uses legacy junction only when config has no account_ids', async () => {
    let bindingReads = 0;
    const dbPool = {
        async query(sql, params) {
            if (/auditoria_ordens/.test(sql)) return [[operatingTrader({})]];
            if (/auto_trader_account_bindings/.test(sql)) {
                bindingReads += 1;
                assert.deepEqual(params, [9]);
                return [[{ account_id: 4 }, { account_id: 1 }]];
            }
            if (/betting_house_tables/.test(sql)) return [[{ account_id: 1 }, { account_id: 4 }]];
            const systemResult = systemConfigResult(sql);
            if (systemResult) return systemResult;
            throw new Error('unexpected query');
        }
    };

    const resolver = new FinancialTraderScopeResolver({ dbPool, log: { log() {} } });
    const scope = await resolver.resolve(financialSignal());
    assert.deepEqual(scope.account_ids, [1, 4]);
    assert.equal(bindingReads, 1);
});

test('financial scope rejects replay of order that is no longer PREPARANDO', async () => {
    const dbPool = {
        async query(sql) {
            if (/auditoria_ordens/.test(sql)) {
                return [[operatingTrader({ account_ids: [1] }, { audit_status_ordem: 'FALHA_EXECUCAO' })]];
            }
            throw new Error('unexpected query');
        }
    };

    const resolver = new FinancialTraderScopeResolver({ dbPool, log: { log() {} } });
    await assert.rejects(
        () => resolver.resolve(financialSignal()),
        /SIGNAL_ROUTER_TRADER_SCOPE_ORDER_NOT_PREPARING/
    );
});

test('financial scope rejects payload target different from persisted intent', async () => {
    const dbPool = {
        async query(sql) {
            if (/auditoria_ordens/.test(sql)) return [[operatingTrader({ account_ids: [1] })]];
            throw new Error('unexpected query');
        }
    };

    const resolver = new FinancialTraderScopeResolver({ dbPool, log: { log() {} } });
    await assert.rejects(
        () => resolver.resolve(financialSignal({ alvo: 'BankerWon' })),
        /SIGNAL_ROUTER_TRADER_SCOPE_INTENT_TARGET_MISMATCH/
    );
});

test('financial scope rejects exposure different from persisted intent', async () => {
    const dbPool = {
        async query(sql) {
            if (/auditoria_ordens/.test(sql)) return [[operatingTrader({ account_ids: [1] })]];
            throw new Error('unexpected query');
        }
    };

    const resolver = new FinancialTraderScopeResolver({ dbPool, log: { log() {} } });
    await assert.rejects(
        () => resolver.resolve(financialSignal({ valor: 2.5, exposure_cents: 250 })),
        /SIGNAL_ROUTER_TRADER_SCOPE_INTENT_EXPOSURE_MISMATCH/
    );
});

test('compound financial payload must match principal and Tie legs cent by cent', () => {
    const audit = operatingTrader({ account_ids: [1, 4] }, {
        audit_risco_total: 5,
        audit_valor_entrada: 2.5,
        audit_valor_empate: 2.5
    });
    const valid = financialSignal({
        valor: 5,
        exposure_cents: 500,
        apostas: [
            { alvo: 'PlayerWon', valor: 2.5 },
            { alvo: 'Tie', valor: 2.5 }
        ]
    });
    assert.equal(assertSignalMatchesAuditIntent(valid, audit), true);

    assert.throws(
        () => assertSignalMatchesAuditIntent({
            ...valid,
            apostas: [
                { alvo: 'PlayerWon', valor: 5 }
            ]
        }, audit),
        /SIGNAL_ROUTER_TRADER_SCOPE_INTENT_PLAN_MISMATCH/
    );

    assert.throws(
        () => assertSignalMatchesAuditIntent({
            ...valid,
            apostas: [
                { alvo: 'PlayerWon', valor: 2.5 },
                { alvo: 'Tie', valor: 2 }
            ]
        }, audit),
        /SIGNAL_ROUTER_TRADER_SCOPE_INTENT_PLAN_MISMATCH/
    );
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

    const resolver = new FinancialTraderScopeResolver({ dbPool, log: { log() {} } });
    await assert.rejects(
        () => resolver.resolve(financialSignal()),
        /SIGNAL_ROUTER_TRADER_SCOPE_TRADER_NOT_OPERATING/
    );
});

test('financial scope rejects missing stop_loss as INVALID_RISK_POLICY', async () => {
    const dbPool = {
        async query(sql) {
            if (/auditoria_ordens/.test(sql)) {
                return [[operatingTrader({ stop_loss: undefined, account_ids: [1] })]];
            }
            if (/betting_house_tables/.test(sql)) return [[{ account_id: 1 }]];
            const systemResult = systemConfigResult(sql);
            if (systemResult) return systemResult;
            throw new Error('unexpected query');
        }
    };

    const resolver = new FinancialTraderScopeResolver({ dbPool, log: { log() {} } });
    await assert.rejects(
        () => resolver.resolve(financialSignal()),
        /EXPOSURE_REJECTED reason=INVALID_RISK_POLICY/
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

test('router source applies trader scope before online discovery and launcher delegates safe config to DB runner', () => {
    const routerSource = fs.readFileSync(
        path.join(__dirname, '..', 'scripts', 'signal_router.js'),
        'utf8'
    );
    const launcherSource = fs.readFileSync(
        path.join(__dirname, '..', '..', 'atalhos', '07_SIGNAL_ROUTER.cmd'),
        'utf8'
    );
    const runnerSource = fs.readFileSync(
        path.join(__dirname, '..', 'scripts', 'run_with_system_config.js'),
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
    assert.doesNotMatch(launcherSource, /SIGNAL_ROUTER_FINANCIAL_DRY_RUN=/);
    assert.match(launcherSource, /run_with_system_config\.js scripts\\signal_router\.js/);
    assert.match(runnerSource, /SIGNAL_ROUTER_FINANCIAL_DRY_RUN:\s*'true'/);
});
