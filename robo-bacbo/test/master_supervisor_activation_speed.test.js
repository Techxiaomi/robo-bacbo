'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const repoRoot = path.join(root, '..');

function read(...parts) {
    return fs.readFileSync(path.join(...parts), 'utf8');
}

test('supervisor launcher uses fast event-driven mode with conservative 2s stagger', () => {
    const launcher = read(repoRoot, 'atalhos', '06_MASTER_SUPERVISOR.cmd');
    assert.match(launcher, /MASTER_SUPERVISOR_STAGGER_MS=2000/);
    assert.match(launcher, /MASTER_SUPERVISOR_RECONCILE_INTERVAL_MS=2000/);
    assert.match(launcher, /master_supervisor_fast\.js/);
});

test('fast supervisor consumes wake signal and keeps 2s polling fallback serialized', () => {
    const source = read(root, 'scripts', 'master_supervisor_fast.js');
    assert.match(source, /DEFAULT_FAST_STAGGER_MS\s*=\s*2000/);
    assert.match(source, /DEFAULT_FAST_RECONCILE_INTERVAL_MS\s*=\s*2000/);
    assert.match(source, /watchSupervisorReconcileSignal/);
    assert.match(source, /pendingReason/);
    assert.match(source, /reconcilePromise/);
    assert.match(source, /WAKE_/);
    assert.match(source, /POLL_FALLBACK/);
    assert.doesNotMatch(source, /pollTimer\.unref/);
});

test('activation bootstrap wakes supervisor immediately but preserves balance timeout', () => {
    const source = read(root, 'auto_trader_activation_bootstrap.js');
    assert.match(source, /signalSupervisorReconcile/);
    assert.match(source, /AUTO_TRADER_ACTIVATION_SUPERVISOR_WAKE/);
    assert.match(source, /AUTO_TRADER_ACTIVATION_ROLLBACK/);
    assert.match(source, /POLL_INTERVAL_MS\s*=\s*250/);
    assert.match(source, /BALANCE_TIMEOUT_MS\s*=\s*20000/);
    assert.match(source, /AUTO_TRADER_ACTIVATION_WORKERS_READY[\s\S]*elapsed_ms=/);
    assert.match(source, /AUTO_TRADER_ACTIVATION_BALANCE_READY[\s\S]*balance_wait_ms=/);
});

test('wake channel is local metadata only and carries no financial command', () => {
    const source = read(root, 'supervisor_reconcile_signal.js');
    assert.match(source, /master-supervisor\.reconcile\.signal\.json/);
    assert.match(source, /fs\.writeFileSync/);
    assert.match(source, /fs\.watch/);
    assert.doesNotMatch(source, /place_bet|auto_trader_commands|global_signals|executor_order_id/);
});
