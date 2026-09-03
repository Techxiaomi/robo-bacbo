'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    markerFor,
    profile,
} = require('../scripts/analyze_live_bridge_startup');

test('startup profiler recognizes non-financial bootstrap stages', () => {
    assert.equal(markerFor('BRASIL_DA_SORTE_STAGE=HOME'), 'HOME_STAGE');
    assert.equal(markerFor('BRASIL_DA_SORTE_LOGIN_CONFIRMED=true'), 'LOGIN_CONFIRMED');
    assert.equal(markerFor('BRASIL_DA_SORTE_GAME_NAVIGATED_URL=https://example.test/game'), 'GAME_NAVIGATED');
    assert.equal(markerFor('BRASIL_DA_SORTE_PLAY_TRIGGERED=true'), 'PLAY_TRIGGERED');
    assert.equal(markerFor('LIVE_BRIDGE_READY=true'), 'BRIDGE_READY');
    assert.equal(markerFor('LIVE_BRIDGE_ORDER_EXPOSURE=10.00'), null);
    assert.equal(markerFor('place_bet'), null);
});

test('startup profiler computes monotonic deltas for one bridge pid', () => {
    const base = Date.parse('2026-09-03T11:40:50.000Z');
    const records = [
        ['SESSION_ID=account-4:bacbo_int', 0],
        ['LIVE_BRIDGE_PYTHON_FAULTHANDLER=true', 20],
        ['=== LIVE BRIDGE CONTROLLED ===', 80],
        ['BRASIL_DA_SORTE_STAGE=HOME', 200],
        ['BRASIL_DA_SORTE_LOGIN_TRIGGERED=true', 1200],
        ['BRASIL_DA_SORTE_LOGIN_CONFIRMED=true', 3200],
        ['BRASIL_DA_SORTE_STAGE=GAME_URL', 3300],
        ['BRASIL_DA_SORTE_GAME_NAVIGATED_URL=https://example.test/game', 4800],
        ['BRASIL_DA_SORTE_PLAY_TRIGGERED=true', 7200],
        ['LIVE_BRIDGE_CONTEXT_ISOLATED=account-4:bacbo_int', 7300],
        ['LIVE_BRIDGE_ADAPTER_PAGE_READY=true', 7350],
        ['LIVE_BRIDGE_READY=true', 7400],
    ].map(([message, offset]) => ({
        timestamp: new Date(base + offset).toISOString(),
        pid: 1234,
        message,
    }));

    const rows = profile(records, {
        sessionId: 'account-4:bacbo_int',
        pid: 1234,
        startMs: base,
        endMs: Number.POSITIVE_INFINITY,
    });

    const ready = rows.find(row => row.stage === 'BRIDGE_READY');
    const loginConfirmed = rows.find(row => row.stage === 'LOGIN_CONFIRMED');
    assert.equal(ready.elapsed_ms, 7400);
    assert.equal(loginConfirmed.elapsed_ms, 3200);
    assert.ok(rows.every(row => row.delta_ms >= 0));
});

test('startup profiler ignores other bridge pids', () => {
    const base = Date.parse('2026-09-03T11:40:50.000Z');
    const records = [
        { timestamp: new Date(base).toISOString(), pid: 10, message: 'SESSION_ID=account-1:bacbo_int' },
        { timestamp: new Date(base + 100).toISOString(), pid: 11, message: 'BRASIL_DA_SORTE_STAGE=HOME' },
        { timestamp: new Date(base + 200).toISOString(), pid: 10, message: 'LIVE_BRIDGE_READY=true' },
    ];

    const rows = profile(records, {
        sessionId: 'account-1:bacbo_int',
        pid: 10,
        startMs: base,
        endMs: Number.POSITIVE_INFINITY,
    });

    assert.deepEqual(rows.map(row => row.stage), ['SESSION_START', 'BRIDGE_READY']);
});
