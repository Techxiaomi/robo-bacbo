'use strict';

const { criarControleDiarioAutoTrader } = require('./bug051b_daily_counter');
const { criarIntegracaoContadorDiario } = require('./bug051b_integration');

function criarBootstrapBug051B({ dbPool, ioServer, traders, timezone }) {
    const controle = criarControleDiarioAutoTrader({ dbPool, timezone });
    const integracao = criarIntegracaoContadorDiario({
        controleDiarioAutoTrader: controle,
        dbPool,
        ioServer,
        traders
    });
    return { controle, integracao };
}

module.exports = { criarBootstrapBug051B };
