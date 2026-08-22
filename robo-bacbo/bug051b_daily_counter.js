'use strict';

const {
    normalizarConfigHorarios,
    dentroDeAlgumaFaixa,
    descreverFaixasHorario
} = require('./auto_trader_schedule');

const DEFAULT_OPERATIONAL_TIMEZONE = 'America/Sao_Paulo';

function criarControleDiarioAutoTrader({ dbPool, timezone }) {
    const fuso = String(timezone || DEFAULT_OPERATIONAL_TIMEZONE).trim() || DEFAULT_OPERATIONAL_TIMEZONE;
    const formatadorData = new Intl.DateTimeFormat('en-CA', {
        timeZone: fuso,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    });

    function dataOperacional(agora = Date.now()) {
        const instante = agora instanceof Date ? agora : new Date(agora);
        if (Number.isNaN(instante.getTime())) {
            throw new Error('Instante invalido para calcular a data operacional do Auto-Trader');
        }

        const partes = {};
        for (const parte of formatadorData.formatToParts(instante)) {
            if (parte.type === 'year' || parte.type === 'month' || parte.type === 'day') {
                partes[parte.type] = parte.value;
            }
        }
        if (!partes.year || !partes.month || !partes.day) {
            throw new Error(`Nao foi possivel calcular a data operacional no fuso ${fuso}`);
        }
        return `${partes.year}-${partes.month}-${partes.day}`;
    }

    async function normalizarHorariosPersistidos(trader) {
        const normalizacao = normalizarConfigHorarios(trader?.config || {});
        if (!normalizacao.validacao.ok) {
            throw new Error(
                `Configuracao de horario invalida (${normalizacao.validacao.campo || 'faixas_horario'}): `
                + `${normalizacao.validacao.motivo || 'formato invalido'}`
            );
        }

        if (!normalizacao.alterado) return false;

        await dbPool.query(
            'UPDATE auto_traders SET config_json=? WHERE id=?',
            [JSON.stringify(normalizacao.config), trader.id]
        );
        trader.config = normalizacao.config;
        return true;
    }

    async function garantirDataOperacional(trader, agora = Date.now()) {
        if (!trader || trader.id === undefined || trader.id === null) {
            throw new Error('Auto-Trader invalido para controle diario');
        }

        await normalizarHorariosPersistidos(trader);

        // O fluxo de autorização de uma nova entrada chama esta função sem timestamp
        // explícito. A virada diária administrativa informa o timestamp e não deve ser
        // impedida por uma janela de atividade fechada.
        const validarHorarioDaEntrada = arguments.length < 2;
        if (validarHorarioDaEntrada && !dentroDeAlgumaFaixa(trader.config, new Date())) {
            throw new Error(
                `fora das faixas de atividade configuradas (${descreverFaixasHorario(trader.config)})`
            );
        }

        const hoje = dataOperacional(agora);
        const dataPersistida = String(trader.data_contador_entradas || '').trim();
        if (dataPersistida === hoje) return false;

        await dbPool.query(
            `UPDATE auto_traders
             SET entradas_feitas=0,
                 pulos_restantes=0,
                 data_contador_entradas=?,
                 status_operacao=CASE
                     WHEN status_operacao='META_ATINGIDA' THEN 'STANDBY'
                     ELSE status_operacao
                 END
             WHERE id=?`,
            [hoje, trader.id]
        );

        trader.entradas_feitas = 0;
        trader.pulos_restantes = 0;
        trader.data_contador_entradas = hoje;
        if (trader.status_operacao === 'META_ATINGIDA') {
            trader.status_operacao = 'STANDBY';
        }

        return true;
    }

    return {
        timezone: fuso,
        dataOperacional,
        garantirDataOperacional
    };
}

module.exports = {
    DEFAULT_OPERATIONAL_TIMEZONE,
    criarControleDiarioAutoTrader
};
