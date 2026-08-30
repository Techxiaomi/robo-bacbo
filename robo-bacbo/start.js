'use strict';

const path = require('path');

require('./env_loader').loadEnvFile(path.join(__dirname, '..', '.env'));
require('./operational_log_formatter').instalarLogOperacional();
require('./bacbo_live_socket_bridge').instalarBacboLiveSocketBridge();
require('./telegram_signal_presenter').instalarTelegramSignalPresenter();
require('./telegram_signal_lifecycle').instalarTelegramSignalLifecycle();
const { prepararSchemaMesas } = require('./mesa_schema');
const { prepararEscopoHistoricoMesaAtual } = require('./mesa_scope_migration');
const { definirMesaRuntime } = require('./mesa_runtime_context');
const {
    instalarIntegridadeSomaResultados
} = require('./mc27_result_sum_integrity');
const {
    instalarMesaNoTransporteLive,
    confirmarContratoMesaTransporteRuntime
} = require('./mesa_transport_context');
const { instalarGuardaMesaBackend } = require('./mesa_backend_guard');

async function iniciar() {
    const canonicalBridge = require('./bacbo_canonical_bridge');

    canonicalBridge.instalarCompatibilidadeSinais();

    // MC22-Y-A: nenhuma ingestao Redis/history pode existir antes
    // de a identidade imutavel da mesa estar definida.
    const mesaAtual = await prepararSchemaMesas();
    await prepararEscopoHistoricoMesaAtual(mesaAtual);

    const mesaRuntime = definirMesaRuntime(mesaAtual);
    console.log(
        `MC22-Y-A | Runtime de data plane fixado em ${mesaRuntime.codigo} ` +
        `(${mesaRuntime.tipo_jogo}) | id=${mesaRuntime.id}.`
    );

    // MC27: a soma do resultado e um dado canonico proprio. O ledger
    // analitico legado deixa de representar "desconhecido" como zero e
    // passa a ser reconciliado, por mesa, contra bacbo_rounds.
    await instalarIntegridadeSomaResultados();

    instalarMesaNoTransporteLive();

    const redisRuntime = require('./redis_runtime_v3');
    redisRuntime.instalarRedisRuntimeV3();

    const historySync = require('./tipminer_history_sync');
    try {
        await historySync.instalarTipMinerHistorySync(
            redisRuntime.processarBacbo
        );
    } catch (erro) {
        console.error(
            `Sincronizacao inicial de historico nao iniciou: ${erro.message}`
        );
    }

    try {
        await require('./bacbo_map_snapshot').instalarBacboMapSnapshot();
    } catch (erro) {
        console.warn(
            `Mapa Bac Bo: snapshot visual nao iniciou: ${erro.message}`
        );
    }

    try {
        await require('./telegram_signal_config').migrarConfiguracoesTelegram();
    } catch (erro) {
        console.warn(
            `Telegram: configuracoes visuais nao migradas: ${erro.message}`
        );
    }

    const estadoHistorico =
        await historySync.drenarHistoricoPendente(
            'bootstrap_barrier'
        );

    if (estadoHistorico.assinatura_processada) {
        console.log(
            `BOOTSTRAP | historico consolidado | ` +
            `janela=${estadoHistorico.janela}.`
        );
    }

    confirmarContratoMesaTransporteRuntime();
    instalarGuardaMesaBackend();

    require('./auto_pilot_history_barrier')
        .instalarAutoPilotHistoryBarrier();

    require('./bot2_coletor');
}

void iniciar().catch(erro => {
    console.error('🔥 Bootstrap do backend falhou:', erro);
    process.exitCode = 1;
});