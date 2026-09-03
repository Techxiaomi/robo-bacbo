'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    getTableFinancialRules,
    validateAutoTraderMoneyRules,
    quantizeMoney
} = require('../table_financial_rules');

function config(overrides = {}) {
    return {
        stake_inicial: 2.5,
        gale_1_mult: 2,
        gale_2_mult: 4,
        tie_stake_mode: 'VALOR',
        tie_stake_value: 2.5,
        ...overrides
    };
}

test('BACBO_BR preserva ficha de R$2,50 e não expõe ficha 5000', () => {
    const br = getTableFinancialRules('BACBO_BR');
    assert.equal(br.min_stake, 2.5);
    assert.equal(br.stake_step, 2.5);
    assert.equal(br.tie_min, 2.5);
    assert.equal(br.tie_step, 2.5);
    assert.deepEqual(br.chips, [2.5, 5, 10, 25, 125, 500]);
    assert.equal(br.chips.includes(5000), false);
});

test('BACBO_BR aceita valores em passos de R$2,50', () => {
    for (const stake of [2.5, 5, 7.5, 10, 12.5, 15]) {
        const result = validateAutoTraderMoneyRules(config({ stake_inicial: stake }), 'BACBO_BR');
        assert.equal(result.ok, true, `stake ${stake} deveria ser válida na BACBO_BR`);
    }
});

test('BACBO_BR rejeita valor fora do passo de R$2,50', () => {
    const result = validateAutoTraderMoneyRules(config({ stake_inicial: 3 }), 'BACBO_BR');
    assert.equal(result.ok, false);
    assert.equal(result.field, 'stake_inicial');
});

test('Tie BACBO_BR aceita R$2,50 e segue o mesmo step', () => {
    assert.equal(validateAutoTraderMoneyRules(config({ tie_stake_value: 2.5 }), 'BACBO_BR').ok, true);
    assert.equal(validateAutoTraderMoneyRules(config({ tie_stake_value: 7.5 }), 'BACBO_BR').ok, true);
    assert.equal(validateAutoTraderMoneyRules(config({ tie_stake_value: 3 }), 'BACBO_BR').ok, false);
});

test('preview BACBO_BR quantiza pela grade de R$2,50', () => {
    const br = getTableFinancialRules('BACBO_BR');
    assert.equal(quantizeMoney(2.5, br, 'stake'), 2.5);
    assert.equal(quantizeMoney(6.2, br, 'stake'), 5);
    assert.equal(quantizeMoney(6.3, br, 'stake'), 7.5);
});

test('BACBO_INT permanece inalterada', () => {
    const int = getTableFinancialRules('BACBO_INT');
    assert.equal(int.min_stake, 5);
    assert.equal(int.stake_step, 5);
    assert.equal(int.tie_min, 5);
    assert.equal(int.tie_step, 5);
    assert.deepEqual(int.chips, [5, 10, 25, 125, 500]);
});
