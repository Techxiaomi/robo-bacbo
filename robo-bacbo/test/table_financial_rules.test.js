'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    getTableFinancialRules,
    publicTableFinancialRules,
    isExactStep,
    quantizeMoney,
    validateAutoTraderMoneyRules
} = require('../table_financial_rules');

function baseConfig(overrides = {}) {
    return {
        stake_inicial: 5,
        gale_1_mult: 2,
        gale_2_mult: 4,
        tie_stake_mode: 'VALOR',
        tie_stake_value: 5,
        ...overrides
    };
}

test('BR e INT possuem perfis financeiros explícitos e independentes', () => {
    const br = getTableFinancialRules('BACBO_BR');
    const int = getTableFinancialRules('bacbo_int');
    assert.equal(br.table_code, 'BACBO_BR');
    assert.equal(int.table_code, 'BACBO_INT');
    assert.notEqual(br, int);
    assert.deepEqual(br.chips, [5, 10, 25, 125, 500]);
    assert.deepEqual(int.chips, [5, 10, 25, 125, 500]);
});

test('contrato público expõe mínimo, step, tie e fichas sem estado mutável', () => {
    const rules = publicTableFinancialRules('BACBO_BR');
    assert.equal(rules.min_stake, 5);
    assert.equal(rules.stake_step, 5);
    assert.equal(rules.tie_min, 5);
    assert.equal(rules.tie_step, 5);
    assert.deepEqual(rules.chips, [5, 10, 25, 125, 500]);
    assert.equal(Object.isFrozen(rules), true);
    assert.equal(Object.isFrozen(rules.chips), true);
});

test('BR rejeita R$2,50 e aceita somente passos exatos do contrato', () => {
    assert.equal(validateAutoTraderMoneyRules(baseConfig({ stake_inicial: 2.5 }), 'BACBO_BR').ok, false);
    assert.equal(validateAutoTraderMoneyRules(baseConfig({ stake_inicial: 7.5 }), 'BACBO_BR').ok, false);
    assert.equal(validateAutoTraderMoneyRules(baseConfig({ stake_inicial: 5 }), 'BACBO_BR').ok, true);
    assert.equal(validateAutoTraderMoneyRules(baseConfig({ stake_inicial: 10 }), 'BACBO_BR').ok, true);
});

test('Tie por valor usa mínimo e step da mesma mesa', () => {
    const invalid = validateAutoTraderMoneyRules(baseConfig({ tie_stake_value: 2.5 }), 'BACBO_BR');
    const valid = validateAutoTraderMoneyRules(baseConfig({ tie_stake_value: 10 }), 'BACBO_BR');
    assert.equal(invalid.ok, false);
    assert.equal(invalid.field, 'tie_stake_value');
    assert.equal(valid.ok, true);
});

test('Tie percentual não é confundido com valor monetário digitado', () => {
    const result = validateAutoTraderMoneyRules(baseConfig({
        tie_stake_mode: 'PERCENTUAL',
        tie_stake_value: 0,
        tie_stake_percent: 5
    }), 'BACBO_BR');
    assert.equal(result.ok, true);
});

test('quantização de preview respeita mínimo e step do contrato', () => {
    const rules = getTableFinancialRules('BACBO_BR');
    assert.equal(quantizeMoney(2.5, rules, 'stake'), 5);
    assert.equal(quantizeMoney(7.5, rules, 'stake'), 10);
    assert.equal(quantizeMoney(12.4, rules, 'tie'), 10);
    assert.equal(isExactStep(10, rules.min_stake, rules.stake_step), true);
    assert.equal(isExactStep(12.5, rules.min_stake, rules.stake_step), false);
});

test('mesa desconhecida falha fechada', () => {
    const result = validateAutoTraderMoneyRules(baseConfig(), 'BACBO_X');
    assert.equal(result.ok, false);
    assert.equal(result.field, 'table');
    assert.match(result.reason, /UNSUPPORTED_TABLE/);
});
