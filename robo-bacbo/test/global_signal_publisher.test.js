'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    createStableSignalId,
    buildPlaceBetSignal,
    buildSyncBalanceSignal,
    publishGlobalSignal
} = require('../global_signal_publisher');

test('signal_id e deterministico para a mesma identidade de evento', () => {
    const a = createStableSignalId({ source: 'tipminer', eventId: 'round-123', tableKey: 'bacbo_br' });
    const b = createStableSignalId({ source: 'tipminer', eventId: 'round-123', tableKey: 'bacbo_br' });
    const c = createStableSignalId({ source: 'tipminer', eventId: 'round-124', tableKey: 'bacbo_br' });

    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.match(a, /^sig-[a-f0-9]{40}$/);
});

test('monta place_bet global com identidade obrigatoria do evento', () => {
    const payload = buildPlaceBetSignal({
        source: 'interno',
        event_id: 'strategy-7:round-456',
        table_key: 'BACBO_BR',
        alvo: 'PlayerWon',
        valor_base: 5
    });

    assert.equal(payload.action, 'place_bet');
    assert.equal(payload.table_key, 'bacbo_br');
    assert.equal(payload.alvo, 'PlayerWon');
    assert.equal(payload.valor_base, 5);
    assert.match(payload.signal_id, /^sig-[a-f0-9]{40}$/);
});

test('monta sync_balance global no mesmo contrato', () => {
    const payload = buildSyncBalanceSignal({
        source: 'manual-test',
        event_id: 'sync-1',
        table_key: 'bacbo_br'
    });

    assert.equal(payload.action, 'sync_balance');
    assert.equal(payload.table_key, 'bacbo_br');
    assert.match(payload.signal_id, /^sig-[a-f0-9]{40}$/);
});

test('publicador usa canal global e retorna subscribers', async () => {
    const calls = [];
    const client = {
        async publish(channel, body) {
            calls.push({ channel, body: JSON.parse(body) });
            return 1;
        }
    };
    const payload = buildSyncBalanceSignal({
        source: 'manual-test',
        event_id: 'sync-2',
        table_key: 'bacbo_br'
    });

    const result = await publishGlobalSignal(payload, { client, channel: 'global_signals' });
    assert.equal(result.subscribers, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].channel, 'global_signals');
    assert.equal(calls[0].body.signal_id, payload.signal_id);
});
