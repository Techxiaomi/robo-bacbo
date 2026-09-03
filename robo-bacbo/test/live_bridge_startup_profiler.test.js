'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    markerFor,
    profile,
} = require('../scripts/analyze_live_bridge_startup');
const {
    startupStageForLine,
    createStartupTracker,
} = require('../live_bridge_startup_tracker');

test('startup profiler recognizes non-financial bootstrap stages', () => {
    assert.equal(markerFor('BRASIL_DA_SORTE_STAGE=HOME'), 'HOME_STAGE');
    assert.equal(markerFor('BRASIL_DA_SORTE_LOGIN_CONFIRMED=true'), 'LOGIN_CONFIRMED');
    assert.equal(markerFor('BRASIL_DA_SORTE_GAME_NAVIGATED_URL=https://example.test/game'), 'GAME_NAVIGATED');
    assert.equal(markerFor('BRASIL_DA_SORTE_PLAY_TRIGGERED=true'), 'PLAY_TRIGGERED');
    assert.equal(markerFor('LIVE_BRIDGE_READY=true'), 'BRIDGE_READY');
    assert.equal(markerFor('LIVE_BRIDGE_STARTUP_STAGE=LOGIN_CONFIRMED delta_ms=100 elapsed_ms=500'), 'LOGIN_CONFIRMED');
    assert.equal(markerFor('LIVE_BRIDGE_ORDER_EXPOSURE=10.00'), null);
    assert.equal(markerFor('place_bet'), null);
});

test('startup tracker converts Python stdout stages into structured logs', () => {
    let nowMs = 1000;
    const lines = [];
    const tracker = createStartupTracker({
        now: () => nowMs,
        log: line => lines.push(line),
    });

    nowMs = 1200;
    tracker.observe('=== LIVE BRIDGE CONTROLLED ===');
    nowMs = 1700;
    tracker.observe('BRASIL_DA_SORTE_STAGE=HOME');
    nowMs = 1800;
    tracker.observe('BRASIL_DA_SORTE_STAGE=HOME');
    nowMs = 2500;
    tracker.observe('LIVE_BRIDGE_READY=true');

    assert.deepEqual(lines, [
        'LIVE_BRIDGE_STARTUP_STAGE=PYTHON_SPAWN delta_ms=0 elapsed_ms=0',
        'LIVE_BRIDGE_STARTUP_STAGE=CONTROLLED_BOOT delta_ms=200 elapsed_ms=200',
        'LIVE_BRIDGE_STARTUP_STAGE=HOME_STAGE delta_ms=500 elapsed_ms=700',
        'LIVE_BRIDGE_STARTUP_STAGE=BRIDGE_READY delta_ms=800 elapsed_ms=1500',
    ]);
    assert.equal(startupStageForLine('place_bet'), null);
});

test('startup profiler computes monotonic deltas from structured stages for one bridge pid', () => {
    const base = Date.parse('2026-09-03T11:40:50.000Z');
    const records = [
        ['SESSION_ID=account-4:bacbo_int', 0],
        ['LIVE_BRIDGE_PYTHON_FAULTHANDLER=true', 20],
        ['LIVE_BRIDGE_STARTUP_STAGE=PYTHON_SPAWN delta_ms=0 elapsed_ms=0', 30],
        ['LIVE_BRIDGE_STARTUP_STAGE=CONTROLLED_BOOT delta_ms=50 elapsed_ms=50', 80],
        ['LIVE_BRIDGE_STARTUP_STAGE=HOME_STAGE delta_ms=120 elapsed_ms=170', 200],
        ['LIVE_BRIDGE_STARTUP_STAGE=LOGIN_TRIGGERED delta_ms=1000 elapsed_ms=1170', 1200],
        ['LIVE_BRIDGE_STARTUP_STAGE=LOGIN_CONFIRMED delta_ms=2000 elapsed_ms=3170', 3200],
        ['LIVE_BRIDGE_STARTUP_STAGE=GAME_URL_STAGE delta_ms=100 elapsed_ms=3270', 3300],
        ['LIVE_BRIDGE_STARTUP_STAGE=GAME_NAVIGATED delta_ms=1500 elapsed_ms=4770', 4800],
        ['LIVE_BRIDGE_STARTUP_STAGE=PLAY_TRIGGERED delta_ms=2400 elapsed_ms=7170', 7200],
        ['LIVE_BRIDGE_STARTUP_STAGE=CONTEXT_ISOLATED delta_ms=100 elapsed_ms=7270', 7300],
        ['LIVE_BRIDGE_STARTUP_STAGE=ADAPTER_PAGE_READY delta_ms=50 elapsed_ms=7320', 7350],
        ['LIVE_BRIDGE_STARTUP_STAGE=BRIDGE_READY delta_ms=50 elapsed_ms=7370', 7400],
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
        { timestamp: new Date(base + 100).toISOString(), pid: 11, message: 'LIVE_BRIDGE_STARTUP_STAGE=HOME_STAGE delta_ms=100 elapsed_ms=100' },
        { timestamp: new Date(base + 200).toISOString(), pid: 10, message: 'LIVE_BRIDGE_STARTUP_STAGE=BRIDGE_READY delta_ms=200 elapsed_ms=200' },
    ];

    const rows = profile(records, {
        sessionId: 'account-1:bacbo_int',
        pid: 10,
        startMs: base,
        endMs: Number.POSITIVE_INFINITY,
    });

    assert.deepEqual(rows.map(row => row.stage), ['SESSION_START', 'BRIDGE_READY']);
});
