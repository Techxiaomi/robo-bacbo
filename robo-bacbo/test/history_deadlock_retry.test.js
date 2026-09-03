'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    isMysqlDeadlock,
    withMysqlDeadlockRetry
} = require('../mysql_deadlock_retry');

function deadlock(message = 'Deadlock found when trying to get lock; try restarting transaction') {
    const error = new Error(message);
    error.code = 'ER_LOCK_DEADLOCK';
    error.errno = 1213;
    error.sqlState = '40001';
    return error;
}

test('reconhece deadlock MySQL por code e errno', () => {
    assert.equal(isMysqlDeadlock(deadlock()), true);
    assert.equal(isMysqlDeadlock(Object.assign(new Error('deadlock'), { errno: 1213 })), true);
    assert.equal(isMysqlDeadlock(Object.assign(new Error('outro'), { code: 'ER_PARSE_ERROR', errno: 1064 })), false);
});

test('retry executa no máximo 3 tentativas com backoff exponencial curto', async () => {
    let calls = 0;
    const delays = [];
    const retries = [];

    const result = await withMysqlDeadlockRetry(async () => {
        calls++;
        if (calls < 3) throw deadlock();
        return 'ok';
    }, {
        attempts: 3,
        baseDelayMs: 50,
        sleepFn: async delay => { delays.push(delay); },
        onRetry: info => retries.push(info)
    });

    assert.equal(result, 'ok');
    assert.equal(calls, 3);
    assert.deepEqual(delays, [50, 100]);
    assert.deepEqual(retries.map(item => item.nextAttempt), [2, 3]);
});

test('erro não-deadlock falha imediatamente sem retry', async () => {
    let calls = 0;
    await assert.rejects(
        () => withMysqlDeadlockRetry(async () => {
            calls++;
            const error = new Error('SQL inválido');
            error.code = 'ER_PARSE_ERROR';
            error.errno = 1064;
            throw error;
        }, { sleepFn: async () => {} }),
        /SQL inválido/
    );
    assert.equal(calls, 1);
});

test('deadlock persistente falha após a terceira tentativa', async () => {
    let calls = 0;
    await assert.rejects(
        () => withMysqlDeadlockRetry(async () => {
            calls++;
            throw deadlock();
        }, { attempts: 3, baseDelayMs: 1, sleepFn: async () => {} }),
        /Deadlock found/
    );
    assert.equal(calls, 3);
});

test('persistência histórica mantém idempotência por mesa+uuid durante retry', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'bacbo_round_store.js'), 'utf8');
    assert.match(source, /PRIMARY KEY \(mesa_id, uuid\)/);
    assert.match(source, /ON DUPLICATE KEY UPDATE/);
    assert.match(source, /withMysqlDeadlockRetry/);
    assert.match(source, /persistirHistoricoUmaTentativa/);
    assert.match(source, /rollback\(\)/);
    assert.match(source, /release\(\)/);
});

test('barreira histórica repete somente deadlock do consumidor crítico', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'tipminer_history_sync.js'), 'utf8');
    assert.match(source, /withMysqlDeadlockRetry/);
    assert.match(source, /HISTORY_CONSUMER_DEADLOCK_RETRY/);
    assert.match(source, /listener\(meta\)/);
    assert.match(source, /lembrarBarreiraConfirmada/);
});
