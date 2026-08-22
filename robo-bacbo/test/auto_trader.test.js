'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizarConfigAutoTrader,
    normalizarFaixasHorario,
    traderDentroHorarioExecucao,
    processarResultadoDormindo,
    avaliarSinalOnda,
    avancarAposSinalOperado,
    ESTADO_DORMINDO,
    ESTADO_ONDA_ATIVA
} = require('../auto_trader');

test('normaliza horários legados para faixas_horario sem quebrar configs antigas', () => {
    const config = normalizarConfigAutoTrader({
        hora_inicio: '08:00',
        hora_fim: '12:00',
        modo_camuflagem: 'PULOS',
        camuflagem_pulos_min: 2,
        camuflagem_pulos_max: 4
    });

    assert.deepEqual(config.faixas_horario, [{ inicio: '08:00', fim: '12:00' }]);
    assert.equal(config.tipo_aleatoriedade, 'PULOS');
    assert.equal(config.pulo_min, 2);
    assert.equal(config.pulo_max, 4);
    assert.equal(config.hora_inicio, undefined);
    assert.equal(config.modo_camuflagem, undefined);
});

test('permite execução em qualquer faixa e suporta janela que cruza meia-noite', () => {
    const config = {
        faixas_horario: [
            { inicio: '08:00', fim: '12:00' },
            { inicio: '14:00', fim: '18:00' },
            { inicio: '22:00', fim: '02:00' }
        ]
    };

    assert.equal(traderDentroHorarioExecucao(config, new Date(2026, 7, 22, 9, 30)), true);
    assert.equal(traderDentroHorarioExecucao(config, new Date(2026, 7, 22, 13, 0)), false);
    assert.equal(traderDentroHorarioExecucao(config, new Date(2026, 7, 22, 23, 0)), true);
    assert.equal(traderDentroHorarioExecucao(config, new Date(2026, 7, 22, 1, 30)), true);
});

test('descarta faixas inválidas e cai em faixa legada segura', () => {
    assert.deepEqual(
        normalizarFaixasHorario({
            faixas_horario: [{ inicio: '99:00', fim: '12:00' }],
            hora_inicio: '06:00',
            hora_fim: '07:00'
        }),
        [{ inicio: '06:00', fim: '07:00' }]
    );
});

test('estado dormindo acorda ao atingir quantidade configurada de REDs virtuais', () => {
    const trader = {
        config: { gatilho_reds_virtuais: 2 },
        estado_ciclo: ESTADO_DORMINDO,
        reds_virtuais_observados: 0
    };

    const primeiro = processarResultadoDormindo(trader, 'RED');
    assert.equal(primeiro.estado.estado_ciclo, ESTADO_DORMINDO);
    assert.equal(primeiro.estado.reds_virtuais_observados, 1);
    assert.equal(primeiro.acordou, false);

    const segundo = processarResultadoDormindo({ ...trader, ...primeiro.estado }, 'RED');
    assert.equal(segundo.estado.estado_ciclo, ESTADO_ONDA_ATIVA);
    assert.equal(segundo.estado.reds_virtuais_observados, 0);
    assert.equal(segundo.acordou, true);
});

test('gatilho zero acorda no primeiro sinal elegível', () => {
    const decisao = avaliarSinalOnda({
        config: { gatilho_reds_virtuais: 0, tipo_aleatoriedade: 'NENHUMA' },
        estado_ciclo: ESTADO_DORMINDO
    }, () => 0.5);

    assert.equal(decisao.permitido, true);
    assert.equal(decisao.estado.estado_ciclo, ESTADO_ONDA_ATIVA);
    assert.equal(decisao.persistir, true);
});

test('PULOS aceita o primeiro sinal e depois consome a quantidade sorteada', () => {
    const trader = {
        config: {
            gatilho_reds_virtuais: 0,
            tipo_aleatoriedade: 'PULOS',
            pulo_min: 2,
            pulo_max: 2
        },
        estado_ciclo: ESTADO_ONDA_ATIVA,
        pulos_restantes: 0
    };

    const entrada = avaliarSinalOnda(trader, () => 0);
    assert.equal(entrada.permitido, true);
    assert.equal(entrada.estado.pulos_restantes, 2);

    const pulo1 = avaliarSinalOnda({ ...trader, ...entrada.estado }, () => 0);
    assert.equal(pulo1.permitido, false);
    assert.equal(pulo1.motivo, 'PULO');
    assert.equal(pulo1.estado.pulos_restantes, 1);
});

test('PROBABILIDADE respeita chance percentual', () => {
    const trader = {
        config: {
            gatilho_reds_virtuais: 0,
            tipo_aleatoriedade: 'PROBABILIDADE',
            chance_entrada_pct: 30
        },
        estado_ciclo: ESTADO_ONDA_ATIVA
    };

    assert.equal(avaliarSinalOnda(trader, () => 0.20).permitido, true);
    assert.equal(avaliarSinalOnda(trader, () => 0.40).permitido, false);
});

test('fecha onda, incrementa ciclos e aciona auto-stop no limite', () => {
    const trader = {
        config: {
            gatilho_reds_virtuais: 1,
            sinais_por_onda: 2,
            limite_ciclos: 2
        },
        estado_ciclo: ESTADO_ONDA_ATIVA,
        sinais_operados_onda: 1,
        ciclos_concluidos: 1,
        pulos_restantes: 3
    };

    const resultado = avancarAposSinalOperado(trader);
    assert.equal(resultado.ciclo_concluido, true);
    assert.equal(resultado.auto_stop, true);
    assert.equal(resultado.estado.estado_ciclo, ESTADO_DORMINDO);
    assert.equal(resultado.estado.sinais_operados_onda, 0);
    assert.equal(resultado.estado.ciclos_concluidos, 2);
    assert.equal(resultado.estado.pulos_restantes, 0);
});
