'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const runtimePath = path.join(__dirname, '..', 'redis_runtime_v3.js');
const source = fs.readFileSync(runtimePath, 'utf8');

test('cutover multi-conta publica ordem no canal global', () => {
    assert.match(source, /AUTO_TRADER_MULTI_ACCOUNT_ROUTER_ENABLED/);
    assert.match(source, /buildPlaceBetSignal/);
    assert.match(source, /publisher\.publish\(GLOBAL_SIGNAL_CHANNEL, JSON\.stringify\(signal\)\)/);
    assert.match(source, /signal_id:\s*orderId/);
    assert.match(source, /table_key:\s*tableKey/);
});

test('cutover escuta somente resultado consolidado do router', () => {
    assert.match(source, /GLOBAL_SIGNAL_RESULT_CHANNEL/);
    assert.match(source, /dados\.action !== 'multi_account_bet_result'/);
    assert.match(source, /encaminharResultadoMultiConta/);
    assert.match(source, /executor_status/);
    assert.match(source, /postNode\('\/executor-status'/);
});

test('runtime filtra resultado consolidado pela mesa local', () => {
    assert.match(source, /String\(dados\.table_key \|\| ''\)\.trim\(\) !== tableKeyRuntime\(\)/);
    assert.match(source, /codigo === 'BR'/);
    assert.match(source, /return 'bacbo_br'/);
    assert.match(source, /codigo === 'INT'/);
    assert.match(source, /return 'bacbo_int'/);
});

test('rota legada permanece apenas como rollback quando cutover estiver desligado', () => {
    assert.match(source, /if \(multiAccountRouterEnabled\(\)\)/);
    assert.match(source, /publicarViaRouterMultiConta/);
    assert.match(source, /publicarViaExecutorLegado/);
});
