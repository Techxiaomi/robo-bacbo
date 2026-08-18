'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    validarPoliticaProtecao,
    calcularPlanoAposta,
    extrairRazaoEmpate,
    calcularPnLEtapa
} = require('../tie_protection');

test('percentual gera proteção no direto e respeita os multiplicadores de G1/G2', () => {
    const config = {
        stake_inicial: 100,
        gale_1_mult: 2,
        gale_2_mult: 4,
        tie_stake_mode: 'PERCENTUAL',
        tie_stake_percent: 5
    };
    const estrategia = { entrada: 'Player', protegerEmpate: true };

    assert.deepEqual(calcularPlanoAposta(config, estrategia, 0), {
        ok: true,
        nivel: 0,
        multiplicador: 1,
        valor_principal: 100,
        valor_empate: 5,
        exposicao_etapa: 105,
        apostas: [
            { alvo: 'PlayerWon', valor: 100 },
            { alvo: 'Tie', valor: 5 }
        ]
    });
    assert.equal(calcularPlanoAposta(config, estrategia, 1).valor_empate, 10);
    assert.equal(calcularPlanoAposta(config, estrategia, 2).valor_empate, 20);
});

test('valor informado para empate também é multiplicado nos Gales', () => {
    const config = {
        stake_inicial: 25,
        gale_1_mult: 3,
        gale_2_mult: 5,
        tie_stake_mode: 'VALOR',
        tie_stake_value: 10
    };
    const estrategia = { entrada: 'Banker', protegerEmpate: true };

    assert.equal(calcularPlanoAposta(config, estrategia, 0).valor_empate, 10);
    assert.equal(calcularPlanoAposta(config, estrategia, 1).valor_empate, 30);
    assert.equal(calcularPlanoAposta(config, estrategia, 2).valor_empate, 50);
});

test('sinal sem proteção não cria perna Tie mesmo com política configurada', () => {
    const plano = calcularPlanoAposta({
        stake_inicial: 20,
        gale_1_mult: 2,
        gale_2_mult: 4,
        tie_stake_mode: 'VALOR',
        tie_stake_value: 5
    }, { entrada: 'Player', protegerEmpate: false }, 0);

    assert.equal(plano.ok, true);
    assert.equal(plano.valor_empate, 0);
    assert.deepEqual(plano.apostas, [{ alvo: 'PlayerWon', valor: 20 }]);
});

test('sinal protegido falha fechado quando política não foi configurada', () => {
    const plano = calcularPlanoAposta({ stake_inicial: 20 }, { entrada: 'Player', protegerEmpate: true }, 0);
    assert.equal(plano.ok, false);
    assert.match(plano.motivo, /não configurado/i);
    assert.equal(validarPoliticaProtecao({}).ok, false);
});

test('percentual é arredondado para ficha de R$5 e o valor efetivo é explícito', () => {
    const plano = calcularPlanoAposta({
        stake_inicial: 10,
        gale_1_mult: 2,
        gale_2_mult: 4,
        tie_stake_mode: 'PERCENTUAL',
        tie_stake_percent: 10
    }, { entrada: 'Player', protegerEmpate: true }, 0);

    assert.equal(plano.valor_empate, 5);
    assert.equal(plano.exposicao_etapa, 15);
});

test('pagamentos 4:1, 6:1 e formato legado 25x são lidos como lucro líquido por unidade', () => {
    assert.equal(extrairRazaoEmpate('4:1'), 4);
    assert.equal(extrairRazaoEmpate('6:1'), 6);
    assert.equal(extrairRazaoEmpate('25x'), 25);
});

test('P&L protegido usa razão X:1 e perda de 10% da cor no Tie', () => {
    assert.equal(calcularPnLEtapa({
        resultado: 'Tie',
        alvoPrincipal: 'Player',
        valorPrincipal: 200,
        valorEmpate: 5,
        multiplicadorEmpate: '4:1'
    }), 0);

    assert.equal(calcularPnLEtapa({
        resultado: 'Tie',
        alvoPrincipal: 'Player',
        valorPrincipal: 100,
        valorEmpate: 5,
        multiplicadorEmpate: '6:1'
    }), 20);
});

test('P&L em vitória da cor desconta a proteção perdida e Tie sem proteção perde só 10% da cor', () => {
    assert.equal(calcularPnLEtapa({
        resultado: 'Player', alvoPrincipal: 'Player', valorPrincipal: 100, valorEmpate: 5
    }), 95);
    assert.equal(calcularPnLEtapa({
        resultado: 'Tie', alvoPrincipal: 'Player', valorPrincipal: 100, valorEmpate: 0, multiplicadorEmpate: '4:1'
    }), -10);
    assert.equal(calcularPnLEtapa({
        resultado: 'Banker', alvoPrincipal: 'Player', valorPrincipal: 100, valorEmpate: 5
    }), -105);
});

test('aposta principal em Tie usa o pagamento X:1 sem subtrair novamente a stake devolvida', () => {
    assert.equal(calcularPnLEtapa({
        resultado: 'Tie', alvoPrincipal: 'Tie', valorPrincipal: 10, multiplicadorEmpate: '4:1'
    }), 40);
    assert.equal(calcularPnLEtapa({
        resultado: 'Player', alvoPrincipal: 'Tie', valorPrincipal: 10, multiplicadorEmpate: '4:1'
    }), -10);
});
