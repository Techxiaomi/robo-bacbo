'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    FinancialTraderScopeResolver,
    filterTargetsByAccountIds
} = require('../signal_router_trader_scope');

function signal(tableKey, signalId) {
    return {
        signal_id: signalId,
        action: 'place_bet',
        table_key: tableKey,
        alvo: 'PlayerWon',
        valor: 5,
        apostas: null,
        exposure_cents: 500
    };
}

function traderRow(tableKey) {
    return {
        trader_id: 900,
        audit_alvo: 'PlayerWon',
        audit_risco_total: 5,
        audit_valor_entrada: 5,
        audit_valor_empate: 0,
        audit_status_ordem: 'PREPARANDO',
        config_json: JSON.stringify({
            stop_loss: 250,
            stop_win: 100,
            account_ids: [1, 4, 7]
        }),
        saldo_inicial: 100,
        saldo_atual: 100,
        ativo: 1,
        status_operacao: 'OPERANDO',
        table_key: tableKey
    };
}

function systemConfigResult(sql) {
    if (/CREATE TABLE IF NOT EXISTS system_configs/.test(sql)) return [{ affectedRows: 0 }];
    if (/INSERT IGNORE INTO system_configs/.test(sql)) return [{ affectedRows: 0 }];
    if (/SELECT config_key, config_value/.test(sql)) {
        return [[
            { config_key: 'global_router_cap', config_value: '100.00' },
            { config_key: 'per_bridge_cap', config_value: '10.00' },
            { config_key: 'financial_dry_run', config_value: 'true' }
        ]];
    }
    return null;
}

function resolverFor({ tableKey, eligibleAccountIds, calls }) {
    const dbPool = {
        async query(sql, params) {
            calls.push({ sql, params });

            if (/auditoria_ordens/.test(sql)) {
                assert.deepEqual(params, [
                    tableKey === 'bacbo_int'
                        ? '11111111-1111-4111-8111-111111111111'
                        : '22222222-2222-4222-8222-222222222222',
                    tableKey
                ]);
                return [[traderRow(tableKey)]];
            }

            if (/betting_house_tables/.test(sql)) {
                assert.deepEqual(params, [1, 4, 7, tableKey]);
                return [eligibleAccountIds.map(account_id => ({ account_id }))];
            }

            const config = systemConfigResult(sql);
            if (config) return config;
            throw new Error(`unexpected query: ${sql}`);
        }
    };

    return new FinancialTraderScopeResolver({
        dbPool,
        log: { log() {} }
    });
}

test('etapa 3: BACBO_INT inclui somente contas habilitadas para INT', async () => {
    const calls = [];
    const resolver = resolverFor({
        tableKey: 'bacbo_int',
        eligibleAccountIds: [1, 4],
        calls
    });

    const scope = await resolver.resolve(signal(
        'bacbo_int',
        '11111111-1111-4111-8111-111111111111'
    ));

    assert.equal(scope.table_key, 'bacbo_int');
    assert.deepEqual(scope.account_ids, [1, 4]);
    assert.equal(scope.account_ids.includes(7), false);

    const eligibility = calls.find(item => /betting_house_tables/.test(item.sql));
    assert.ok(eligibility);
    assert.match(eligibility.sql, /LOWER\(ht\.table_key\) = \?/);
    assert.equal(eligibility.params.at(-1), 'bacbo_int');
});

test('etapa 3: BACBO_BR recalcula elegibilidade e nao reutiliza contas da INT', async () => {
    const calls = [];
    const resolver = resolverFor({
        tableKey: 'bacbo_br',
        eligibleAccountIds: [4, 7],
        calls
    });

    const scope = await resolver.resolve(signal(
        'bacbo_br',
        '22222222-2222-4222-8222-222222222222'
    ));

    assert.equal(scope.table_key, 'bacbo_br');
    assert.deepEqual(scope.account_ids, [4, 7]);
    assert.equal(scope.account_ids.includes(1), false);

    const eligibility = calls.find(item => /betting_house_tables/.test(item.sql));
    assert.ok(eligibility);
    assert.equal(eligibility.params.at(-1), 'bacbo_br');
});

test('etapa 3: fanout recebe somente a intersecao entre online e scope da mesa', () => {
    const onlineTargets = [
        { account_id: 1, command_channel: 'auto_trader_commands:1:bacbo_int' },
        { account_id: 4, command_channel: 'auto_trader_commands:4:bacbo_int' },
        { account_id: 7, command_channel: 'auto_trader_commands:7:bacbo_int' }
    ];

    const intTargets = filterTargetsByAccountIds(onlineTargets, [1, 4]);
    const brTargets = filterTargetsByAccountIds(onlineTargets, [4, 7]);

    assert.deepEqual(intTargets.map(item => item.account_id), [1, 4]);
    assert.deepEqual(brTargets.map(item => item.account_id), [4, 7]);
    assert.equal(intTargets.some(item => item.account_id === 7), false);
    assert.equal(brTargets.some(item => item.account_id === 1), false);
});
