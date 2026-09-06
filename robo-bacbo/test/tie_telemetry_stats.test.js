'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    timestampLinhaTie,
    limitesPeriodosTie,
    periodosDaLinhaTie,
    criarTelemetriaTiePorPeriodosVazia,
    eventoTieDaLinhaPersistida,
    agregarLinhasTiePorPeriodo
} = require('../tie_telemetry');

test('timestamp aceita Date milissegundos segundos e ISO', () => {
    const base = Date.UTC(2026, 8, 5, 12, 0, 0);
    assert.equal(timestampLinhaTie(new Date(base)), base);
    assert.equal(timestampLinhaTie(base), base);
    assert.equal(timestampLinhaTie(base / 1000), base);
    assert.equal(timestampLinhaTie('2026-09-05T12:00:00.000Z'), base);
});

test('estrutura por periodos nasce zerada', () => {
    const stats = criarTelemetriaTiePorPeriodosVazia();

    for (const periodo of ['24h', 'hoje', 'semana', 'mes', 'geral']) {
        assert.equal(stats[periodo].observados.total, 0);
        assert.equal(stats[periodo].protegidos.total, 0);
        assert.equal(stats[periodo].sem_protecao.total, 0);
    }
});

test('linha persistida protegida mantem nivel e multiplicador', () => {
    const evento = eventoTieDaLinhaPersistida({
        nivel: 'GALE1',
        multiplicador: '6x',
        proteger_empate_snapshot: 1
    });

    assert.equal(evento.observado, true);
    assert.equal(evento.nivel, 'gale1');
    assert.equal(evento.classificacao, 'PROTEGIDO');
    assert.equal(evento.multiplicador, '6x');
});

test('linha sem protecao continua observada', () => {
    const evento = eventoTieDaLinhaPersistida({
        nivel: 'DIRETO',
        multiplicador: '4x',
        proteger_empate_snapshot: 0
    });

    assert.equal(evento.observado, true);
    assert.equal(evento.classificacao, 'SEM_PROTECAO');
});

test('snapshot null permanece desconhecido', () => {
    const evento = eventoTieDaLinhaPersistida({
        nivel: 'GALE2',
        multiplicador: '25x',
        proteger_empate_snapshot: null
    });

    assert.equal(evento.classificacao, 'PROTECAO_DESCONHECIDA');
});

test('nivel invalido nao entra nas estatisticas', () => {
    const evento = eventoTieDaLinhaPersistida({
        nivel: 'GALE9',
        proteger_empate_snapshot: 1
    });

    assert.equal(evento.observado, false);
});

test('agregacao separa protegido sem protecao e desconhecido', () => {
    const agora = Date.UTC(2026, 8, 5, 12, 0, 0);

    const linhas = [
        {
            nivel: 'DIRETO',
            multiplicador: '4x',
            proteger_empate_snapshot: 1,
            data_hora: new Date(agora - 1000)
        },
        {
            nivel: 'GALE1',
            multiplicador: '6x',
            proteger_empate_snapshot: 0,
            data_hora: new Date(agora - 2000)
        },
        {
            nivel: 'GALE2',
            multiplicador: '25x',
            proteger_empate_snapshot: null,
            data_hora: new Date(agora - 3000)
        }
    ];

    const stats = agregarLinhasTiePorPeriodo(linhas, agora);

    assert.equal(stats.geral.observados.total, 3);
    assert.equal(stats.geral.protegidos.total, 1);
    assert.equal(stats.geral.sem_protecao.total, 1);
    assert.equal(stats.geral.protecao_desconhecida.total, 1);
    assert.equal(stats.geral.protegidos.multiplicadores.direto['4x'], 1);
});

test('linha antiga fora de 24h continua no geral', () => {
    const agora = Date.UTC(2026, 8, 5, 12, 0, 0);
    const antiga = agora - (48 * 60 * 60 * 1000);

    const stats = agregarLinhasTiePorPeriodo(
        [{
            nivel: 'DIRETO',
            proteger_empate_snapshot: 0,
            data_hora: antiga
        }],
        agora
    );

    assert.equal(stats.geral.observados.total, 1);
    assert.equal(stats['24h'].observados.total, 0);
});

test('periodosDaLinhaTie sempre inclui geral', () => {
    const periodos = periodosDaLinhaTie(
        { data_hora: null },
        Date.UTC(2026, 8, 5)
    );

    assert.deepEqual(periodos, ['geral']);
});

test('limites de periodo sao coerentes', () => {
    const agora = Date.UTC(2026, 8, 5, 12, 0, 0);
    const limites = limitesPeriodosTie(agora);

    assert.ok(limites['24h'] < agora);
    assert.ok(limites.hoje <= agora);
    assert.ok(limites.semana <= agora);
    assert.ok(limites.mes <= agora);
});
