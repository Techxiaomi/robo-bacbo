'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizarFaixasHorario,
    normalizarConfigHorariosAutoTrader,
    traderDentroHorarioExecucao
} = require('../auto_trader');

test('usa múltiplas faixas e autoriza quando qualquer uma corresponde', () => {
    const config = {
        faixas_horario: [
            { inicio: '08:00', fim: '12:00' },
            { inicio: '14:00', fim: '18:00' }
        ]
    };

    assert.equal(traderDentroHorarioExecucao(config, new Date(2026, 7, 22, 9, 30)), true);
    assert.equal(traderDentroHorarioExecucao(config, new Date(2026, 7, 22, 13, 0)), false);
    assert.equal(traderDentroHorarioExecucao(config, new Date(2026, 7, 22, 16, 45)), true);
});

test('aceita faixa que atravessa a meia-noite', () => {
    const config = { faixas_horario: [{ inicio: '22:00', fim: '02:00' }] };

    assert.equal(traderDentroHorarioExecucao(config, new Date(2026, 7, 22, 23, 0)), true);
    assert.equal(traderDentroHorarioExecucao(config, new Date(2026, 7, 23, 1, 30)), true);
    assert.equal(traderDentroHorarioExecucao(config, new Date(2026, 7, 23, 3, 0)), false);
});

test('faz fallback para hora_inicio/hora_fim de motores antigos', () => {
    const configLegada = { hora_inicio: '09:15', hora_fim: '11:45' };

    assert.deepEqual(normalizarFaixasHorario(configLegada), [
        { inicio: '09:15', fim: '11:45' }
    ]);
    assert.equal(traderDentroHorarioExecucao(configLegada, new Date(2026, 7, 22, 10, 0)), true);
    assert.equal(traderDentroHorarioExecucao(configLegada, new Date(2026, 7, 22, 12, 0)), false);
});

test('configuração nova remove campos legados e persiste somente o array', () => {
    const normalizada = normalizarConfigHorariosAutoTrader({
        hora_inicio: '07:00',
        hora_fim: '08:00',
        faixas_horario: [
            { inicio: '08:00', fim: '12:00' },
            { inicio: '14:00', fim: '18:00' }
        ],
        stake_inicial: 10
    });

    assert.deepEqual(normalizada.faixas_horario, [
        { inicio: '08:00', fim: '12:00' },
        { inicio: '14:00', fim: '18:00' }
    ]);
    assert.equal('hora_inicio' in normalizada, false);
    assert.equal('hora_fim' in normalizada, false);
    assert.equal(normalizada.stake_inicial, 10);
});

test('dados inválidos não quebram e caem no horário padrão seguro', () => {
    assert.deepEqual(normalizarFaixasHorario({ faixas_horario: [{ inicio: '99:00', fim: '18:00' }] }), [
        { inicio: '00:00', fim: '23:59' }
    ]);
});
