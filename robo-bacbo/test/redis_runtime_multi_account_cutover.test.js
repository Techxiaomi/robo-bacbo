'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const runtimePath = path.join(__dirname, '..', 'redis_runtime_v3.js');
const source = fs.readFileSync(runtimePath, 'utf8');

test('cutover multi-conta publica ordem exclusivamente no canal global', () => {
    assert.match(source, /AUTO_TRADER_MULTI_ACCOUNT_ROUTER_ENABLED/);
    assert.match(source, /buildPlaceBetSignal/);
    assert.match(source, /publisher\.publish\(GLOBAL_SIGNAL_CHANNEL, JSON\.stringify\(signal\)\)/);
    assert.match(source, /signal_id:\s*orderId/);
    assert.match(source, /table_key:\s*tableKey/);
    assert.doesNotMatch(source, /publicarViaExecutorLegado/);
    assert.doesNotMatch(source, /REDIS_COMMAND_CHANNEL/);
});

test('cutover escuta somente resultado consolidado do router', () => {
    assert.match(source, /GLOBAL_SIGNAL_RESULT_CHANNEL/);
    assert.match(source, /dados\.action !== 'multi_account_bet_result'/);
    assert.match(source, /encaminharResultadoMultiConta/);
    assert.match(source, /executor_status/);
    assert.match(source, /postNode\('\/executor-status'/);
    assert.doesNotMatch(source, /REDIS_RESPONSE_CHANNEL/);
});

test('runtime normaliza identidade canonica BACBO_BR e BACBO_INT para table_key do router', () => {
    assert.match(source, /codigo === 'BR' \|\| codigo === 'BACBO_BR'/);
    assert.match(source, /return 'bacbo_br'/);
    assert.match(source, /codigo === 'INT' \|\| codigo === 'BACBO_INT'/);
    assert.match(source, /return 'bacbo_int'/);
    assert.match(source, /String\(dados\.table_key \|\| ''\)\.trim\(\)\.toLowerCase\(\) !== tableKeyRuntime\(\)/);
});

test('callback redis de resultado e fail-safe e nao deixa rejection escapar', () => {
    assert.match(source, /encaminharResultadoMultiConta\(dados\)\.catch\(erro =>/);
    assert.match(source, /Multi-account fan-in ignorado por erro controlado/);
});

test('resultado sintetico de homologacao continua isolado do executor-status', () => {
    assert.match(source, /if \(dados\.simulation === true\)/);
    assert.match(source, /MULTI-ACCOUNT SIMULATION/);
    assert.match(source, /executor_status_delivery=skipped/);
    assert.match(source, /return true;/);
});

test('dry run real entrega terminal fail-closed ao executor-status', () => {
    assert.match(source, /dados\.dry_run === true/);
    assert.match(source, /MULTI_ACCOUNT_DRY_RUN_NO_DISPATCH/);
    assert.match(source, /MULTI-ACCOUNT DRY RUN/);
    assert.match(source, /executor_status_delivery=enabled/);
    assert.match(source, /postNode\('\/executor-status'/);
});

test('cutover desligado falha fechado e nao reativa ponto-a-ponto', () => {
    assert.match(source, /MULTI_ACCOUNT_ROUTER_REQUIRED/);
    assert.match(source, /afirmarCutoverMultiContaAtivo\(\)/);
    assert.doesNotMatch(source, /publicarViaExecutorLegado/);
    assert.doesNotMatch(source, /Ordem Redis aceita pelo transporte local/);
});
