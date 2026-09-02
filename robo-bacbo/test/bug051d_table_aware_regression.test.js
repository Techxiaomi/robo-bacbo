'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validarConfiguracaoAutoTrader } = require('../bug051d_config_validation');

function configBase(overrides = {}) {
    return {
        stake_inicial: 2.5,
        gale_1_mult: 2,
        gale_2_mult: 4,
        tie_stake_mode: 'PERCENTUAL',
        tie_stake_percent: 2.5,
        tipo_aleatoriedade: 'NENHUMA',
        gatilho_reds_virtuais: 0,
        sinais_por_onda: 0,
        pulo_min: 1,
        pulo_max: 3,
        chance_entrada_pct: 100,
        limite_ciclos: 0,
        limite_entradas: 15,
        stop_win: 100,
        stop_loss: 250,
        trailing_stop: false,
        trailing_recuo: 0,
        stop_reds_seguidos: 0,
        stop_reds_acao: 'DESLIGAR',
        stop_reds_pausa_min: 0,
        faixas_horario: [{ inicio: '00:00', fim: '23:59' }],
        fontes_sinal: ['robo:14'],
        ...overrides
    };
}

test('BUG051D aceita stake R$2,50 na BACBO_BR', () => {
    const result = validarConfiguracaoAutoTrader(configBase(), 'BACBO_BR');
    assert.equal(result.ok, true);
});

test('BUG051D mantém BACBO_INT em mínimo e step de R$5', () => {
    const invalid = validarConfiguracaoAutoTrader(configBase(), 'BACBO_INT');
    assert.equal(invalid.ok, false);
    assert.equal(invalid.campo, 'stake_inicial');

    const valid = validarConfiguracaoAutoTrader(configBase({ stake_inicial: 5 }), 'BACBO_INT');
    assert.equal(valid.ok, true);
});

test('BUG051D BR usa o mesmo SSOT para Tie por valor', () => {
    const valid = validarConfiguracaoAutoTrader(configBase({
        tie_stake_mode: 'VALOR',
        tie_stake_value: 2.5
    }), 'BACBO_BR');
    assert.equal(valid.ok, true);

    const invalid = validarConfiguracaoAutoTrader(configBase({
        tie_stake_mode: 'VALOR',
        tie_stake_value: 3
    }), 'BACBO_BR');
    assert.equal(invalid.ok, false);
    assert.equal(invalid.campo, 'tie_stake_value');
});
