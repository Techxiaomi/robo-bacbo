'use strict';

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

    async function garantirDataOperacional(trader, agora = Date.now()) {
        if (!trader || trader.id === undefined || trader.id === null) {
            throw new Error('Auto-Trader invalido para controle diario');
        }

        const mesaId = Number(trader.mesa_id);

        if (!Number.isInteger(mesaId) || mesaId <= 0) {
            throw new Error(
                'MC22-X: Auto-Trader sem mesa_id no controle diario'
            );
        }

        const hoje = dataOperacional(agora);
        const dataPersistida = String(trader.data_contador_entradas || '').trim();
        if (dataPersistida === hoje) return false;

        const [resultado] = await dbPool.query(
            `UPDATE auto_traders
             SET entradas_feitas=0,
                 pulos_restantes=0,
                 data_contador_entradas=?,
                 status_operacao=CASE
                     WHEN status_operacao='META_ATINGIDA' THEN 'STANDBY'
                     ELSE status_operacao
                 END
             WHERE id=?
               AND mesa_id=?`,
            [
                hoje,
                trader.id,
                mesaId
            ]
        );

        if (Number(resultado.affectedRows) !== 1) {
            throw new Error(
                'MC22-X: reset diario nao encontrou Trader na mesa'
            );
        }

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
