'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    avaliarLimitesFinanceirosTrader,
    ScopedTraderBalanceAuthorization
} = require('../multi_account_financial_authorization');

function fakeDb() {
    return {
        async query() { return [[], []]; }
    };
}

test('agrega somente contas vinculadas do Trader para autorizar saldo', () => {
    const auth = new ScopedTraderBalanceAuthorization({
        dbPool: fakeDb(),
        tableKey: 'bacbo_br',
        freshnessMs: 90000,
        log: { log() {}, warn() {}, error() {} }
    });
    const now = 1_000_000;
    auth.record('auto_trader_responses:1:bacbo_br', JSON.stringify({ action: 'balance_update', balance: 15.10 }), now);
    auth.record('auto_trader_responses:4:bacbo_br', JSON.stringify({ action: 'balance_update', balance: 20.20 }), now);
    auth.record('auto_trader_responses:7:bacbo_br', JSON.stringify({ action: 'balance_update', balance: 999.99 }), now);

    const snapshot = auth.snapshotForTrader({ config: { account_ids: [1, 4] } }, now + 1000);
    assert.equal(snapshot.fresco, true);
    assert.equal(snapshot.saldo_atual, 35.30);
    assert.deepEqual([...snapshot.account_ids], [1, 4]);
});

test('fail-closed se faltar saldo fresco de uma conta vinculada', () => {
    const auth = new ScopedTraderBalanceAuthorization({
        dbPool: fakeDb(),
        tableKey: 'bacbo_int',
        freshnessMs: 90000,
        log: { log() {}, warn() {}, error() {} }
    });
    const now = 2_000_000;
    auth.record('auto_trader_responses:1:bacbo_int', JSON.stringify({ action: 'balance_update', balance: 10 }), now);
    const snapshot = auth.snapshotForTrader({ config: { account_ids: [1, 4] } }, now + 1000);
    assert.equal(snapshot.fresco, false);
    assert.equal(snapshot.motivo, 'MISSING_ACCOUNT_BALANCE');
});

test('refresh de saldo stale publica somente nas contas vinculadas e reaproveita snapshots frescos', async () => {
    const auth = new ScopedTraderBalanceAuthorization({
        dbPool: fakeDb(),
        tableKey: 'bacbo_br',
        freshnessMs: 10,
        log: { log() {}, warn() {}, error() {} }
    });
    const trader = { id: 18, config: { account_ids: [1, 4] } };
    const published = [];
    auth.subscriber = { isReady: true };
    auth.publisher = {
        isReady: true,
        async publish(channel, payload) {
            published.push({ channel, payload: JSON.parse(payload) });
            const accountId = Number(channel.split(':')[1]);
            auth.record(channel.replace('commands', 'responses'), JSON.stringify({ action: 'balance_update', balance: 15 }));
            assert.ok([1, 4].includes(accountId));
        }
    };

    auth.record('auto_trader_responses:1:bacbo_br', JSON.stringify({ action: 'balance_update', balance: 1 }), Date.now() - 1000);
    auth.record('auto_trader_responses:4:bacbo_br', JSON.stringify({ action: 'balance_update', balance: 1 }), Date.now() - 1000);

    const refreshed = await auth.refreshTraderBalance(trader);
    assert.equal(refreshed.fresco, true);
    assert.equal(refreshed.saldo_atual, 30);
    assert.deepEqual(published.map(item => item.channel).sort(), [
        'auto_trader_commands:1:bacbo_br',
        'auto_trader_commands:4:bacbo_br'
    ]);
    assert.ok(published.every(item => item.payload.action === 'sync_balance'));
});

test('preserva Stop Win, Stop Loss e saldo valido no gate scoped', () => {
    const base = {
        saldo_inicial: 100,
        trailing_pico_lucro: 0,
        config: { stop_win: 20, stop_loss: 30, trailing_stop: false }
    };
    assert.equal(avaliarLimitesFinanceirosTrader(base, 110).permitido, true);
    assert.equal(avaliarLimitesFinanceirosTrader(base, 120).motivo, 'STOP_WIN');
    assert.equal(avaliarLimitesFinanceirosTrader(base, 70).motivo, 'STOP_LOSS');
});

test('falta de stop_loss rejeita politica em vez de assumir fallback', () => {
    const result = avaliarLimitesFinanceirosTrader({
        saldo_inicial: 100,
        trailing_pico_lucro: 0,
        config: { stop_win: 20, trailing_stop: false }
    }, 100);

    assert.equal(result.permitido, false);
    assert.equal(result.motivo, 'INVALID_RISK_POLICY');
    assert.equal(result.invalid_field, 'stop_loss');
});

test('fonte multi-conta nao contem fallback magico de stop', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'multi_account_financial_authorization.js'), 'utf8');
    assert.doesNotMatch(source, /stop_loss\s*\?\?\s*250/);
    assert.doesNotMatch(source, /stop_win\s*\?\?\s*100/);
    assert.match(source, /resolveRiskPolicy/);
    assert.match(source, /INVALID_RISK_POLICY/);
});

test('bootstrap instala autorizador scoped antes do bot2', () => {
    const start = fs.readFileSync(path.join(__dirname, '..', 'start.js'), 'utf8');
    const requireIndex = start.indexOf("require('./multi_account_financial_authorization')");
    const installIndex = start.indexOf('.installMultiAccountFinancialAuthorization()', requireIndex);
    const botIndex = start.indexOf("require('./bot2_coletor')");
    assert.ok(requireIndex >= 0);
    assert.ok(installIndex > requireIndex);
    assert.ok(botIndex > installIndex);
});

test('Signal Router permanece travado em dry-run', () => {
    const launcher = fs.readFileSync(path.join(__dirname, '..', '..', 'atalhos', '07_SIGNAL_ROUTER.cmd'), 'utf8');
    assert.match(launcher, /SIGNAL_ROUTER_FINANCIAL_DRY_RUN=true/i);
    assert.doesNotMatch(launcher, /SIGNAL_ROUTER_FINANCIAL_DRY_RUN=false/i);
});
