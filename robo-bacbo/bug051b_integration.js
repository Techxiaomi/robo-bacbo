'use strict';

const { criarBarreiraSaldoFrescoStops } = require('./bug051c_balance_barrier');

// Integração BUG-051B encapsulada como fonte de domínio: o backend chama estas rotinas
// antes de avaliar novas entradas e na virada de cada resultado da mesa.
function criarIntegracaoContadorDiario({ controleDiarioAutoTrader, dbPool, ioServer, traders }) {
    const barreiraSaldoStops = criarBarreiraSaldoFrescoStops({ dbPool });

    async function garantirAntesDaEntrada(trader) {
        try {
            await controleDiarioAutoTrader.garantirDataOperacional(trader);
        } catch (erro) {
            console.error(
                `BUG-051B Trader ${trader?.id}: falha ao validar data operacional; nova entrada bloqueada:`,
                erro.message
            );
            return false;
        }

        // BUG-051C: a checagem de 90 s do snapshot global continua sendo um teto de idade,
        // mas nao basta para avaliar Stop Win/Loss/Trailing. A avaliacao financeira abaixo
        // so sera alcancada se a ultima liquidacao terminal possuir prova persistida de uma
        // sincronizacao de saldo estritamente posterior ao resultado.
        try {
            const saldoStops = await barreiraSaldoStops.garantirSaldoPosteriorUltimaLiquidacao(trader);
            if (!saldoStops.permitido) {
                const ref = saldoStops.referencia || {};
                console.warn(
                    `BUG-051C Trader ${trader?.id}: nova entrada e avaliacao de Stops bloqueadas; `
                    + `saldo posterior a ultima liquidacao nao foi comprovado `
                    + `(auditoria=${ref.auditoria_id || 'n/a'}, `
                    + `resultado_em=${ref.resultado_confirmado_em || 'n/a'}, `
                    + `saldo_confirmado_em=${ref.saldo_pos_confirmado_em || 'n/a'}).`
                );
                return false;
            }
        } catch (erro) {
            console.error(
                `BUG-051C Trader ${trader?.id}: falha ao validar causalidade do saldo; `
                + `nova entrada e avaliacao de Stops bloqueadas:`,
                erro.message
            );
            return false;
        }

        return true;
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
