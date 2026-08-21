'use strict';

// Integração BUG-051B encapsulada como fonte de domínio: o backend chama estas rotinas
// antes de avaliar novas entradas e na virada de cada resultado da mesa.
function criarIntegracaoContadorDiario({ controleDiarioAutoTrader, dbPool, ioServer, traders }) {
    async function garantirAntesDaEntrada(trader) {
        try {
            await controleDiarioAutoTrader.garantirDataOperacional(trader);
            return true;
        } catch (erro) {
            console.error(
                `BUG-051B Trader ${trader?.id}: falha ao validar data operacional; nova entrada bloqueada:`,
                erro.message
            );
            return false;
        }
    }

    async function processarViradaDiaria(agora = Date.now()) {
        let resetados = 0;
        for (const trader of traders()) {
            if (!trader?.ativo) continue;
            try {
                if (await controleDiarioAutoTrader.garantirDataOperacional(trader, agora)) {
                    resetados++;
                    console.log(
                        `BUG-051B Trader ${trader.id}: novo dia operacional ${trader.data_contador_entradas} `
                        + `(${controleDiarioAutoTrader.timezone}); entradas e pulos zerados.`
                    );
                }
            } catch (erro) {
                console.error(
                    `BUG-051B Trader ${trader?.id}: falha ao processar virada diaria; estado anterior preservado:`,
                    erro.message
                );
            }
        }
        if (resetados > 0) ioServer.emit('atualizar_interface');
        return resetados;
    }

    async function inicializarDatasLegadas() {
        const hoje = controleDiarioAutoTrader.dataOperacional();
        await dbPool.query(
            `UPDATE auto_traders
             SET data_contador_entradas=?
             WHERE data_contador_entradas IS NULL OR data_contador_entradas=''`,
            [hoje]
        );
        return hoje;
    }

    return {
        garantirAntesDaEntrada,
        processarViradaDiaria,
        inicializarDatasLegadas
    };
}

module.exports = { criarIntegracaoContadorDiario };
