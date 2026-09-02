'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { envForTask } = require('../trader_bound_tasks');

const repoRoot = path.join(__dirname, '..', '..');

function readShortcut(name) {
    return fs.readFileSync(path.join(repoRoot, 'atalhos', name), 'utf8');
}

test('processos raiz usam arquivos runtime metrics exclusivos', () => {
    const expected = new Map([
        ['03_NODE_INT.cmd', 'backend.metrics.BACBO_INT.json'],
        ['05_NODE_BR.cmd', 'backend.metrics.BACBO_BR.json'],
        ['06_MASTER_SUPERVISOR.cmd', 'backend.metrics.master-supervisor.json'],
        ['07_SIGNAL_ROUTER.cmd', 'backend.metrics.signal-router.json']
    ]);

    for (const [shortcut, fileName] of expected) {
        const source = readShortcut(shortcut);
        assert.match(source, new RegExp(`METRICS_FILE_NAME=${fileName.replaceAll('.', '\\.')}`));
        assert.doesNotMatch(source, /METRICS_FILE_NAME=backend\.metrics\.json(?:\r?\n|\")/);
    }
});

test('live bridge sobrescreve runtime metrics por conta e mesa', () => {
    const env = envForTask(
        {
            METRICS_FILE_NAME: 'backend.metrics.master-supervisor.json',
            OPERATIONS_METRICS_NAMESPACE: 'master-supervisor'
        },
        { accountId: 4, tableKey: 'bacbo_int' }
    );

    assert.equal(env.METRICS_FILE_NAME, 'backend.metrics.account-4-bacbo_int.json');
    assert.equal(env.OPERATIONS_METRICS_NAMESPACE, 'account-4-bacbo_int');
    assert.equal(env.LIVE_BRIDGE_PROCESS_NAMESPACE, 'account-4-bacbo_int');
});
