'use strict';

// BUG-051B: este módulo não aplica patches nem altera arquivos em runtime.
// Ele expõe apenas a política de data operacional para ser consumida pelo backend.
const { criarControleDiarioAutoTrader } = require('./bug051b_daily_counter');

function criarRuntimeBug051B(dbPool, timezone) {
    return criarControleDiarioAutoTrader({ dbPool, timezone });
}

module.exports = { criarRuntimeBug051B };
