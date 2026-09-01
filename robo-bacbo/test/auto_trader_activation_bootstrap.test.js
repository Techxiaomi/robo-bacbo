'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const {
    normalizeAccountIds,
    taskId,
    channelsFor,
    readyWorkers
} = require('../auto_trader_activation_bootstrap');

function read(relativePath) {
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('normaliza contas e deriva canais exclusivos por conta/mesa', () => {
    assert.deepEqual(normalizeAccountIds({ account_ids: ['4', 1, '4', 0, 'x'] }), [1, 4]);
    assert.equal(taskId(4, 'bacbo_int'), 'account-4:bacbo_int');
    assert.deepEqual(channelsFor(4, 'bacbo_int'), {
        command: 'auto_trader_commands:4:bacbo_int',
        response: 'auto_trader_responses:4:bacbo_int'
    });
});

test('gate READY exige supervisor fresco e todos os workers vinculados READY', () => {
    const context = { accountIds: [1, 4], tableKey: 'bacbo_int' };
    const base = {
        available: true,
        stale: false,
        supervisor: { running: true },
        workers: [
            { session_id: 'account-1:bacbo_int', desired: true, status: 'READY' },
            { session_id: 'account-4:bacbo_int', desired: true, status: 'READY' }
        ]
    };
    assert.equal(readyWorkers(base, context), true);
    assert.equal(readyWorkers({ ...base, stale: true }, context), false);
    assert.equal(readyWorkers({ ...base, workers: base.workers.slice(0, 1) }, context), false);
    assert.equal(readyWorkers({
        ...base,
        workers: [base.workers[0], { ...base.workers[1], status: 'STARTING' }]
    }, context), false);
});

test('bootstrap usa somente sync_balance e agrega todas as contas', () => {
    const source = read('auto_trader_activation_bootstrap.js');
    assert.match(source, /status_operacao='ATIVANDO'/);
    assert.match(source, /action:\s*'sync_balance'/);
    assert.match(source, /accounts\.reduce\(\(sum, account\) => sum \+ account\.balance, 0\)/);
    assert.match(source, /AUTO_TRADER_ACTIVATION_BALANCE_INCOMPLETE/);
    assert.doesNotMatch(source, /place_bet/);
});

test('supervisor inclui ATIVANDO sem transformar qualquer trader desligado em worker', () => {
    const source = read('trader_bound_tasks.js');
    assert.match(source, /at\.ativo\s*=\s*true/);
    assert.match(source, /at\.ativo\s*=\s*false\s+AND at\.status_operacao\s*=\s*'ATIVANDO'/);
    assert.doesNotMatch(source, /WHERE\s+at\.ativo\s*=\s*false\s+ORDER BY/i);
});

test('bootstrap instala o interceptador antes do backend principal', () => {
    const source = read('start.js');
    const installIndex = source.indexOf('installActivationBootstrap();');
    const backendIndex = source.indexOf("require('./bot2_coletor')");
    assert.ok(installIndex >= 0, 'bootstrap de ativacao deve ser instalado');
    assert.ok(backendIndex > installIndex, 'bootstrap deve ser instalado antes de bot2_coletor');
});
