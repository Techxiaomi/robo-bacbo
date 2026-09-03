'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const harnessPath = path.join(
    __dirname,
    '..',
    'scripts',
    'run_fanin_simulation_harness.js'
);

const source = fs.readFileSync(harnessPath, 'utf8');
const harness = require(harnessPath);

test('fanin simulation harness nao publica sinal financeiro nem comando de aposta', () => {
    assert.match(source, /FANIN_SIM_FINANCIAL_DISPATCH=0/);
    assert.match(source, /FANIN_SIM_GLOBAL_SIGNAL_PUBLISH=0/);
    assert.doesNotMatch(source, /publisher\.publish\(\s*['"]global_signals['"]/);
    assert.doesNotMatch(source, /publisher\.publish\(\s*target\.command_channel/);
    assert.doesNotMatch(source, /action:\s*['"]place_bet['"]/);
});

test('fanin simulation harness usa somente respostas sinteticas explicitamente marcadas', () => {
    const target = {
        account_id: 1,
        order_id: 'sim-order-1'
    };
    const result = harness.syntheticBetResult(target);

    assert.equal(result.action, 'bet_result');
    assert.equal(result.order_id, 'sim-order-1');
    assert.equal(result.status, 'EXECUTADA');
    assert.equal(result.simulation, true);
    assert.equal(result.motivo, 'SYNTHETIC_FANIN_HARNESS_NO_FINANCIAL_DISPATCH');
    assert.equal(result.confirmacao.metodo, 'SYNTHETIC_FANIN_HARNESS');
    assert.equal(result.confirmacao.debito_observado, 0);
    assert.equal(result.confirmacao.exposicao_esperada, 0);
});

test('fanin simulation harness produz order ids sinteticos deterministas por conta', () => {
    const runId = 'fanin-sim-test';
    const id1a = harness.buildSyntheticOrderId(runId, 1);
    const id1b = harness.buildSyntheticOrderId(runId, 1);
    const id4 = harness.buildSyntheticOrderId(runId, 4);

    assert.equal(id1a, id1b);
    assert.notEqual(id1a, id4);
    assert.match(id1a, /^sim-[a-f0-9]{32}$/);
    assert.match(id4, /^sim-[a-f0-9]{32}$/);
});
