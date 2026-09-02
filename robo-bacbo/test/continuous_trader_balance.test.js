'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    parseScopedBalance,
    aggregateTraderBalance,
    ContinuousTraderBalanceAggregator
} = require('../continuous_trader_balance');

test('parseia balance_update somente pelo canal scoped da conta', () => {
    const snapshot = parseScopedBalance(
        'auto_trader_responses:4:bacbo_int',
        JSON.stringify({ action: 'balance_update', balance: 27.345 }),
        1000
    );

    assert.deepEqual(snapshot, {
        account_id: 4,
        table_key: 'bacbo_int',
        balance: 27.35,
        updated_at: 1000
    });
    assert.equal(parseScopedBalance('auto_trader_responses', '{"action":"balance_update","balance":10}', 1000), null);
    assert.equal(parseScopedBalance('auto_trader_responses:4:bacbo_int', '{"action":"other","balance":10}', 1000), null);
});

test('agrega matematicamente apenas as contas vinculadas ao trader', () => {
    const snapshots = new Map([
        [1, { account_id: 1, balance: 15.10, updated_at: 1000 }],
        [4, { account_id: 4, balance: 20.20, updated_at: 1000 }],
        [7, { account_id: 7, balance: 999.99, updated_at: 1000 }]
    ]);

    const result = aggregateTraderBalance(
        { config_json: JSON.stringify({ account_ids: [1, 4] }) },
        snapshots,
        { now: 1500, freshnessMs: 5000 }
    );

    assert.equal(result.complete, true);
    assert.equal(result.total, 35.30);
    assert.deepEqual(result.account_ids, [1, 4]);
    assert.deepEqual(result.accounts.map(item => item.account_id), [1, 4]);
});

test('nao publica agregado parcial quando uma conta vinculada esta ausente ou vencida', () => {
    const missing = aggregateTraderBalance(
        { config_json: JSON.stringify({ account_ids: [1, 4] }) },
        new Map([[1, { account_id: 1, balance: 15, updated_at: 1000 }]]),
        { now: 1500, freshnessMs: 5000 }
    );
    assert.equal(missing.complete, false);
    assert.equal(missing.reason, 'MISSING_ACCOUNT_BALANCE');
    assert.equal(missing.missing_account_id, 4);

    const stale = aggregateTraderBalance(
        { config_json: JSON.stringify({ account_ids: [1, 4] }) },
        new Map([
            [1, { account_id: 1, balance: 15, updated_at: 1000 }],
            [4, { account_id: 4, balance: 20, updated_at: 1000 }]
        ]),
        { now: 7001, freshnessMs: 5000 }
    );
    assert.equal(stale.complete, false);
    assert.equal(stale.reason, 'STALE_ACCOUNT_BALANCE');
});

test('atualizacao de uma conta afeta somente traders vinculados a ela', async () => {
    const writes = [];
    const dbPool = {
        async query(sql, params) {
            if (/SELECT id, ativo, config_json, saldo_atual/.test(sql)) {
                return [[
                    { id: 9, ativo: 1, config_json: JSON.stringify({ account_ids: [1, 4] }), saldo_atual: 0 },
                    { id: 10, ativo: 1, config_json: JSON.stringify({ account_ids: [7] }), saldo_atual: 0 }
                ]];
            }
            if (/UPDATE auto_traders/.test(sql)) {
                writes.push({ sql, params });
                return [{ affectedRows: 1 }];
            }
            throw new Error(`SQL inesperado: ${sql}`);
        }
    };
    const aggregator = new ContinuousTraderBalanceAggregator({
        dbPool,
        mesaId: 2,
        tableKey: 'bacbo_int',
        freshnessMs: 5000,
        now: () => 2000,
        log: { log() {} }
    });

    await aggregator.record({ account_id: 1, table_key: 'bacbo_int', balance: 10, updated_at: 1500 });
    assert.equal(writes.length, 0);

    const updates = await aggregator.record({ account_id: 4, table_key: 'bacbo_int', balance: 25, updated_at: 1600 });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].params[0], 35);
    assert.equal(writes[0].params[1], 9);
    assert.equal(writes[0].params[2], 2);
    assert.deepEqual(updates, [{ trader_id: 9, balance: 35, account_ids: [1, 4] }]);
    assert.equal(writes.some(item => item.params[1] === 10), false);
});

test('contrato instala agregador antes do bot2 e bloqueia saldo global legado', () => {
    const root = path.join(__dirname, '..');
    const start = fs.readFileSync(path.join(root, 'start.js'), 'utf8');
    const moduleSource = fs.readFileSync(path.join(root, 'continuous_trader_balance.js'), 'utf8');

    assert.match(start, /await installContinuousTraderBalance\(\);/);
    assert.ok(start.indexOf('await installContinuousTraderBalance();') < start.indexOf("require('./bot2_coletor');"));
    assert.match(moduleSource, /path === '\/receber-sinal'/);
    assert.match(moduleSource, /delete req\.body\.saldo_atual/);
    assert.match(moduleSource, /UPDATE auto_traders[\s\S]*SET saldo_atual=\?[\s\S]*WHERE id=\?[\s\S]*AND mesa_id=\?[\s\S]*AND ativo=true/);
    assert.doesNotMatch(moduleSource, /SET saldo_atual=\?[\s\S]*WHERE ativo=true/);
});
