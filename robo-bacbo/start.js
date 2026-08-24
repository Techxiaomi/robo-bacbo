'use strict';

const path = require('path');

require('./env_loader').loadEnvFile(path.join(__dirname, '..', '.env'));
require('./operational_log_formatter').instalarLogOperacional();
require('./bacbo_live_socket_bridge').instalarBacboLiveSocketBridge();
require('./telegram_signal_presenter').instalarTelegramSignalPresenter();
require('./telegram_signal_lifecycle').instalarTelegramSignalLifecycle();

async function iniciar() {
    const canonicalBridge = require('./bacbo_canonical_bridge');

    // Compatibilidade controlada: o motor antigo continua disponível como fallback,
    // mas sinais novos passam a usar o histórico canônico winner+result do Runtime V3.
    canonicalBridge.instalarCompatibilidadeSinais();

    const redisRuntime = require('./redis_runtime_v3');
    redisRuntime.instalarRedisRuntimeV3();

    const historySync = require('./tipminer_history_sync');
    try {
        await historySync.instalarTipMinerHistorySync(redisRuntime.processarBacbo);
    } catch (erro) {
        console.error(`⚠️ Sincronização inicial de histórico não iniciou: ${erro.message}`);
    }

    try {
        await require('./bacbo_map_snapshot').instalarBacboMapSnapshot();
    } catch (erro) {
        console.warn(`⚠️ Mapa Bac Bo: snapshot visual não iniciou: ${erro.message}`);
    }

    try {
        await require('./telegram_signal_config').migrarConfiguracoesTelegram();
    } catch (erro) {
        console.warn(`⚠️ Telegram: preferências visuais não foram migradas no bootstrap: ${erro.message}`);
    }

    // Barreira determinística: drena qualquer history_sync que tenha chegado durante o
    // bootstrap antes de construir a memória analítica/IA do backend principal.
    const estadoHistorico = await historySync.drenarHistoricoPendente('bootstrap_barrier');
    if (estadoHistorico.assinatura_processada) {
        console.log(`🔒 BOOTSTRAP | histórico consolidado | janela=${estadoHistorico.janela}.`);
    }

    // Registra a IA como consumidor crítico da barreira FINAL antes da criação do serviço.
    // O coletor só recebe ACK final depois que essa revalidação termina.
    require('./auto_pilot_history_barrier').instalarAutoPilotHistoryBarrier();

    // O backend só é carregado depois da hidratação/recovery e da barreira inicial acima.
    require('./bot2_coletor');
}

void iniciar().catch(erro => {
    console.error('🔥 Bootstrap do backend falhou:', erro);
    process.exitCode = 1;
});
