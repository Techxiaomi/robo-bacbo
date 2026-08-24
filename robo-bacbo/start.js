'use strict';

const path = require('path');

require('./env_loader').loadEnvFile(path.join(__dirname, '..', '.env'));
require('./operational_log_formatter').instalarLogOperacional();
require('./telegram_signal_presenter').instalarTelegramSignalPresenter();
require('./telegram_signal_lifecycle').instalarTelegramSignalLifecycle();

async function iniciar() {
    const canonicalBridge = require('./bacbo_canonical_bridge');

    // Compatibilidade controlada: o motor antigo continua disponível como fallback,
    // mas sinais novos passam a usar o histórico canônico winner+result do Runtime V3.
    canonicalBridge.instalarCompatibilidadeSinais();

    const redisRuntime = require('./redis_runtime_v3');
    redisRuntime.instalarRedisRuntimeV3();

    try {
        await require('./tipminer_history_sync')
            .instalarTipMinerHistorySync(redisRuntime.processarBacbo);
    } catch (erro) {
        console.error(`⚠️ Sincronização inicial de histórico não iniciou: ${erro.message}`);
    }

    try {
        await require('./telegram_signal_config').migrarConfiguracoesTelegram();
    } catch (erro) {
        console.warn(`⚠️ Telegram: preferências visuais não foram migradas no bootstrap: ${erro.message}`);
    }

    // O backend só é carregado depois da tentativa de hidratação/recovery inicial.
    // Falha de Redis/Telegram continua fail-open para o painel/backend, como antes.
    require('./bot2_coletor');
}

void iniciar().catch(erro => {
    console.error('🔥 Bootstrap do backend falhou:', erro);
    process.exitCode = 1;
});
