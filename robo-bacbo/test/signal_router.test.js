'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeSignal,
    buildTargetIndex,
    commandForTarget,
    SignalDedup
} = require('../scripts/signal_router');

test('normaliza sync_balance global para uma mesa', () => {
    const signal = normalizeSignal(JSON.stringify({
        signal_id: 'sync-001',
        action: 'sync_balance',
        table: 'BACBO_BR'
    }));

    assert.deepEqual(signal, {
        signal_id: 'sync-001',
        action: 'sync_balance',
        table_key: 'bacbo_br'
    });
});

test('bloqueia fan-out financeiro nesta etapa', () => {
    assert.throws(
        () => normalizeSignal(JSON.stringify({
            signal_id: 'bet-001',
            action: 'place_bet',
            table_key: 'bacbo_br'
        })),
        /SIGNAL_ROUTER_FINANCIAL_ACTION_BLOCKED/
    );
});

test('indexa somente contas e mesas habilitadas', () => {
    const index = buildTargetIndex([
        {
            id: 4,
            name: 'Conta 4',
            enabled: true,
            tables: [
                { table_key: 'bacbo_br', display_name: 'Bac Bo BR', enabled: true },
                { table_key: 'bacbo_int', display_name: 'Bac Bo INT', enabled: false }
            ]
        },
        {
            id: 1,
            name: 'Conta 1',
            enabled: true,
            tables: [
                { table_key: 'bacbo_br', display_name: 'Bac Bo BR', enabled: true }
            ]
        },
        {
            id: 9,
            name: 'Conta 9',
            enabled: false,
            tables: [
                { table_key: 'bacbo_br', display_name: 'Bac Bo BR', enabled: true }
            ]
        }
    ]);

    assert.equal(index.get('bacbo_br').length, 2);
    assert.deepEqual(
        index.get('bacbo_br').map(item => item.account_id),
        [1, 4]
    );
    assert.equal(index.has('bacbo_int'), false);
});

test('gera comando individualizado por sessao', () => {
    const signal = Object.freeze({
        signal_id: 'sync-002',
        action: 'sync_balance',
        table_key: 'bacbo_br'
    });
    const target = {
        account_id: 4,
        session_id: 'account-4:bacbo_br',
        table_key: 'bacbo_br'
    };

    assert.deepEqual(commandForTarget(signal, target), {
        action: 'sync_balance',
        router_signal_id: 'sync-002',
        routed_account_id: 4,
        routed_session_id: 'account-4:bacbo_br',
        routed_table_key: 'bacbo_br'
    });
});

test('dedup rejeita repeticao do mesmo signal_id dentro do TTL', () => {
    const dedup = new SignalDedup(60000);
    assert.equal(dedup.seen('sync-003'), false);
    assert.equal(dedup.seen('sync-003'), true);
    assert.equal(dedup.seen('sync-004'), false);
});
