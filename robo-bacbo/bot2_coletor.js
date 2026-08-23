const mysql = require("mysql2/promise");
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { createClient } = require("redis");
const {
    validarPoliticaProtecao,
    calcularPlanoAposta,
    calcularPnLEtapa
} = require("./tie_protection");
const { Server } = require("socket.io");
const { criarAutoPilotService } = require("./auto_pilot_ia");
const { criarControleDiarioAutoTrader } = require("./bug051b_daily_counter");
const { criarIntegracaoContadorDiario } = require("./bug051b_integration");
require("./env_loader").loadEnvFile(path.join(__dirname, "..", ".env"));

const REDIS_URL = String(process.env.REDIS_URL || "redis://127.0.0.1:6379/0").trim()
    || "redis://127.0.0.1:6379/0";
const REDIS_BACBO_HISTORY_KEY = String(
    process.env.REDIS_BACBO_HISTORY_KEY || "bacbo_history"
).trim() || "bacbo_history";
const REDIS_BACBO_EVENTS_CHANNEL = String(
    process.env.REDIS_BACBO_EVENTS_CHANNEL || "bacbo_events"
).trim() || "bacbo_events";
const REDIS_AUTO_TRADER_COMMANDS_CHANNEL = String(
    process.env.REDIS_AUTO_TRADER_COMMANDS_CHANNEL || "auto_trader_commands"
).trim() || "auto_trader_commands";
const LIMITE_UUIDS_TIPMINER_MEMORIA = 1000;

process.on('uncaughtException', (err) => {
    console.error('🔥 ERRO CRÍTICO NÃO TRATADO; encerrando processo:', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error('🔥 REJEIÇÃO DE PROMISE NÃO TRATADA; encerrando processo:', reason);
    process.exit(1);
});

const dbPool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

const controleDiarioAutoTrader = criarControleDiarioAutoTrader({
    dbPool,
    timezone: process.env.AUTO_TRADER_TIMEZONE || process.env.TZ || 'America/Sao_Paulo'
});

async function limparPadroesDinamicosOrfaos() {
    const conexao = await dbPool.getConnection();
    try {
        await conexao.beginTransaction();
        const [orfaos] = await conexao.query(`
            SELECT e.id
            FROM estrategias e
            LEFT JOIN robos_canais r ON r.id = e.robo_dono_id
            WHERE e.is_dinamico = true
              AND (e.robo_dono_id IS NULL OR r.id IS NULL)
        `);
        const ids = orfaos.map(row => String(row.id));
        if (ids.length > 0) {
            const placeholders = ids.map(() => '?').join(',');
            await conexao.query(`DELETE FROM historico_resultados WHERE estrategia_id IN (${placeholders})`, ids);
            await conexao.query(`DELETE FROM historico_disparos_robos WHERE estrategia_id IN (${placeholders})`, ids);
            await conexao.query(`DELETE FROM historico_shadow_ia WHERE estrategia_id IN (${placeholders})`, ids);
            await conexao.query(`DELETE FROM estrategias WHERE id IN (${placeholders}) AND is_dinamico = true`, ids);
        }
        const [historicosOrfaos] = await conexao.query(`
            DELETE h
            FROM historico_disparos_robos h
            LEFT JOIN robos_canais r ON r.id = h.robo_id
            WHERE r.id IS NULL
        `);
        await conexao.commit();
        const historicosRemovidos = Math.max(0, Number(historicosOrfaos.affectedRows) || 0);
        if (ids.length > 0 || historicosRemovidos > 0) {
            console.log(`🧹 Limpeza IA: ${ids.length} padrão(ões) dinâmico(s) órfão(s) e ${historicosRemovidos} histórico(s) de robô órfão(s) removido(s).`);
        }
        return { padroes: ids.length, historicos_robos: historicosRemovidos };
    } catch (e) {
        try { await conexao.rollback(); } catch (rollbackError) {
            console.error('❌ Rollback falhou na limpeza de padrões IA órfãos:', rollbackError.message);
        }
        throw e;
    } finally {
        conexao.release();
    }
}

async function prepararBancoDeDados() {
    try {
        await dbPool.query(`CREATE TABLE IF NOT EXISTS origens (id INT AUTO_INCREMENT PRIMARY KEY, nome VARCHAR(100))`);
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS estrategias (
                id VARCHAR(100) PRIMARY KEY, nome VARCHAR(100), origem VARCHAR(100), padrao TEXT,
                entrada VARCHAR(20), gales INT DEFAULT 0, proteger_empate BOOLEAN DEFAULT true,
                ativo BOOLEAN DEFAULT true, green_direto INT DEFAULT 0, gale1 INT DEFAULT 0,
                gale2 INT DEFAULT 0, red INT DEFAULT 0, ties_json TEXT,
                is_dinamico BOOLEAN DEFAULT false, robo_dono_id INT DEFAULT NULL,
                criado_em BIGINT DEFAULT 0, quarentena_restante INT DEFAULT 0
            )
        `);
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS historico_resultados (
                id INT AUTO_INCREMENT PRIMARY KEY, estrategia_id VARCHAR(100), tipo_resultado VARCHAR(20),
                nivel VARCHAR(20), multiplicador VARCHAR(10), data_hora DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS historico_shadow_ia (
                id BIGINT AUTO_INCREMENT PRIMARY KEY, estrategia_id VARCHAR(100) NOT NULL,
                robo_id INT NOT NULL, giro_resultado_id INT NOT NULL, tipo_resultado VARCHAR(20) NOT NULL,
                nivel VARCHAR(20) DEFAULT 'DIRETO', multiplicador VARCHAR(10) DEFAULT '',
                data_hora DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_shadow_estrategia_giro (estrategia_id, giro_resultado_id),
                INDEX idx_shadow_robo (robo_id), INDEX idx_shadow_estrategia (estrategia_id)
            )
        `);
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS giros_recentes (
                id INT AUTO_INCREMENT PRIMARY KEY, resultado VARCHAR(20), p_d1 INT DEFAULT 0,
                p_d2 INT DEFAULT 0, b_d1 INT DEFAULT 0, b_d2 INT DEFAULT 0,
                numero_empate INT DEFAULT 0, multiplicador VARCHAR(10) DEFAULT '',
                id_sessao BIGINT, data_hora DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS robos_canais (
                id INT AUTO_INCREMENT PRIMARY KEY, nome VARCHAR(100), tag_visual VARCHAR(20),
                cor_hex VARCHAR(10) DEFAULT '#007bff', telegram_token VARCHAR(100),
                telegram_chat_id VARCHAR(50), enviar_telegram BOOLEAN DEFAULT true,
                enviar_web BOOLEAN DEFAULT true, min_assertividade INT DEFAULT 0,
                stop_reds_seguidos INT DEFAULT 0, greens_consecutivos INT DEFAULT 0,
                reds_consecutivos INT DEFAULT 0, standby_ate BIGINT DEFAULT 0,
                historico_reds_json TEXT, ativo BOOLEAN DEFAULT true, config_json TEXT
            )
        `);
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS destinatarios_robo (
                id INT AUTO_INCREMENT PRIMARY KEY, robo_id INT, nome_cliente VARCHAR(100), chat_id VARCHAR(50),
                FOREIGN KEY (robo_id) REFERENCES robos_canais(id) ON DELETE CASCADE
            )
        `);
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS historico_disparos_robos (
                id INT AUTO_INCREMENT PRIMARY KEY, robo_id INT, estrategia_id VARCHAR(100),
                tipo_resultado VARCHAR(20), nivel VARCHAR(20), multiplicador VARCHAR(10),
                estrategia_origem VARCHAR(100) DEFAULT '', data_hora DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS auto_traders (
                id INT AUTO_INCREMENT PRIMARY KEY, nome VARCHAR(100), ativo BOOLEAN DEFAULT false,
                config_json TEXT, saldo_inicial DECIMAL(12,2) DEFAULT 0, saldo_atual DECIMAL(12,2) DEFAULT 0,
                status_operacao VARCHAR(50) DEFAULT 'STANDBY', entradas_feitas INT DEFAULT 0,
                pulos_restantes INT DEFAULT 0, data_contador_entradas VARCHAR(10) DEFAULT NULL,
                reds_consecutivos INT DEFAULT 0, stop_reds_pausado_ate BIGINT DEFAULT 0,
                trailing_pico_lucro DECIMAL(12,2) DEFAULT 0,
                data_atualizacao DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS auditoria_ordens (
                id INT AUTO_INCREMENT PRIMARY KEY, trader_id INT, estrategia_nome VARCHAR(100),
                fonte_sinal VARCHAR(100), alvo VARCHAR(20), nivel VARCHAR(20), risco_total DECIMAL(12,2),
                valor_entrada DECIMAL(12,2), valor_empate DECIMAL(12,2) DEFAULT 0,
                executor_order_id VARCHAR(64) DEFAULT NULL, executor_confirmacao_metodo VARCHAR(40) DEFAULT NULL,
                executor_saldo_antes DECIMAL(12,2) DEFAULT NULL, executor_saldo_depois DECIMAL(12,2) DEFAULT NULL,
                executor_debito_observado DECIMAL(12,2) DEFAULT NULL, execucao_confirmada_em BIGINT DEFAULT NULL,
                status_ordem VARCHAR(20) DEFAULT 'PENDENTE', placar_mesa VARCHAR(50) DEFAULT '',
                lucro_prejuizo DECIMAL(12,2) DEFAULT 0, saldo_pos DECIMAL(12,2) DEFAULT NULL,
                resultado_confirmado_em BIGINT DEFAULT NULL, saldo_pos_confirmado_em BIGINT DEFAULT NULL,
                data_hora DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (trader_id) REFERENCES auto_traders(id) ON DELETE CASCADE
            )
        `);

        const adicionarColuna = async (query) => {
            try { await dbPool.query(query); }
            catch (e) {
                if (e && (e.code === 'ER_DUP_FIELDNAME' || Number(e.errno) === 1060)) return;
                console.error(`❌ Falha em migration incremental: ${query}`, e.message);
                throw e;
            }
        };

        await adicionarColuna("ALTER TABLE robos_canais ADD COLUMN config_json TEXT");
        await adicionarColuna("ALTER TABLE robos_canais ADD COLUMN enviar_web BOOLEAN DEFAULT true");
        await adicionarColuna("ALTER TABLE robos_canais ADD COLUMN enviar_telegram BOOLEAN DEFAULT true");
        await adicionarColuna("ALTER TABLE robos_canais ADD COLUMN stop_reds_seguidos INT DEFAULT 0");
        await adicionarColuna("ALTER TABLE robos_canais ADD COLUMN min_assertividade INT DEFAULT 0");
        await adicionarColuna("ALTER TABLE robos_canais ADD COLUMN greens_consecutivos INT DEFAULT 0");
        await adicionarColuna("ALTER TABLE robos_canais ADD COLUMN reds_consecutivos INT DEFAULT 0");
        await adicionarColuna("ALTER TABLE robos_canais ADD COLUMN standby_ate BIGINT DEFAULT 0");
        await adicionarColuna("ALTER TABLE robos_canais ADD COLUMN historico_reds_json TEXT");
        await adicionarColuna("ALTER TABLE estrategias ADD COLUMN is_dinamico BOOLEAN DEFAULT false");
        await adicionarColuna("ALTER TABLE estrategias ADD COLUMN robo_dono_id INT DEFAULT NULL");
        await adicionarColuna("ALTER TABLE estrategias ADD COLUMN criado_em BIGINT DEFAULT 0");
        await adicionarColuna("ALTER TABLE estrategias ADD COLUMN quarentena_restante INT DEFAULT 0");
        await adicionarColuna("ALTER TABLE estrategias ADD COLUMN ia_status VARCHAR(30) DEFAULT NULL");
        await adicionarColuna("ALTER TABLE historico_disparos_robos ADD COLUMN estrategia_origem VARCHAR(100) DEFAULT ''");
        await adicionarColuna("ALTER TABLE auditoria_ordens ADD COLUMN executor_order_id VARCHAR(64) DEFAULT NULL");
        await adicionarColuna("ALTER TABLE auditoria_ordens ADD COLUMN valor_empate DECIMAL(12,2) DEFAULT 0");
        await adicionarColuna("ALTER TABLE auditoria_ordens ADD COLUMN executor_confirmacao_metodo VARCHAR(40) DEFAULT NULL");
        await adicionarColuna("ALTER TABLE auditoria_ordens ADD COLUMN executor_saldo_antes DECIMAL(12,2) DEFAULT NULL");
        await adicionarColuna("ALTER TABLE auditoria_ordens ADD COLUMN executor_saldo_depois DECIMAL(12,2) DEFAULT NULL");
        await adicionarColuna("ALTER TABLE auditoria_ordens ADD COLUMN executor_debito_observado DECIMAL(12,2) DEFAULT NULL");
        await adicionarColuna("ALTER TABLE auditoria_ordens ADD COLUMN execucao_confirmada_em BIGINT DEFAULT NULL");
        await adicionarColuna("ALTER TABLE auditoria_ordens ADD COLUMN resultado_confirmado_em BIGINT DEFAULT NULL");
        await adicionarColuna("ALTER TABLE auditoria_ordens ADD COLUMN saldo_pos_confirmado_em BIGINT DEFAULT NULL");
        await dbPool.query("ALTER TABLE auditoria_ordens MODIFY COLUMN saldo_pos DECIMAL(12,2) DEFAULT NULL");
        await adicionarColuna("ALTER TABLE auto_traders ADD COLUMN reds_consecutivos INT DEFAULT 0");
        await adicionarColuna("ALTER TABLE auto_traders ADD COLUMN stop_reds_pausado_ate BIGINT DEFAULT 0");
        await adicionarColuna("ALTER TABLE auto_traders ADD COLUMN trailing_pico_lucro DECIMAL(12,2) DEFAULT 0");
        await adicionarColuna("ALTER TABLE auto_traders ADD COLUMN data_contador_entradas VARCHAR(10) DEFAULT NULL");
        await integracaoContadorDiario.inicializarDatasLegadas();
        await dbPool.query(`UPDATE auto_traders SET status_operacao='DESLIGADO' WHERE ativo=false AND status_operacao IN ('OPERANDO','STANDBY')`);
        await limparPadroesDinamicosOrfaos();
        console.log("\n========================================================");
        console.log("🚀 MÓDULO BACKEND V12.0 PRO - MOTOR DE EXECUÇÃO INTEGRADO");
        console.log("========================================================\n");
    } catch (e) {
        console.error("❌ Erro Crítico ao preparar banco de dados:", e.message);
        throw e;
    }
}

let ESTRATEGIAS_MEMORIA = [];
let ROBOS_MEMORIA = [];
let AUTO_TRADERS_MEMORIA = [];
let historicoGirosAnalitico = [];
let estadoApostas = {};
let estadoStandbyRobos = {};
let idSessaoContinua = Date.now();
let estadoContinuidadeColetor = { sessao: null, seq: null, timestamp_coleta: null };
let estadoContinuidadeRecepcao = { sessao: null, seq: null, timestamp_coleta: null };
let caudaProcessamentoResultados = Promise.resolve();
let resultadosAguardandoProcessamento = 0;
let caudaEventosRedisBacBo = Promise.resolve();
const uuidsTipMinerRecentes = new Set();
const estadoTipMinerRedis = { sessao: null, live_seq: 0, ultimo_uuid: null, sincronizado_em: 0 };
const redisBacBoClient = createClient({ url: REDIS_URL });
const redisBacBoSubscriber = redisBacBoClient.duplicate();
redisBacBoClient.on('error', erro => console.error('❌ REDIS BAC BO | cliente de dados:', erro.message));
redisBacBoSubscriber.on('error', erro => console.error('❌ REDIS BAC BO | subscriber:', erro.message));

const ORIENTACAO_ROAD_NATIVA = Object.freeze({ OLD_TO_NEW: 'OLD_TO_NEW', NEW_TO_OLD: 'NEW_TO_OLD' });
const LIMITE_HISTORY_ROAD_NATIVA = 1000;
const roadInactivityTimeoutConfig = Number(process.env.ROAD_INACTIVITY_TIMEOUT_MS || 120000);
const ROAD_INACTIVITY_TIMEOUT_MS = Number.isFinite(roadInactivityTimeoutConfig)
    && roadInactivityTimeoutConfig >= 30000 && roadInactivityTimeoutConfig <= 600000
    ? Math.trunc(roadInactivityTimeoutConfig) : 120000;
const estadoRoadNativo = {
    pronto: false, orientacao: null, history: [], coletor_sessao: null, sessao_ingestao: null,
    aguardando_snapshot: true, em_sincronizacao: true, hard_reset_em: 0, snapshot_alocado_em: 0,
    ultimo_pacote_em: 0, ultimo_incremental_legitimo_em: 0, orientacao_preservada: null,
    sessao_preservada: null, sessao_snapshot_esperada: null, atualizado_em: null
};

function resultadoRoadNativo(valor) {
    const texto = String(valor ?? '').trim();
    const indicePayload = texto.indexOf(':');
    const token = indicePayload >= 0 ? texto.slice(0, indicePayload) : texto;
    const bruto = token.toLowerCase().normalize('NFD');
    let compacto = '';
    for (const caractere of bruto) {
        const codigo = caractere.charCodeAt(0);
        if ((codigo >= 97 && codigo <= 122) || (codigo >= 48 && codigo <= 57)) compacto += caractere;
    }
    if (['p','player','playerwon','jogador','azul'].includes(compacto)) return 'Player';
    if (['b','banker','bankerwon','banca','vermelho'].includes(compacto)) return 'Banker';
    if (['t','tie','tiewon','empate','draw'].includes(compacto)) return 'Tie';
    return '';
}

function normalizarPadraoRoadNativo(padrao) {
    let itens = padrao;
    if (!Array.isArray(itens) && typeof itens === 'string') {
        try { itens = JSON.parse(itens); } catch (e) { return null; }
    }
    if (!Array.isArray(itens) || itens.length === 0) return null;
    const normalizados = itens.map(resultadoRoadNativo);
    return normalizados.some(item => !item) ? null : normalizados;
}

function numeroRoadNativo(valor) {
    if (valor === null || valor === undefined || typeof valor === 'boolean' || valor === '') return null;
    const numero = Number(valor);
    return Number.isFinite(numero) ? Math.trunc(numero) : null;
}

function sessaoIngestaoRoad(dados) {
    for (const candidato of [dados?.id_sessao, dados?.coletor_sessao]) {
        if (candidato === null || candidato === undefined) continue;
        const valor = String(candidato).trim();
        if (valor && valor.length <= 128) return valor;
    }
    return '';
}

function scoreRoadDoResultado(dados, lado) {
    const direto = numeroRoadNativo(dados?.[lado === 'player' ? 'playerScore' : 'bankerScore']);
    if (direto !== null) return direto;
    const pontos = numeroRoadNativo(dados?.[lado === 'player' ? 'pontos_jogador' : 'pontos_banca']);
    if (pontos !== null) return pontos;
    const dadosLado = lado === 'player' ? dados?.dados_jogador : dados?.dados_banca;
    if (!Array.isArray(dadosLado) || dadosLado.length === 0) return null;
    let total = 0;
    for (const valor of dadosLado) {
        const numero = numeroRoadNativo(valor);
        if (numero === null) return null;
        total += numero;
    }
    return total;
}

function normalizarGiroRoadNativo(dados, coletorSessaoFallback = '') {
    const resultado = resultadoRoadNativo(dados?.winner || dados?.vencedor || dados?.resultado);
    if (!resultado) return null;
    const playerScore = scoreRoadDoResultado(dados, 'player');
    const bankerScore = scoreRoadDoResultado(dados, 'banker');
    if (playerScore !== null && (playerScore < 0 || playerScore > 12)) return null;
    if (bankerScore !== null && (bankerScore < 0 || bankerScore > 12)) return null;
    const sessao = sessaoIngestaoRoad(dados) || String(coletorSessaoFallback || '').trim();
    const timestamp = numeroRoadNativo(dados?.timestamp_ms ?? dados?.timestamp_coleta ?? dados?.timestamp);
    const seq = numeroRoadNativo(dados?.coletor_seq ?? dados?.coletorSeq);
    const tipminerResult = numeroRoadNativo(dados?.tipminer_result ?? dados?.result_total);
    return {
        resultado, winner: resultado, playerScore, bankerScore, tipminerResult,
        round_id: String(dados?.round_id || dados?.roundId || dados?.uuid || '').trim() || null,
        coletor_seq: seq !== null && seq > 0 ? seq : null,
        timestamp_ms: timestamp !== null && timestamp > 0 ? timestamp : 0,
        id_sessao: sessao || 'TIPMINER_CANONICA'
    };
}

function mesmoGiroRoadNativo(a,b) {
    if (!a || !b) return false;
    const roundA = String(a.round_id || a.roundId || a.uuid || '').trim();
    const roundB = String(b.round_id || b.roundId || b.uuid || '').trim();
    if (roundA && roundB) return roundA === roundB;
    if (resultadoRoadNativo(a.resultado || a.winner) !== resultadoRoadNativo(b.resultado || b.winner)) return false;
    const playerA = numeroRoadNativo(a.playerScore), playerB = numeroRoadNativo(b.playerScore);
    const bankerA = numeroRoadNativo(a.bankerScore), bankerB = numeroRoadNativo(b.bankerScore);
    if (playerA !== null && playerB !== null && bankerA !== null && bankerB !== null) return playerA === playerB && bankerA === bankerB;
    const totalA = numeroRoadNativo(a.tipminerResult ?? a.tipminer_result);
    const totalB = numeroRoadNativo(b.tipminerResult ?? b.tipminer_result);
    return totalA !== null && totalB !== null && totalA === totalB;
}

function orientacaoRoadDoCoreCanonico(sessaoEsperada='') {
    try {
        const estadoCore = integracaoContadorDiario.obterHistoricoCanonicoLive();
        const orientacao = estadoCore?.orientacao;
        const sessaoCore = String(estadoCore?.coletor_sessao || '').trim();
        const sessao = String(sessaoEsperada || estadoRoadNativo.coletor_sessao || '').trim();
        const valida = orientacao === ORIENTACAO_ROAD_NATIVA.OLD_TO_NEW || orientacao === ORIENTACAO_ROAD_NATIVA.NEW_TO_OLD;
        if (estadoCore?.pronto !== true || !valida) return null;
        if (sessao && sessaoCore && sessao !== sessaoCore) return null;
        return orientacao;
    } catch (e) { return null; }
}

function avaliarGatilhoHardResetRoad(dados, recebidoEm=Date.now(), {registrarPacote=false}={}) {
    const agora = Number.isFinite(Number(recebidoEm)) ? Math.trunc(Number(recebidoEm)) : Date.now();
    const sessaoRecebida = sessaoIngestaoRoad(dados);
    const sessaoAnterior = String(estadoRoadNativo.sessao_ingestao || estadoRoadNativo.coletor_sessao || '').trim();
    const ultimoPacoteEm = Number(estadoRoadNativo.ultimo_pacote_em) || 0;
    const idadePacoteMs = ultimoPacoteEm > 0 ? Math.max(0, agora - ultimoPacoteEm) : null;
    const mudouSessao = Boolean(sessaoRecebida && sessaoAnterior && sessaoRecebida !== sessaoAnterior);
    const timeoutConfirmado = idadePacoteMs !== null && idadePacoteMs >= ROAD_INACTIVITY_TIMEOUT_MS;
    if (registrarPacote) {
        if (sessaoRecebida) estadoRoadNativo.sessao_ingestao = sessaoRecebida;
        estadoRoadNativo.ultimo_pacote_em = agora;
    }
    if (mudouSessao) return {reset:true,motivo:'MUDANCA_ID_SESSAO_INGESTAO',sessao_esperada:sessaoRecebida,idade_pacote_ms:idadePacoteMs};
    if (timeoutConfirmado) return {reset:true,motivo:`TIMEOUT_INATIVIDADE_ROAD_${idadePacoteMs}MS`,sessao_esperada:sessaoRecebida||sessaoAnterior,idade_pacote_ms:idadePacoteMs};
    return {reset:false,motivo:null,sessao_esperada:sessaoRecebida||sessaoAnterior,idade_pacote_ms:idadePacoteMs};
}

function hardResetSnapshotRoad(motivo, sessaoEsperada='') {
    const sessaoEsperadaNormalizada = String(sessaoEsperada || '').trim();
    const sessaoEsperadaAtual = String(estadoRoadNativo.sessao_snapshot_esperada || '').trim();
    if (estadoRoadNativo.aguardando_snapshot && estadoRoadNativo.hard_reset_em > 0 && (!sessaoEsperadaNormalizada || sessaoEsperadaNormalizada === sessaoEsperadaAtual)) return false;
    const orientacaoAnterior = estadoRoadNativo.orientacao || estadoRoadNativo.orientacao_preservada;
    const sessaoAnterior = estadoRoadNativo.coletor_sessao || estadoRoadNativo.sessao_preservada;
    Object.assign(estadoRoadNativo, {
        history: [], pronto: false, orientacao: null, aguardando_snapshot: true, em_sincronizacao: true,
        hard_reset_em: Date.now(), snapshot_alocado_em: 0, ultimo_incremental_legitimo_em: 0,
        orientacao_preservada: orientacaoAnterior || null, sessao_preservada: sessaoAnterior || null,
        sessao_snapshot_esperada: sessaoEsperadaNormalizada || String(estadoRoadNativo.sessao_ingestao || '').trim() || null
    });
    estadoRoadNativo.atualizado_em = estadoRoadNativo.hard_reset_em;
    console.warn(`🧹 ROAD HARD RESET | memória zerada após ${String(motivo || 'QUEBRA_CONTINUIDADE')}; motor de padrões em sincronização até snapshot fresco + rodada incremental legítima.`);
    return true;
}

function substituirRoadPorSnapshotFresco(dados, recebidoEm=Date.now()) {
    if (!estadoRoadNativo.aguardando_snapshot) return false;
    const history = Array.isArray(dados?.history) ? dados.history : [];
    const sessao = sessaoIngestaoRoad(dados);
    if (!sessao || history.length === 0) return false;
    const esperado = String(estadoRoadNativo.sessao_snapshot_esperada || '').trim();
    if (esperado && sessao !== esperado) return false;
    if (estadoRoadNativo.hard_reset_em > 0 && recebidoEm < estadoRoadNativo.hard_reset_em) return false;
    const normalizados = history.map(item => normalizarGiroRoadNativo(item, sessao));
    if (normalizados.some(item => item === null)) return false;
    const orientacaoDeclarada = String(dados?.orientacao || '').trim();
    const orientacaoDeclaradaValida = orientacaoDeclarada === ORIENTACAO_ROAD_NATIVA.OLD_TO_NEW || orientacaoDeclarada === ORIENTACAO_ROAD_NATIVA.NEW_TO_OLD;
    const orientacaoPreservada = estadoRoadNativo.orientacao_preservada;
    const orientacao = orientacaoDeclaradaValida ? orientacaoDeclarada : ((orientacaoPreservada === ORIENTACAO_ROAD_NATIVA.OLD_TO_NEW || orientacaoPreservada === ORIENTACAO_ROAD_NATIVA.NEW_TO_OLD) ? orientacaoPreservada : orientacaoRoadDoCoreCanonico(sessao));
    const alocadoEm = Date.now();
    Object.assign(estadoRoadNativo, {
        history: normalizados, coletor_sessao: sessao, sessao_ingestao: sessao, orientacao,
        pronto: false, aguardando_snapshot: false, em_sincronizacao: true, hard_reset_em: 0,
        snapshot_alocado_em: alocadoEm, ultimo_pacote_em: alocadoEm, ultimo_incremental_legitimo_em: 0,
        orientacao_preservada: null, sessao_preservada: null, sessao_snapshot_esperada: null, atualizado_em: alocadoEm
    });
    console.log(`♻️ ROAD SNAPSHOT | memória substituída integralmente por ${estadoRoadNativo.history.length} giro(s); motor em sincronização, gatilhos bloqueados até a primeira rodada incremental legítima pós-snapshot.`);
    return true;
}

function atualizarRoadNativoComIncremental(dados, recebidoEm=Date.now()) {
    if (estadoRoadNativo.aguardando_snapshot || estadoRoadNativo.history.length === 0) return false;
    const instanteRecebimento = Number.isFinite(Number(recebidoEm)) ? Math.trunc(Number(recebidoEm)) : Date.now();
    if (estadoRoadNativo.em_sincronizacao && estadoRoadNativo.snapshot_alocado_em > 0 && instanteRecebimento <= estadoRoadNativo.snapshot_alocado_em) return false;
    const sessaoRecebida = sessaoIngestaoRoad(dados);
    if (sessaoRecebida && estadoRoadNativo.coletor_sessao && sessaoRecebida !== estadoRoadNativo.coletor_sessao) {
        hardResetSnapshotRoad('MUDANCA_ID_SESSAO_INGESTAO', sessaoRecebida); return false;
    }
    const giro = normalizarGiroRoadNativo(dados, estadoRoadNativo.coletor_sessao);
    if (!giro) return false;
    const primeiro = estadoRoadNativo.history[0];
    const ultimo = estadoRoadNativo.history[estadoRoadNativo.history.length-1];
    const casaPrimeiro = mesmoGiroRoadNativo(giro, primeiro), casaUltimo = mesmoGiroRoadNativo(giro, ultimo);
    if (!estadoRoadNativo.orientacao) {
        const orientacaoCore = orientacaoRoadDoCoreCanonico(sessaoRecebida || estadoRoadNativo.coletor_sessao);
        if (orientacaoCore) estadoRoadNativo.orientacao = orientacaoCore;
        else if (casaPrimeiro !== casaUltimo) estadoRoadNativo.orientacao = casaPrimeiro ? ORIENTACAO_ROAD_NATIVA.NEW_TO_OLD : ORIENTACAO_ROAD_NATIVA.OLD_TO_NEW;
        else return false;
    }
    const pontaNova = estadoRoadNativo.orientacao === ORIENTACAO_ROAD_NATIVA.NEW_TO_OLD ? estadoRoadNativo.history[0] : estadoRoadNativo.history[estadoRoadNativo.history.length-1];
    if (mesmoGiroRoadNativo(giro,pontaNova)) { estadoRoadNativo.atualizado_em = instanteRecebimento; return false; }
    if (estadoRoadNativo.orientacao === ORIENTACAO_ROAD_NATIVA.NEW_TO_OLD) {
        estadoRoadNativo.history.unshift(giro); if (estadoRoadNativo.history.length > LIMITE_HISTORY_ROAD_NATIVA) estadoRoadNativo.history.pop();
    } else {
        estadoRoadNativo.history.push(giro); if (estadoRoadNativo.history.length > LIMITE_HISTORY_ROAD_NATIVA) estadoRoadNativo.history.shift();
    }
    const estavaSincronizando = estadoRoadNativo.em_sincronizacao;
    estadoRoadNativo.em_sincronizacao = false; estadoRoadNativo.pronto = true;
    estadoRoadNativo.ultimo_incremental_legitimo_em = instanteRecebimento; estadoRoadNativo.atualizado_em = instanteRecebimento;
    if (estavaSincronizando) console.log('✅ ROAD LIVE | primeira rodada incremental legítima pós-snapshot recebida; gatilhos ao vivo liberados.');
    return true;
}

function obterHistoricoRoadNativo() {
    const orientacaoValida = estadoRoadNativo.orientacao === ORIENTACAO_ROAD_NATIVA.OLD_TO_NEW || estadoRoadNativo.orientacao === ORIENTACAO_ROAD_NATIVA.NEW_TO_OLD;
    if (estadoRoadNativo.aguardando_snapshot || estadoRoadNativo.em_sincronizacao || estadoRoadNativo.pronto !== true || !orientacaoValida || estadoRoadNativo.history.length === 0) {
        return {pronto:false,em_sincronizacao:estadoRoadNativo.em_sincronizacao,orientacao:estadoRoadNativo.orientacao,history:[],coletor_sessao:estadoRoadNativo.coletor_sessao};
    }
    const cronologico = estadoRoadNativo.orientacao === ORIENTACAO_ROAD_NATIVA.NEW_TO_OLD ? [...estadoRoadNativo.history].reverse() : [...estadoRoadNativo.history];
    return {pronto:true,em_sincronizacao:false,orientacao:estadoRoadNativo.orientacao,history:cronologico.slice(-LIMITE_HISTORY_ROAD_NATIVA),coletor_sessao:estadoRoadNativo.coletor_sessao,atualizado_em:estadoRoadNativo.atualizado_em};
}

function estrategiaCombinaFimRoadNativo(est,historico) {
    const padrao = normalizarPadraoRoadNativo(est?.padrao), road = Array.isArray(historico)?historico:[];
    if (!padrao || road.length < padrao.length) return false;
    const fim = road.slice(-padrao.length);
    return fim.every((giro,indice)=>resultadoRoadNativo(giro?.resultado||giro?.winner)===padrao[indice]);
}

function aguardarTurnoProcessamentoResultado() {
    resultadosAguardandoProcessamento++;
    const turnoAnterior = caudaProcessamentoResultados;
    let liberarProximo = null;
    caudaProcessamentoResultados = new Promise(resolve => { liberarProximo = resolve; });
    return turnoAnterior.then(() => {
        let liberado = false;
        return () => {
            if (liberado) return false;
            liberado = true;
            resultadosAguardandoProcessamento = Math.max(0,resultadosAguardandoProcessamento-1);
            liberarProximo(); return true;
        };
    });
}

function reservarContinuidadeResultado(dados) {
    const continuidade = avaliarContinuidadeResultado(estadoContinuidadeRecepcao,dados);
    if (continuidade.aceitar) estadoContinuidadeRecepcao={...continuidade.estado};
    return continuidade;
}

let saldoGlobalCorretora=null, saldoGlobalAtualizadoEm=0, backendPronto=false;
let contadorGirosParaLimpeza=0, contadorGirosGlobalPiloto=0;

function hostNodeEhLoopback(host) {
    const normalizado=String(host||'').trim().toLowerCase(); return normalizado==='127.0.0.1'||normalizado==='localhost'||normalizado==='::1';
}
function hostPermitidoParaNode(hostHeader,nodeHost,porta) {
    const recebido=String(hostHeader||'').trim().toLowerCase(); if(!recebido)return false;
    const hostConfigurado=String(nodeHost||'').trim().toLowerCase(),portaTexto=String(porta);
    if(hostNodeEhLoopback(hostConfigurado))return new Set([`127.0.0.1:${portaTexto}`,`localhost:${portaTexto}`,`[::1]:${portaTexto}`]).has(recebido);
    const hostFormatado=hostConfigurado.includes(':')&&!hostConfigurado.startsWith('[')?`[${hostConfigurado}]`:hostConfigurado;
    return recebido===`${hostFormatado}:${portaTexto}`;
}
function origemCombinaComHost(origin,host) {
    if(!origin)return true;if(!host)return false;try{const u=new URL(origin);return(u.protocol==='http:'||u.protocol==='https:')&&u.host.toLowerCase()===String(host).toLowerCase();}catch(e){return false;}
}
function compararTextoSeguro(recebido,esperado){const a=Buffer.from(String(recebido??''),'utf8'),b=Buffer.from(String(esperado??''),'utf8');return a.length===b.length&&crypto.timingSafeEqual(a,b);}
function cookiesDoHeader(h){const c={};for(const p of String(h||'').split(';')){const i=p.indexOf('=');if(i<=0)continue;const n=p.slice(0,i).trim(),v=p.slice(i+1).trim();if(!n)continue;try{c[n]=decodeURIComponent(v);}catch(e){c[n]=v;}}return c;}
function limparSessoesAdminExpiradas(agora=Date.now()){for(const[token,expiraEm]of SESSOES_ADMIN.entries())if(!Number.isFinite(expiraEm)||expiraEm<=agora)SESSOES_ADMIN.delete(token);}
function criarSessaoAdmin(agora=Date.now()){limparSessoesAdminExpiradas(agora);const token=crypto.randomBytes(32).toString('hex');SESSOES_ADMIN.set(token,agora+ADMIN_SESSION_TTL_MS);return token;}
function tokenSessaoAdminDoCookie(h){return cookiesDoHeader(h)[ADMIN_SESSION_COOKIE]||'';}
function sessaoAdminValidaCookie(h,agora=Date.now()){if(!ADMIN_AUTH_REQUIRED)return true;limparSessoesAdminExpiradas(agora);const t=tokenSessaoAdminDoCookie(h);if(!t)return false;const e=SESSOES_ADMIN.get(t);if(!Number.isFinite(e)||e<=agora){SESSOES_ADMIN.delete(t);return false;}return true;}
function cookieSessaoAdmin(token,maxAgeSeconds){const secure=ADMIN_COOKIE_SECURE?'; Secure':'';return `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.max(0,Math.floor(maxAgeSeconds))}${secure}`;}

const NODE_HOST=(process.env.NODE_HOST||'127.0.0.1').trim()||'127.0.0.1';
const PORTA=Number(process.env.NODE_PORT||3000);
const INTERNAL_API_TOKEN=(process.env.INTERNAL_API_TOKEN||'').trim();
const ADMIN_USERNAME=(process.env.ADMIN_USERNAME||'').trim();
const ADMIN_PASSWORD=String(process.env.ADMIN_PASSWORD||'');
const adminSessionTtlMinutesConfig=Number(process.env.ADMIN_SESSION_TTL_MINUTES||720);
const ADMIN_SESSION_TTL_MS=(Number.isFinite(adminSessionTtlMinutesConfig)&&adminSessionTtlMinutesConfig>=5&&adminSessionTtlMinutesConfig<=1440?adminSessionTtlMinutesConfig:720)*60*1000;
const ADMIN_SESSION_COOKIE='bacbo_admin_session';
const adminCookieSecureConfig=String(process.env.ADMIN_COOKIE_SECURE||'').trim().toLowerCase();
const ADMIN_COOKIE_SECURE=adminCookieSecureConfig==='true'||(adminCookieSecureConfig!=='false'&&!hostNodeEhLoopback(NODE_HOST));
const SESSOES_ADMIN=new Map();
const ADMIN_AUTH_CONFIGURED=Boolean(ADMIN_USERNAME||ADMIN_PASSWORD);
const ADMIN_AUTH_REQUIRED=!hostNodeEhLoopback(NODE_HOST)||ADMIN_AUTH_CONFIGURED;
if(ADMIN_AUTH_REQUIRED&&(!ADMIN_USERNAME||!ADMIN_PASSWORD))throw new Error('ADMIN_USERNAME/ADMIN_PASSWORD incompletos. Fora do loopback a autenticacao administrativa e obrigatoria.');
if(!INTERNAL_API_TOKEN)throw new Error('INTERNAL_API_TOKEN nao configurado. Defina o segredo compartilhado no .env antes de iniciar o backend.');
function requisicaoInternaAutorizada(req){const a=Buffer.from(req.get('X-Internal-Token')||'','utf8'),b=Buffer.from(INTERNAL_API_TOKEN,'utf8');return a.length===b.length&&crypto.timingSafeEqual(a,b);}

const app=express();
app.use((req,res,next)=>{const host=req.get('Host');if(!hostPermitidoParaNode(host,NODE_HOST,PORTA)||!origemCombinaComHost(req.get('Origin'),host))return res.status(403).json({erro:'Origem ou host nao permitido'});next();});
app.use(express.json());app.use(express.urlencoded({extended:false}));
app.get('/login',(req,res)=>{if(!ADMIN_AUTH_REQUIRED||sessaoAdminValidaCookie(req.get('Cookie')))return res.redirect('/');return res.sendFile(path.join(__dirname,'public','login.html'));});
app.post('/auth/login',(req,res)=>{if(!ADMIN_AUTH_REQUIRED)return res.redirect('/');const usuario=String(req.body?.usuario||'').trim(),senha=String(req.body?.senha||'');if(!compararTextoSeguro(usuario,ADMIN_USERNAME)||!compararTextoSeguro(senha,ADMIN_PASSWORD))return res.redirect('/login?erro=1');const token=criarSessaoAdmin();res.setHeader('Set-Cookie',cookieSessaoAdmin(token,Math.floor(ADMIN_SESSION_TTL_MS/1000)));return res.redirect('/');});
app.post('/auth/logout',(req,res)=>{const token=tokenSessaoAdminDoCookie(req.get('Cookie'));if(token)SESSOES_ADMIN.delete(token);res.setHeader('Set-Cookie',cookieSessaoAdmin('',0));return res.redirect(ADMIN_AUTH_REQUIRED?'/login':'/');});
app.use((req,res,next)=>{const rotaInterna=req.path==='/executor-status'||req.path==='/collector-health';if(rotaInterna)return next();if(!ADMIN_AUTH_REQUIRED||sessaoAdminValidaCookie(req.get('Cookie')))return next();if(req.path.startsWith('/api/'))return res.status(401).json({erro:'autenticacao_administrativa_necessaria'});return res.redirect('/login');});
app.use((req,res,next)=>{const depende=req.path==='/executor-status'||req.path==='/collector-health'||req.path.startsWith('/api/');if(depende&&!backendPronto)return res.status(503).json({erro:'backend_inicializando'});next();});
app.use(express.static(path.join(__dirname,'public')));

const executorExecutionTimeoutConfig=Number(process.env.EXECUTOR_EXECUTION_TIMEOUT_MS||210000);
const EXECUTOR_EXECUTION_TIMEOUT_MS=Number.isFinite(executorExecutionTimeoutConfig)&&executorExecutionTimeoutConfig>=195000&&executorExecutionTimeoutConfig<=360000?executorExecutionTimeoutConfig:210000;
const EXECUTOR_MAX_ATTEMPTS=2;
const CONFIRMACOES_EXECUTOR_PENDENTES=new Map();
const STATUS_EXECUTOR_VALIDOS=new Set(['EXECUTADA','FALHOU','EXPIRADA','AMBIGUA']);
const INTERRUPCOES_COLETOR_PROCESSADAS=new Map();
const LIMITE_INTERRUPCOES_COLETOR_MEMORIA=1000;
const TELEGRAM_TIMEOUT_MS=3000;
const balanceSyncMaxAgeSecondsConfig=Number(process.env.BALANCE_SYNC_MAX_AGE_SECONDS||90);
const BALANCE_SYNC_MAX_AGE_MS=(Number.isFinite(balanceSyncMaxAgeSecondsConfig)&&balanceSyncMaxAgeSecondsConfig>=5?balanceSyncMaxAgeSecondsConfig:90)*1000;

function snapshotSaldoGlobal(agora=Date.now()){const saldoValido=Number.isFinite(saldoGlobalCorretora)&&saldoGlobalCorretora>=0,timestampValido=Number.isFinite(saldoGlobalAtualizadoEm)&&saldoGlobalAtualizadoEm>0,idadeMs=timestampValido?Math.max(0,agora-saldoGlobalAtualizadoEm):null;return{saldo_atual:saldoValido?saldoGlobalCorretora:null,atualizado_em:timestampValido?saldoGlobalAtualizadoEm:null,idade_ms:idadeMs,fresco:saldoValido&&timestampValido&&idadeMs<=BALANCE_SYNC_MAX_AGE_MS};}
function obterSaldoGlobalFresco(agora=Date.now()){const s=snapshotSaldoGlobal(agora);return s.fresco?s.saldo_atual:null;}
function normalizarInterrupcaoColetorId(dados){const id=String(dados?.interrupcao_id||'').trim();return(!id||id.length>256||!/^[A-Za-z0-9:_-]+$/.test(id))?'':id;}
function reservarInterrupcaoColetor(dados,agora=Date.now()){const id=normalizarInterrupcaoColetorId(dados);if(!id)return{id:'',repetida:false,legado:true};const existente=INTERRUPCOES_COLETOR_PROCESSADAS.get(id);if(existente)return{id,repetida:true,legado:false,estado:existente.estado};INTERRUPCOES_COLETOR_PROCESSADAS.set(id,{estado:'PROCESSANDO',atualizado_em:agora});while(INTERRUPCOES_COLETOR_PROCESSADAS.size>LIMITE_INTERRUPCOES_COLETOR_MEMORIA)INTERRUPCOES_COLETOR_PROCESSADAS.delete(INTERRUPCOES_COLETOR_PROCESSADAS.keys().next().value);return{id,repetida:false,legado:false,estado:'PROCESSANDO'};}
function concluirInterrupcaoColetor(id,sucesso,agora=Date.now()){const n=String(id||'').trim();if(!n)return false;if(!sucesso)return INTERRUPCOES_COLETOR_PROCESSADAS.delete(n);INTERRUPCOES_COLETOR_PROCESSADAS.set(n,{estado:'APLICADA',atualizado_em:agora});return true;}
function interrupcaoColetorJaAplicada(dados){const id=normalizarInterrupcaoColetorId(dados);return id&&INTERRUPCOES_COLETOR_PROCESSADAS.get(id)?.estado==='APLICADA';}

function normalizarConfirmacaoExecucao(statusRecebido,confirmacaoRecebida){const status=String(statusRecebido||'').trim().toUpperCase();if(status!=='EXECUTADA')return{status,confirmacao:null,motivo:null};const c=confirmacaoRecebida&&typeof confirmacaoRecebida==='object'?confirmacaoRecebida:{};const metodo=String(c.metodo||'').trim().toUpperCase(),saldoAntes=Number(c.saldo_antes),saldoDepois=Number(c.saldo_depois),exposicaoEsperada=Number(c.exposicao_esperada),debitoObservado=Number(c.debito_observado),confirmadaEm=Number(c.confirmada_em),debitoCalculado=saldoAntes-saldoDepois,tolerancia=.11;const valida=c.confirmada===true&&metodo==='SALDO_DEBITADO'&&Number.isFinite(saldoAntes)&&saldoAntes>=0&&Number.isFinite(saldoDepois)&&saldoDepois>=0&&Number.isFinite(exposicaoEsperada)&&exposicaoEsperada>0&&Number.isFinite(debitoObservado)&&debitoObservado>0&&Number.isFinite(confirmadaEm)&&confirmadaEm>0&&Math.abs(debitoCalculado-debitoObservado)<=tolerancia&&Math.abs(debitoObservado-exposicaoEsperada)<=tolerancia;if(!valida)return{status:'AMBIGUA',confirmacao:null,motivo:'Callback EXECUTADA recusado: aceite financeiro da Evolution ausente ou inconsistente'};return{status:'EXECUTADA',motivo:null,confirmacao:{metodo,saldo_antes:Number(saldoAntes.toFixed(2)),saldo_depois:Number(saldoDepois.toFixed(2)),exposicao_esperada:Number(exposicaoEsperada.toFixed(2)),debito_observado:Number(debitoObservado.toFixed(2)),confirmada_em:Math.trunc(confirmadaEm)}};}

function criarEsperaResultadoExecutor(orderId){const id=String(orderId||'').trim().toLowerCase();if(!id)throw new Error('order_id ausente ao criar espera de execução');if(CONFIRMACOES_EXECUTOR_PENDENTES.has(id))throw new Error(`Já existe espera de execução ativa para ${id}`);let finalizado=false,resultadoAtual=null,resolverPromessa=null,timeoutId=null;const promessa=new Promise(resolve=>{resolverPromessa=resolve;});const finalizar=resultado=>{if(finalizado)return false;finalizado=true;resultadoAtual=resultado;if(timeoutId)clearTimeout(timeoutId);CONFIRMACOES_EXECUTOR_PENDENTES.delete(id);resolverPromessa(resultado);return true;};timeoutId=setTimeout(()=>finalizar({order_id:id,status:'TIMEOUT',motivo:`Sem callback do executor em ${EXECUTOR_EXECUTION_TIMEOUT_MS}ms`}),EXECUTOR_EXECUTION_TIMEOUT_MS);if(timeoutId&&typeof timeoutId.unref==='function')timeoutId.unref();CONFIRMACOES_EXECUTOR_PENDENTES.set(id,{criado_em:Date.now(),finalizar});return{promessa,resultadoAtual:()=>resultadoAtual,cancelar:()=>finalizar({order_id:id,status:'CANCELADA',motivo:'Espera cancelada'})};}
function registrarResultadoExecucaoExecutor(dados){const id=String(dados&&dados.order_id||'').trim().toLowerCase(),p=CONFIRMACOES_EXECUTOR_PENDENTES.get(id);if(!p)return false;return p.finalizar({order_id:id,status:String(dados.status||'').trim().toUpperCase(),motivo:String(dados.motivo||'').slice(0,300),confirmacao:dados.confirmacao||null});}
function erroResultadoExecucaoExecutor(resultado){const status=String(resultado&&resultado.status||'TIMEOUT').toUpperCase(),motivo=String(resultado&&resultado.motivo||status),erro=new Error(`Executor reportou ${status}: ${motivo}`);erro.status_executor=status;erro.envio_ambiguo=status==='AMBIGUA'||status==='TIMEOUT';return erro;}

async function enviarOrdemAoExecutor(alvo, valor, orderId=crypto.randomUUID(), apostas=null) {
    const esperaExecucao=criarEsperaResultadoExecutor(orderId);
    const planoComposto=Array.isArray(apostas)&&apostas.length>0;
    const planoLog=planoComposto?apostas.map(perna=>`${perna.alvo}=R$${Number(perna.valor||0).toFixed(2)}`).join(' + '):`${alvo}=R$${Number(valor||0).toFixed(2)}`;
    const exposicaoLog=planoComposto?apostas.reduce((total,perna)=>total+(Number(perna.valor)||0),0):Number(valor||0);
    const target=alvo==='BankerWon'?'BANKER':(alvo==='PlayerWon'?'PLAYER':(alvo==='Tie'?'TIE':String(alvo||'').toUpperCase()));
    const comando={action:'place_bet',order_id:orderId,target,amount:Number(valor)};
    if(planoComposto)comando.apostas=apostas.map(perna=>({alvo:perna.alvo,valor:Number(perna.valor)}));
    const serializado=JSON.stringify(comando);
    let publicado=false;
    let ultimoErro=null;

    console.log(`📤 EXECUTOR REDIS | order_id=${orderId} | plano=${planoLog} | exposição=R$${Number(exposicaoLog||0).toFixed(2)} | canal=${REDIS_AUTO_TRADER_COMMANDS_CHANNEL}`);

    try {
        for(let tentativa=1;tentativa<=EXECUTOR_MAX_ATTEMPTS;tentativa++){
            try{
                if(!redisBacBoClient.isOpen){const erro=new Error('Cliente Redis de comandos não está conectado');erro.envio_ambiguo=false;throw erro;}
                const assinantes=await redisBacBoClient.publish(REDIS_AUTO_TRADER_COMMANDS_CHANNEL,serializado);
                if(Number(assinantes)<1){const erro=new Error(`Nenhum executor Redis inscrito em ${REDIS_AUTO_TRADER_COMMANDS_CHANNEL}`);erro.envio_ambiguo=false;throw erro;}
                publicado=true;
                console.log(`📣 EXECUTOR REDIS | order_id=${orderId} publicado para ${assinantes} assinante(s); aguardando callback de execução física.`);
                break;
            }catch(e){
                ultimoErro=e instanceof Error?e:new Error(String(e));
                if(typeof ultimoErro.envio_ambiguo!=='boolean')ultimoErro.envio_ambiguo=true;
                if(esperaExecucao.resultadoAtual())break;
                if(ultimoErro.envio_ambiguo===true&&tentativa<EXECUTOR_MAX_ATTEMPTS){
                    console.warn(`⚠️ Publicação Redis ambígua para ${orderId}; repetindo com o mesmo order_id (${tentativa+1}/${EXECUTOR_MAX_ATTEMPTS}).`);
                    continue;
                }
                break;
            }
        }

        const resultadoAntecipado=esperaExecucao.resultadoAtual();
        if(!publicado&&ultimoErro&&ultimoErro.envio_ambiguo!==true&&!resultadoAntecipado)throw ultimoErro;
        const resultadoExecucao=resultadoAntecipado||await esperaExecucao.promessa;
        if(resultadoExecucao.status!=='EXECUTADA'){
            console.error(`❌ EXECUTOR | order_id=${orderId} | status=${resultadoExecucao.status} | plano=${planoLog} | motivo=${String(resultadoExecucao.motivo||'sem motivo')}`);
            throw erroResultadoExecucaoExecutor(resultadoExecucao);
        }

        const evidenciaLog=resultadoExecucao.confirmacao||{};
        console.log(`✅ EXECUTOR | order_id=${orderId} | plano=${planoLog} | método=${evidenciaLog.metodo||'n/a'} | saldo=${Number(evidenciaLog.saldo_antes).toFixed(2)}→${Number(evidenciaLog.saldo_depois).toFixed(2)} | débito=R$${Number(evidenciaLog.debito_observado||0).toFixed(2)} | esperado=R$${Number(evidenciaLog.exposicao_esperada||exposicaoLog||0).toFixed(2)} | aceite financeiro confirmado`);
        const exposicaoEsperadaNode=exposicaoLog;
        const exposicaoConfirmadaExecutor=Number(resultadoExecucao.confirmacao?.exposicao_esperada);
        if(!Number.isFinite(exposicaoEsperadaNode)||exposicaoEsperadaNode<=0||!Number.isFinite(exposicaoConfirmadaExecutor)||Math.abs(exposicaoConfirmadaExecutor-exposicaoEsperadaNode)>.11){
            throw erroResultadoExecucaoExecutor({status:'AMBIGUA',motivo:'Exposição confirmada pelo executor diverge do plano financeiro emitido pelo Node'});
        }
        if(!publicado&&ultimoErro){console.warn(`⚠️ Publicação Redis de ${orderId} ficou ambígua, mas callback EXECUTADA foi recebido; a confirmação financeira local prevaleceu.`);}
        return {status:'Ordem publicada no Redis e execução DOM confirmada',duplicada:false,dados:{order_id:orderId,alvo,valor},execucao:resultadoExecucao};
    } finally { esperaExecucao.cancelar(); }
}

function classificarStatusFalhaEnvioExecutor(erro){const s=String(erro&&erro.status_executor||'').toUpperCase();if(s==='FALHOU')return'FALHA_EXECUCAO';if(s==='EXPIRADA')return'ORDEM_EXPIRADA';return erro&&erro.envio_ambiguo===true?'ENVIO_AMBIGUO':'FALHA_ENVIO';}
async function criarIntencaoOrdem(queryable,dados){const orderId=String(dados.order_id||crypto.randomUUID());const[resultado]=await queryable.query(`INSERT INTO auditoria_ordens (trader_id,estrategia_nome,fonte_sinal,alvo,nivel,risco_total,valor_entrada,valor_empate,executor_order_id,status_ordem) VALUES (?,?,?,?,?,?,?,?,?,'PREPARANDO')`,[dados.trader_id,dados.estrategia_nome,dados.fonte_sinal,dados.alvo,dados.nivel,dados.risco_total,dados.valor_entrada,Math.max(0,Number(dados.valor_empate)||0),orderId]);const auditoriaId=Number(resultado.insertId);if(!Number.isInteger(auditoriaId)||auditoriaId<=0)throw new Error('MySQL nao retornou ID valido para a intencao de ordem');return{auditoria_id:auditoriaId,order_id:orderId};}
async function marcarIntencaoAposFalhaEnvio(auditoriaId,erro,contexto){const status=classificarStatusFalhaEnvioExecutor(erro);try{const[r]=await dbPool.query(`UPDATE auditoria_ordens SET status_ordem=? WHERE id=? AND status_ordem='PREPARANDO'`,[status,auditoriaId]);if(Number(r.affectedRows)!==1)console.error(`⚠️ ${contexto}: intenção ${auditoriaId} não estava PREPARANDO ao registrar ${status}.`);}catch(e){console.error(`⚠️ ${contexto}: falha ao persistir ${status} na intenção ${auditoriaId}; PREPARANDO permanece como evidência conservadora:`,e.message);}return status;}
async function bloquearTraderAposExecucaoAmbigua(trader,statusFalha,contexto){if(statusFalha!=='ENVIO_AMBIGUO'||!trader)return false;trader.ativo=false;trader.status_operacao='BLOQUEADO_AMBIGUIDADE';try{await dbPool.query(`UPDATE auto_traders SET ativo=false,status_operacao='BLOQUEADO_AMBIGUIDADE' WHERE id=?`,[trader.id]);console.error(`🚨 Auto-Trader ${trader.id} bloqueado por execução financeira ambígua (${contexto}). Revise a conta da Evolution antes de reativar.`);return true;}catch(e){console.error(`🚨 Falha ao persistir bloqueio de segurança do Auto-Trader ${trader.id}:`,e.message);return false;}}

if(!hostNodeEhLoopback(NODE_HOST))console.warn(`SEC-003B: NODE_HOST=${NODE_HOST} fora do loopback com autenticacao administrativa ativa. Use HTTPS/reverse proxy e mantenha ADMIN_COOKIE_SECURE habilitado em rede nao confiavel.`);else if(ADMIN_AUTH_REQUIRED)console.log('SEC-003B: autenticacao administrativa ativa tambem no loopback.');
const server=app.listen(PORTA,NODE_HOST,()=>{const h=NODE_HOST.includes(':')?`[${NODE_HOST}]`:NODE_HOST;console.log(`🌐 Painel Web rodando em http://${h}:${PORTA}`);console.log(`📡 Ingestão Bac Bo via Redis Pub/Sub: ${REDIS_BACBO_EVENTS_CHANNEL}`);});
const ioServer=new Server(server,{allowRequest:(req,callback)=>{const host=req.headers.host;callback(null,backendPronto&&hostPermitidoParaNode(host,NODE_HOST,PORTA)&&origemCombinaComHost(req.headers.origin,host)&&(!ADMIN_AUTH_REQUIRED||sessaoAdminValidaCookie(req.headers.cookie)));}});
const integracaoContadorDiario=criarIntegracaoContadorDiario({controleDiarioAutoTrader,dbPool,ioServer,traders:()=>AUTO_TRADERS_MEMORIA});
const autoPilotIA=criarAutoPilotService({dbPool,estaOcupado:()=>Object.values(estadoApostas).some(e=>e&&e.aguardandoResultado),recarregarMemoria:carregarSistemasParaMemoria,notificar:(roboId,resumo)=>{ioServer.emit('atualizar_robos');ioServer.emit('atualizar_interface');console.log(`🧠 Auto Pilot IA ${roboId}: ${resumo.ativos.length} ativo(s), ${resumo.reservas} reserva(s), ${resumo.sombra} sombra.`);},log:console});

function calcularFichaSegura(valorDesejado){let valor=parseFloat(valorDesejado);if(isNaN(valor)||valor<=0)return 0;let valorArredondado=Math.round(valor/5)*5;if(valorArredondado===0&&valor>0)valorArredondado=5;return valorArredondado;}
function criarDetalhesPadraoVazios(){const p=()=>({green_direto:0,gale1:0,gale2:0,red:0,ties:{direto:{},gale1:{},gale2:{}}});return{'24h':p(),hoje:p(),semana:p(),mes:p(),geral:p()};}
function limitesPeriodosHistorico(agoraMs=Date.now()){const agora=new Date(agoraMs);if(!Number.isFinite(agoraMs)||Number.isNaN(agora.getTime()))return limitesPeriodosHistorico(Date.now());return{'24h':agoraMs-86400000,hoje:new Date(agora.getFullYear(),agora.getMonth(),agora.getDate()).getTime(),semana:new Date(agora.getFullYear(),agora.getMonth(),agora.getDate()-agora.getDay()).getTime(),mes:new Date(agora.getFullYear(),agora.getMonth(),1).getTime()};}

function calcularDetalhesPadraoNoHistorico(est,dadosArr,agoraMs=Date.now()){
    const detalhes=criarDetalhesPadraoVazios();if(!est||!Array.isArray(dadosArr)||dadosArr.length===0)return detalhes;
    let padraoArr=est.padrao;if(!Array.isArray(padraoArr)){try{padraoArr=JSON.parse(String(padraoArr||'[]'));}catch(e){padraoArr=[];}}if(!Array.isArray(padraoArr)||padraoArr.length===0)return detalhes;padraoArr=padraoArr.map(String);
    const alvo=String(est.entrada||'');if(alvo!=='Player'&&alvo!=='Banker')return detalhes;
    const gales=Math.max(0,Math.floor(Number(est.gales)||0)),protegerEmpate=est.proteger_empate===true||Number(est.proteger_empate)===1||est.protegerEmpate===true,limites=limitesPeriodosHistorico(agoraMs),tamanho=padraoArr.length;
    const periodosDaOcorrencia=timestampMs=>{const ps=['geral'],ts=Number(timestampMs);if(!Number.isFinite(ts)||ts<=0)return ps;if(ts>=limites['24h'])ps.push('24h');if(ts>=limites.hoje)ps.push('hoje');if(ts>=limites.semana)ps.push('semana');if(ts>=limites.mes)ps.push('mes');return ps;};
    const registrar=(periodos,tipo,nivel,multiplicador)=>{for(const periodo of periodos){const stats=detalhes[periodo];if(tipo==='GREEN'){if(nivel===0)stats.green_direto++;else if(nivel===1)stats.gale1++;else if(nivel===2)stats.gale2++;}else if(tipo==='TIE'){const n=nivel===0?'direto':nivel===1?'gale1':'gale2',m=String(multiplicador||'4x');stats.ties[n][m]=(stats.ties[n][m]||0)+1;}else if(tipo==='RED')stats.red++;}};
    for(let i=0;i<=dadosArr.length-tamanho-1;i++){const sessaoBase=dadosArr[i].id_sessao;let match=true;for(let p=0;p<tamanho;p++){const g=dadosArr[i+p];if(!g||String(g.resultado)!==padraoArr[p]||g.id_sessao!==sessaoBase){match=false;break;}}if(!match)continue;let currentIndex=i+tamanho;if(currentIndex>=dadosArr.length||dadosArr[currentIndex].id_sessao!==sessaoBase)continue;let step=0,desfecho=null,lastIndexChecked=currentIndex;while(step<=gales&&currentIndex<dadosArr.length){const giro=dadosArr[currentIndex];if(giro.id_sessao!==sessaoBase)break;lastIndexChecked=currentIndex;const resultado=String(giro.resultado||'');if(resultado===alvo){desfecho={tipo:'GREEN',nivel:step,multiplicador:''};break;}if(resultado==='Tie'&&protegerEmpate){desfecho={tipo:'TIE',nivel:step,multiplicador:giro.multiplicador||'4x'};break;}step++;currentIndex++;}if(!desfecho&&step>gales&&lastIndexChecked<dadosArr.length&&dadosArr[lastIndexChecked].id_sessao===sessaoBase)desfecho={tipo:'RED',nivel:gales,multiplicador:''};if(desfecho)registrar(periodosDaOcorrencia(dadosArr[i].timestamp_ms),desfecho.tipo,desfecho.nivel,desfecho.multiplicador);}
    return detalhes;
}

async function carregarHistoricoGirosAnalitico(){const[linhas]=await dbPool.query(`SELECT id,resultado,multiplicador,id_sessao,UNIX_TIMESTAMP(data_hora)*1000 AS timestamp_ms FROM giros_recentes ORDER BY id ASC`);historicoGirosAnalitico=linhas.map(row=>({id:Number(row.id)||0,resultado:String(row.resultado||''),multiplicador:String(row.multiplicador||''),id_sessao:row.id_sessao,timestamp_ms:Number(row.timestamp_ms)||0}));console.log(`📚 Histórico analítico carregado: ${historicoGirosAnalitico.length} giros.`);}

app.get('/api/saldo-global',(req,res)=>res.json(snapshotSaldoGlobal()));
app.get('/api/estrategias',async(req,res)=>{try{const[linhas]=await dbPool.query('SELECT * FROM estrategias ORDER BY id DESC'),agora=Date.now();res.json(linhas.map(est=>({...est,detalhes:calcularDetalhesPadraoNoHistorico(est,historicoGirosAnalitico,agora)})));}catch(e){console.error('❌ GET /api/estrategias falhou:',e.message);res.status(500).json({erro:'Erro ao buscar estratégias'});}});
app.get('/api/historico-giros',async(req,res)=>{try{let limit=parseInt(req.query.limit)||1000;if(limit>10000)limit=10000;const[linhas]=await dbPool.query(`SELECT resultado,multiplicador,data_hora,id_sessao FROM giros_recentes ORDER BY id DESC LIMIT ${limit}`);res.json(linhas.reverse());}catch(e){res.status(500).json([]);}});
app.get('/api/origens',async(req,res)=>{try{const[l]=await dbPool.query('SELECT * FROM origens ORDER BY nome ASC');res.json(l);}catch(e){res.status(500).json([]);}});

app.get('/api/dashboard-stats',async(req,res)=>{try{const{robo_id,periodo='24h',origem='TODAS'}=req.query;let w='WHERE 1=1',p=[];if(periodo==='24h')w+=' AND h.data_hora >= DATE_SUB(NOW(), INTERVAL 24 HOUR)';else if(periodo==='hoje')w+=' AND DATE(h.data_hora)=CURDATE()';else if(periodo==='semana')w+=' AND YEARWEEK(h.data_hora,0)=YEARWEEK(CURDATE(),0)';else if(periodo==='mes')w+=' AND YEAR(h.data_hora)=YEAR(CURDATE()) AND MONTH(h.data_hora)=MONTH(CURDATE())';if(robo_id&&robo_id!=='TODOS'){w+=' AND h.robo_id=?';p.push(robo_id);}if(origem&&origem!=='TODAS'){w+=' AND h.estrategia_origem=?';p.push(origem);}const[l]=await dbPool.query(`SELECT h.id,h.tipo_resultado,h.nivel,h.multiplicador,h.data_hora FROM historico_disparos_robos h LEFT JOIN estrategias e ON h.estrategia_id=e.id ${w} ORDER BY h.data_hora ASC,h.id ASC`,p);let sinais=l.length,greens=0,reds=0,ties=0,gs=0,rs=0,mgs=0,mrs=0;l.forEach(r=>{if(r.tipo_resultado==='GREEN'||r.tipo_resultado==='TIE'){greens++;if(r.tipo_resultado==='TIE')ties++;gs++;rs=0;mgs=Math.max(mgs,gs);}else if(r.tipo_resultado==='RED'){reds++;rs++;gs=0;mrs=Math.max(mrs,rs);}else{gs=0;rs=0;}});res.json({sinais,greens,reds,ties,max_green_seq:mgs,max_red_seq:mrs,assertividade:(sinais>0?((greens/sinais)*100).toFixed(1):0)+'%'});}catch(e){res.status(500).json({sinais:0,greens:0,reds:0,ties:0,max_green_seq:0,max_red_seq:0,assertividade:'0%'});}});

app.post('/api/novo-padrao',async(req,res)=>{try{const{nome,origem,padrao,entrada,gales,protegerEmpate,ativo}=req.body;const id='padrao_'+Date.now(),padraoJson=JSON.stringify(padrao.split(',').map(s=>s.trim())),ties=JSON.stringify({direto:{'88x':0,'25x':0,'10x':0,'6x':0,'4x':0},gale1:{'88x':0,'25x':0,'10x':0,'6x':0,'4x':0},gale2:{'88x':0,'25x':0,'10x':0,'6x':0,'4x':0}});await dbPool.query('INSERT INTO estrategias (id,nome,origem,padrao,entrada,gales,proteger_empate,ativo,green_direto,gale1,gale2,red,ties_json,is_dinamico) VALUES (?,?,?,?,?,?,?,?,0,0,0,0,?,false)',[id,nome,origem,padraoJson,entrada,parseInt(gales),protegerEmpate?1:0,ativo?1:0,ties]);await carregarSistemasParaMemoria();ioServer.emit('atualizar_interface');res.json({sucesso:true});}catch(e){res.status(500).json({sucesso:false});}});
app.put('/api/estrategia/:id',async(req,res)=>{try{const{nome,origem,padrao,entrada,gales,protegerEmpate,ativo}=req.body;await dbPool.query('UPDATE estrategias SET nome=?,origem=?,padrao=?,entrada=?,gales=?,proteger_empate=?,ativo=? WHERE id=? AND is_dinamico=false',[nome,origem,JSON.stringify(padrao.split(',').map(s=>s.trim())),entrada,parseInt(gales),protegerEmpate?1:0,ativo?1:0,req.params.id]);await carregarSistemasParaMemoria();ioServer.emit('atualizar_interface');res.json({sucesso:true});}catch(e){res.status(500).json({sucesso:false});}});
app.delete('/api/estrategia/:id',async(req,res)=>{try{await dbPool.query('DELETE FROM estrategias WHERE id=?',[req.params.id]);await dbPool.query('DELETE FROM historico_resultados WHERE estrategia_id=?',[req.params.id]);await carregarSistemasParaMemoria();ioServer.emit('atualizar_interface');res.json({sucesso:true});}catch(e){res.status(500).json({sucesso:false});}});
app.post('/api/nova-origem',async(req,res)=>{try{await dbPool.query('INSERT INTO origens (nome) VALUES (?)',[req.body.nome]);ioServer.emit('atualizar_interface');res.json({sucesso:true});}catch(e){res.status(500).json({sucesso:false});}});
app.put('/api/origem/:id',async(req,res)=>{try{await dbPool.query('UPDATE origens SET nome=? WHERE id=?',[req.body.novoNome,req.params.id]);await dbPool.query('UPDATE estrategias SET origem=? WHERE origem=? AND is_dinamico=false',[req.body.novoNome,req.body.nomeAntigo]);await carregarSistemasParaMemoria();ioServer.emit('atualizar_interface');res.json({sucesso:true});}catch(e){res.status(500).json({sucesso:false});}});
app.delete('/api/origem/:id',async(req,res)=>{try{await dbPool.query('DELETE FROM origens WHERE id=?',[req.params.id]);ioServer.emit('atualizar_interface');res.json({sucesso:true});}catch(e){res.status(500).json({sucesso:false});}});

function contarTiesLegados(tiesJson){if(!tiesJson)return 0;try{const ties=typeof tiesJson==='string'?JSON.parse(tiesJson):tiesJson;let total=0;for(const n of['direto','gale1','gale2'])for(const v of Object.values(ties?.[n]||{}))total+=Number(v)||0;return total;}catch(e){return 0;}}
function calcularAssertividadeLiveCanonica(est,historicoLiveCanonico){const dados=(Array.isArray(historicoLiveCanonico)?historicoLiveCanonico:[]).map(g=>({resultado:String(g?.resultado||''),multiplicador:String(g?.multiplicador||''),id_sessao:String(g?.id_sessao||'TIPMINER_CANONICA'),timestamp_ms:Number(g?.timestamp_ms)||0}));if(!est||dados.length===0)return 0;const d=calcularDetalhesPadraoNoHistorico(est,dados,Date.now()).geral;const greens=(Number(d.green_direto)||0)+(Number(d.gale1)||0)+(Number(d.gale2)||0)+contarTiesLegados(d.ties),reds=Number(d.red)||0,total=greens+reds;return total>0?(greens/total)*100:0;}
function roboSintonizaEstrategia(robo,est){const c=robo.config||{};if(est.is_dinamico)return Number(est.robo_dono_id)===Number(robo.id);const id=String(est.id),origem=String(est.origem||''),ex=Array.isArray(c.excecoes)?c.excecoes.map(String):[],av=Array.isArray(c.avulsos)?c.avulsos.map(String):[],or=Array.isArray(c.origens)?c.origens.map(String):[];if(ex.includes(id))return false;if(av.includes(id))return true;return or.includes(origem);}
function idsRobosSelecionadosAutoTrader(config,robos=[]){const fontes=Array.isArray(config?.fontes_sinal)?config.fontes_sinal.map(f=>String(f||'').trim()).filter(Boolean):[],ids=new Set();for(const fonte of fontes){let m=/^ROBO:(\d+)$/i.exec(fonte)||/^AUTO_PILOT_IA:(\d+)$/i.exec(fonte);if(m){ids.add(Number(m[1]));continue;}m=/^\[AUTO\]\s*(.+)$/i.exec(fonte);if(m){const r=robos.find(x=>String(x?.nome||'').trim()===String(m[1]||'').trim());if(r)ids.add(Number(r.id));}}return ids;}
function robosAutoTraderAutorizadores(config,est,robos=[]){const ids=idsRobosSelecionadosAutoTrader(config,robos);return robos.filter(r=>!(r&&(r.ativo===false||Number(r.ativo)===0))&&ids.has(Number(r.id))&&roboSintonizaEstrategia(r,est));}
function autoTraderAutorizaEstrategia(config,est,robos=[]){if(robosAutoTraderAutorizadores(config,est,robos).length>0)return true;const fontes=Array.isArray(config?.fontes_sinal)?config.fontes_sinal.map(f=>String(f||'').trim()).filter(Boolean):[];return!est.is_dinamico&&fontes.includes(String(est.origem||'').trim());}
function snapshotPublicoRobo(r){return{id:r.id,nome:r.nome,tag_visual:r.tag_visual,cor_hex:r.cor_hex};}
function destinosTelegramRobo(r){const s=new Set();if(String(r.telegram_chat_id||'').trim())s.add(String(r.telegram_chat_id).trim());for(const d of(Array.isArray(r.destinatarios)?r.destinatarios:[])){const c=String(d.chat_id||'').trim();if(c)s.add(c);}return[...s];}
function unirRobosInscritos(...listas){const m=new Map();for(const l of listas)for(const r of(Array.isArray(l)?l:[]))if(r&&r.id!=null)m.set(String(r.id),snapshotPublicoRobo(r));return[...m.values()];}
function ciclosAtivosPorRobo(){const m=new Map();for(const[estrategiaId,st]of Object.entries(estadoApostas||{})){if(!st?.aguardandoResultado)continue;for(const r of(Array.isArray(st.robosCiclo)&&st.robosCiclo.length?st.robosCiclo:(Array.isArray(st.robosInscritos)?st.robosInscritos:[])))if(r?.id!=null)m.set(String(r.id),{estrategia_id:String(estrategiaId),gale_atual:Math.max(0,Number(st.galeAtual)||0)});}return m;}
function roboEmStandby(robo,agora=Date.now()){return Number(estadoStandbyRobos[robo.id]?.em_standby_ate||robo.standby_ate||0)>agora;}
async function selecionarRobosParaEstrategia(est,historico){if(est.quarentena_restante>0)return{todos:[],web:[],telegram:[],bloqueados:[],assertividade:0};const a=calcularAssertividadeLiveCanonica(est,historico),ciclos=ciclosAtivosPorRobo(),bloqueados=[];const elegiveis=ROBOS_MEMORIA.filter(r=>{const ok=(r.ativo===true||r.ativo===1)&&!roboEmStandby(r)&&a>=Math.max(0,Number(r.min_assertividade)||0)&&roboSintonizaEstrategia(r,est);if(!ok)return false;const c=ciclos.get(String(r.id));if(c){bloqueados.push({...snapshotPublicoRobo(r),...c});return false;}return true;});return{todos:elegiveis.map(snapshotPublicoRobo),web:elegiveis.filter(r=>r.enviar_web===true||r.enviar_web===1).map(snapshotPublicoRobo),telegram:elegiveis.filter(r=>(r.enviar_telegram===true||r.enviar_telegram===1)&&String(r.telegram_token||'').trim()&&destinosTelegramRobo(r).length).map(r=>({...snapshotPublicoRobo(r),telegram_token:String(r.telegram_token||'').trim(),chat_ids:destinosTelegramRobo(r),greens_consecutivos:Math.max(0,Number(r.greens_consecutivos)||0),config:JSON.parse(JSON.stringify(r.config||{}))})),bloqueados,assertividade:Number(a.toFixed(1))};}

function rotuloEntradaTelegram(e){return e==='Player'?'🔵 PLAYER':e==='Banker'?'🔴 BANKER':'🟡 TIE';}
function formatarPadraoTelegram(p){return(Array.isArray(p)?p:[]).map(i=>i==='Player'?'🔵 P':i==='Banker'?'🔴 B':i==='Tie'?'🟡 T':String(i)).join(' → ');}
function montarMensagemTelegram(tipo,est,st,robo,extras={}){const c=robo.config||{},linhas=[];if(c.cabecalho)linhas.push(String(c.cabecalho).trim());linhas.push('━━━━━━━━━━━━━━━━━━━━',tipo==='ENTRADA'?'🎯 NOVA ENTRADA':tipo==='GALE'?`🔁 GALE ${Math.max(1,Number(extras.nivel)||1)}`:tipo==='GREEN'?'✅ GREEN CONFIRMADO':'❌ RED CONFIRMADO','━━━━━━━━━━━━━━━━━━━━');if(robo.nome)linhas.push(`🤖 Robô: ${robo.nome}`);if(c.mostrar_nome!==false)linhas.push(`📊 Estratégia: ${est.nome}`);if(tipo==='ENTRADA'&&c.mostrar_padrao!==false){const p=formatarPadraoTelegram(est.padrao);if(p)linhas.push(`🧩 Padrão: ${p}`);}if(['ENTRADA','GALE'].includes(tipo))linhas.push(`💰 Entrada: ${rotuloEntradaTelegram(est.entrada)}`);if(c.rodape)linhas.push('━━━━━━━━━━━━━━━━━━━━',String(c.rodape).trim());return linhas.join('\n').slice(0,4096);}
async function enviarMensagemTelegram(token,chatId,texto){const controller=new AbortController(),timeoutId=setTimeout(()=>controller.abort(),TELEGRAM_TIMEOUT_MS);try{const r=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chatId,text:texto}),signal:controller.signal});let c=null;try{c=await r.json();}catch(e){}return{ok:r.ok&&c?.ok===true,descricao:String(c?.description||`HTTP ${r.status}`)};}catch(e){return{ok:false,descricao:e?.name==='AbortError'?'timeout':String(e.message||e)};}finally{clearTimeout(timeoutId);}}
async function inscreverRobosTelegramEntrada(est,st,candidatos){const resultados=await Promise.all((Array.isArray(candidatos)?candidatos:[]).map(async r=>{const texto=montarMensagemTelegram('ENTRADA',est,st,r),rs=await Promise.all(r.chat_ids.map(c=>enviarMensagemTelegram(r.telegram_token,c,texto))),entregues=r.chat_ids.filter((c,i)=>rs[i]?.ok);return entregues.length?{...r,chat_ids:entregues}:null;}));const inscritos=resultados.filter(Boolean);st.robosTelegramInscritos=inscritos;st.robosInscritos=unirRobosInscritos(st.robosCiclo,st.robosWebInscritos,inscritos);return inscritos;}
async function aguardarInscricaoTelegram(st){if(st?.telegramEntradaPromise)try{await st.telegramEntradaPromise;}catch(e){}}
async function enviarTelegramParaInscritos(tipo,est,st,extras={}){await aguardarInscricaoTelegram(st);await Promise.all((Array.isArray(st?.robosTelegramInscritos)?st.robosTelegramInscritos:[]).map(async r=>{const texto=montarMensagemTelegram(tipo,est,st,r,extras);await Promise.all(r.chat_ids.map(c=>enviarMensagemTelegram(r.telegram_token,c,texto)));}));}
function emitirAlertaWebRobo(tipo,est,st,extras={}){const robosWeb=Array.isArray(st?.robosWebInscritos)?st.robosWebInscritos:[];if(robosWeb.length)ioServer.emit('alerta_painel',{tipo,nome:est.nome,entrada:est.entrada,padrao:est.padrao,assertividade:st.assertividadeSinal,robosNotificados:robosWeb,...extras});}

function nivelHistoricoResultado(g){return g===1?'GALE1':g===2?'GALE2':'DIRETO';}
async function registrarHistoricoResultadoEstrategia(est,tipo,g,mult,ts){const n=Number(ts),seg=Number.isFinite(n)&&n>0?n/1000:Date.now()/1000;await dbPool.query(`INSERT INTO historico_resultados (estrategia_id,tipo_resultado,nivel,multiplicador,data_hora) VALUES (?,?,?,?,FROM_UNIXTIME(?))`,[est.id,tipo,nivelHistoricoResultado(g),mult||'',seg]);}
async function registrarHistoricoRobosInscritos(est,st,tipo,g,mult,ts){if(!Array.isArray(st?.robosInscritos)||!st.robosInscritos.length)return;const seg=(Number(ts)>0?Number(ts):Date.now())/1000,ph=st.robosInscritos.map(()=>'(?,?,?,?,?,?,FROM_UNIXTIME(?))').join(','),params=[];for(const r of st.robosInscritos)params.push(r.id,est.id,tipo,nivelHistoricoResultado(g),mult||'',est.origem||'',seg);await dbPool.query(`INSERT INTO historico_disparos_robos (robo_id,estrategia_id,tipo_resultado,nivel,multiplicador,estrategia_origem,data_hora) VALUES ${ph}`,params);}

function traderDentroHorarioExecucao(config,agora=new Date()){const parse=v=>{const m=/^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(v));return m?Number(m[1])*60+Number(m[2]):null;},i=parse(config?.hora_inicio||'00:00'),f=parse(config?.hora_fim||'23:59');if(i===null||f===null)return false;if(i===f)return true;const a=agora.getHours()*60+agora.getMinutes();return i<f?(a>=i&&a<=f):(a>=i||a<=f);}
async function traderPossuiLiquidacaoPendente(traderId){const[l]=await dbPool.query(`SELECT id FROM auditoria_ordens WHERE trader_id=? AND status_ordem IN ('WIN','LOSS','TIE') AND resultado_confirmado_em IS NOT NULL AND saldo_pos_confirmado_em IS NULL ORDER BY id DESC LIMIT 1`,[traderId]);return l.length>0;}
async function autorizarNovaEntradaFinanceiraTrader(trader){if(!(await integracaoContadorDiario.garantirAntesDaEntrada(trader)))return false;if(await traderPossuiLiquidacaoPendente(trader.id))return false;const saldo=obterSaldoGlobalFresco();if(saldo===null)return false;return true;}
async function rearmarAutoTradersStopRedsPausados(){return 0;}
async function ativarAutoTradersAguardandoMesa(){const lista=AUTO_TRADERS_MEMORIA.filter(t=>t.ativo&&t.status_operacao==='STANDBY');if(!lista.length)return;const ids=lista.map(t=>t.id),ph=ids.map(()=>'?').join(',');await dbPool.query(`UPDATE auto_traders SET status_operacao='OPERANDO' WHERE ativo=true AND status_operacao='STANDBY' AND id IN (${ph})`,ids);lista.forEach(t=>t.status_operacao='OPERANDO');}
async function processarResultadoProtecaoRobos(){return[];}
async function enviarAvisosProtecaoTelegram(){return;}
async function processarResultadoStopRedsAutoTrader(){return;}

async function carregarSistemasParaMemoria(){
    const[linhasEst]=await dbPool.query('SELECT * FROM estrategias WHERE ativo=true');let novoEstado={};ESTRATEGIAS_MEMORIA=linhasEst.map(db=>{let padrao=[];try{padrao=JSON.parse(db.padrao);}catch(e){}const can=normalizarPadraoRoadNativo(padrao);if(can)padrao=can;let ties={direto:{},gale1:{},gale2:{}};try{if(db.ties_json)ties=JSON.parse(db.ties_json);}catch(e){}const est={id:db.id,nome:db.nome,origem:db.origem,padrao,entrada:db.entrada,gales:db.gales,protegerEmpate:db.proteger_empate===1,ativo:true,is_dinamico:db.is_dinamico===1,robo_dono_id:db.robo_dono_id,quarentena_restante:db.quarentena_restante||0,stats:{greenDireto:db.green_direto,gale1:db.gale1,gale2:db.gale2,red:db.red,ties}};novoEstado[est.id]=estadoApostas[est.id]||{aguardandoResultado:false,galeAtual:0,robosCiclo:[],robosInscritos:[],mensagensEntrada:[],mensagensGale:[]};return est;});estadoApostas=novoEstado;
    const[linhasRobos]=await dbPool.query('SELECT * FROM robos_canais WHERE ativo=true'),[dest]=await dbPool.query('SELECT robo_id,nome_cliente,chat_id FROM destinatarios_robo');ROBOS_MEMORIA=linhasRobos.map(r=>{let config={origens:[],avulsos:[],excecoes:[],auto_tuning:{ativo:false},cooldown:{ativo:false}};try{if(r.config_json)config={...config,...JSON.parse(r.config_json)};}catch(e){}if(!estadoStandbyRobos[r.id])estadoStandbyRobos[r.id]={em_standby_ate:Math.max(0,Number(r.standby_ate)||0),historico_reds:[]};return{...r,config,destinatarios:dest.filter(d=>Number(d.robo_id)===Number(r.id))};});
    const[linhasAT]=await dbPool.query('SELECT * FROM auto_traders');AUTO_TRADERS_MEMORIA=linhasAT.map(at=>{let cfg={};try{cfg=JSON.parse(at.config_json);}catch(e){}return{id:at.id,nome:at.nome,ativo:at.ativo===1,config:cfg,saldo_inicial:parseFloat(at.saldo_inicial),saldo_atual:parseFloat(at.saldo_atual),status_operacao:at.status_operacao,entradas_feitas:at.entradas_feitas,pulos_restantes:at.pulos_restantes,data_contador_entradas:String(at.data_contador_entradas||''),reds_consecutivos:Math.max(0,Number(at.reds_consecutivos)||0),stop_reds_pausado_ate:Math.max(0,Number(at.stop_reds_pausado_ate)||0),trailing_pico_lucro:Math.max(0,Number(at.trailing_pico_lucro)||0)};});
    console.log(`\n📂 MEMÓRIA ALOCADA COM SUCESSO:\n   - Estratégias Ativas: ${ESTRATEGIAS_MEMORIA.length}\n   - Robôs de Canal: ${ROBOS_MEMORIA.length}\n   - Motores Auto-Trader: ${AUTO_TRADERS_MEMORIA.length}\n`);
}

app.get('/api/robos',async(req,res)=>{try{const[l]=await dbPool.query('SELECT * FROM robos_canais ORDER BY id DESC'),[d]=await dbPool.query('SELECT * FROM destinatarios_robo');res.json(l.map(r=>{let config={};try{config=JSON.parse(r.config_json||'{}');}catch(e){}const{telegram_token,...publico}=r;return{...publico,telegram_configurado:Boolean(String(telegram_token||'').trim()),config,destinatarios:d.filter(x=>x.robo_id===r.id)};}));}catch(e){res.status(500).json([]);}});
app.post('/api/robo',async(req,res)=>{try{const{nome,tag,cor,telegram_token,telegram_chat_id,enviar_telegram,enviar_web,min_assert,stop_reds,ativo,config,destinatarios}=req.body;const[r]=await dbPool.query(`INSERT INTO robos_canais (nome,tag_visual,cor_hex,telegram_token,telegram_chat_id,enviar_telegram,enviar_web,min_assertividade,stop_reds_seguidos,greens_consecutivos,ativo,config_json) VALUES (?,?,?,?,?,?,?,?,?,0,?,?)`,[nome,tag,cor,String(telegram_token||'').trim(),String(telegram_chat_id||'').trim(),enviar_telegram?1:0,enviar_web?1:0,min_assert,stop_reds,ativo?1:0,JSON.stringify(config||{})]);for(const d of(Array.isArray(destinatarios)?destinatarios:[]))if(String(d.chat_id||'').trim())await dbPool.query('INSERT INTO destinatarios_robo (robo_id,nome_cliente,chat_id) VALUES (?,?,?)',[r.insertId,d.nome_cliente||'Cliente',String(d.chat_id).trim()]);await carregarSistemasParaMemoria();ioServer.emit('atualizar_robos');res.json({sucesso:true});}catch(e){res.status(500).json({sucesso:false});}});
app.put('/api/robo/:id',async(req,res)=>{try{const{id}=req.params,{nome,tag,cor,telegram_token,telegram_chat_id,enviar_telegram,enviar_web,min_assert,stop_reds,ativo,config,destinatarios}=req.body;await dbPool.query(`UPDATE robos_canais SET nome=?,tag_visual=?,cor_hex=?,telegram_token=COALESCE(NULLIF(?,''),telegram_token),telegram_chat_id=?,enviar_telegram=?,enviar_web=?,min_assertividade=?,stop_reds_seguidos=?,ativo=?,config_json=? WHERE id=?`,[nome,tag,cor,String(telegram_token||'').trim(),String(telegram_chat_id||'').trim(),enviar_telegram?1:0,enviar_web?1:0,min_assert,stop_reds,ativo?1:0,JSON.stringify(config||{}),id]);await dbPool.query('DELETE FROM destinatarios_robo WHERE robo_id=?',[id]);for(const d of(Array.isArray(destinatarios)?destinatarios:[]))if(String(d.chat_id||'').trim())await dbPool.query('INSERT INTO destinatarios_robo (robo_id,nome_cliente,chat_id) VALUES (?,?,?)',[id,d.nome_cliente||'Cliente',String(d.chat_id).trim()]);await carregarSistemasParaMemoria();ioServer.emit('atualizar_robos');res.json({sucesso:true});}catch(e){res.status(500).json({sucesso:false});}});
app.delete('/api/robo/:id',async(req,res)=>{try{await dbPool.query('DELETE FROM destinatarios_robo WHERE robo_id=?',[req.params.id]);await dbPool.query('DELETE FROM robos_canais WHERE id=?',[req.params.id]);await carregarSistemasParaMemoria();ioServer.emit('atualizar_robos');res.json({sucesso:true});}catch(e){res.status(500).json({sucesso:false});}});

app.get('/api/auto-traders',async(req,res)=>{try{const[l]=await dbPool.query('SELECT * FROM auto_traders ORDER BY id DESC');res.json(l.map(at=>{let config={};try{config=JSON.parse(at.config_json);}catch(e){}return{id:at.id,nome:at.nome,ativo:at.ativo===1,config,saldo_inicial:parseFloat(at.saldo_inicial),saldo_atual:parseFloat(at.saldo_atual),status_operacao:at.status_operacao,entradas_feitas:at.entradas_feitas,pulos_restantes:at.pulos_restantes};}));}catch(e){res.status(500).json([]);}});
app.post('/api/auto-trader',async(req,res)=>{try{const{nome,ativo,config}=req.body;const novo=ativo===true||ativo===1;if(novo){const pol=validarPoliticaProtecao(config||{});if(!pol.ok)return res.status(400).json({sucesso:false,erro:'protecao_empate_invalida',mensagem:pol.motivo});}const saldo=novo?obterSaldoGlobalFresco():0;if(novo&&saldo===null)return res.status(409).json({sucesso:false,erro:'saldo_global_indisponivel'});await dbPool.query(`INSERT INTO auto_traders (nome,ativo,config_json,saldo_inicial,saldo_atual,status_operacao,entradas_feitas,pulos_restantes,data_contador_entradas) VALUES (?,?,?,?,?,?,0,0,?)`,[nome,novo?1:0,JSON.stringify(config||{}),saldo,saldo,novo?'STANDBY':'DESLIGADO',controleDiarioAutoTrader.dataOperacional()]);await carregarSistemasParaMemoria();res.json({sucesso:true,saldo_inicial:saldo});}catch(e){res.status(500).json({sucesso:false});}});
app.put('/api/auto-trader/:id',async(req,res)=>{try{const{id}=req.params,{nome,ativo,config}=req.body,novo=ativo===true||ativo===1;await dbPool.query('UPDATE auto_traders SET nome=?,ativo=?,config_json=?,status_operacao=? WHERE id=?',[nome,novo?1:0,JSON.stringify(config||{}),novo?'STANDBY':'DESLIGADO',id]);await carregarSistemasParaMemoria();res.json({sucesso:true});}catch(e){res.status(500).json({sucesso:false});}});
app.delete('/api/auto-trader/:id',async(req,res)=>{try{await dbPool.query('DELETE FROM auto_traders WHERE id=?',[req.params.id]);await carregarSistemasParaMemoria();res.json({sucesso:true});}catch(e){res.status(500).json({sucesso:false});}});
app.get('/api/auditoria-ordens/:trader_id',async(req,res)=>{try{const[l]=await dbPool.query('SELECT * FROM auditoria_ordens WHERE trader_id=? ORDER BY id DESC LIMIT 500',[req.params.trader_id]);res.json(l);}catch(e){res.status(500).json([]);}});

function avaliarContinuidadeResultado(estadoAnterior,dados){const anterior=estadoAnterior||{},atual=dados||{},sessaoAnterior=String(anterior.sessao||'').trim(),seqAnteriorNumero=Number(anterior.seq),seqAnterior=Number.isSafeInteger(seqAnteriorNumero)&&seqAnteriorNumero>0?seqAnteriorNumero:null,timestampAnteriorNumero=Number(anterior.timestamp_coleta),timestampAnterior=Number.isFinite(timestampAnteriorNumero)&&timestampAnteriorNumero>0?Math.trunc(timestampAnteriorNumero):null,sessaoRecebidaBruta=String(atual.coletor_sessao||'').trim(),sessaoRecebida=sessaoRecebidaBruta.length>0&&sessaoRecebidaBruta.length<=128?sessaoRecebidaBruta:'',seqRecebidaNumero=Number(atual.coletor_seq),seqRecebida=Number.isSafeInteger(seqRecebidaNumero)&&seqRecebidaNumero>0?seqRecebidaNumero:null,timestampRecebidoNumero=Number(atual.timestamp_coleta),timestampRecebido=Number.isFinite(timestampRecebidoNumero)&&timestampRecebidoNumero>0?Math.trunc(timestampRecebidoNumero):null,tinha=Boolean(sessaoAnterior)&&seqAnterior!==null,tem=Boolean(sessaoRecebida)&&seqRecebida!==null;if(tinha&&tem&&sessaoRecebida===sessaoAnterior&&seqRecebida<=seqAnterior)return{aceitar:false,interrupcao:false,buraco_confirmado:false,motivo:seqRecebida===seqAnterior?'DUPLICADO':'FORA_DE_ORDEM',estado:{sessao:sessaoAnterior,seq:seqAnterior,timestamp_coleta:timestampAnterior}};let interrupcao=false,buraco=false,motivo=null;if(tinha){if(!tem){interrupcao=true;buraco=true;motivo='METADADOS_COLETOR_AUSENTES';}else if(sessaoRecebida!==sessaoAnterior){interrupcao=true;buraco=true;motivo='COLETOR_REINICIADO';}else if(seqRecebida>seqAnterior+1){interrupcao=true;buraco=true;motivo='SALTO_SEQUENCIA';}}return{aceitar:true,interrupcao,buraco_confirmado:buraco,motivo,estado:{sessao:tem?sessaoRecebida:(sessaoAnterior||null),seq:tem?seqRecebida:seqAnterior,timestamp_coleta:timestampRecebido!==null?timestampRecebido:timestampAnterior}};}
async function invalidarSequenciasAposBuracoDados(motivo){let sinais=0;for(const st of Object.values(estadoApostas)){if(st?.aguardandoResultado){st.aguardandoResultado=false;st.galeAtual=0;sinais++;}}console.warn(`⚠️ Continuidade de dados comprometida (${motivo||'DESCONHECIDO'}): ${sinais} sinal(is) pendente(s) invalidado(s).`);return{sinais_invalidados:sinais,traders_bloqueados:0};}
function rotacionarSessaoAposInterrupcao(){idSessaoContinua=Date.now();return true;}

app.post('/executor-status',(req,res)=>{if(!requisicaoInternaAutorizada(req))return res.status(401).json({erro:'Nao autorizado'});const dados=req.body||{},orderId=String(dados.order_id||'').trim().toLowerCase(),statusRecebido=String(dados.status||'').trim().toUpperCase();if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(orderId))return res.status(400).json({erro:'order_id invalido'});if(!STATUS_EXECUTOR_VALIDOS.has(statusRecebido))return res.status(400).json({erro:'status_executor_invalido'});const v=normalizarConfirmacaoExecucao(statusRecebido,dados.confirmacao),entregue=registrarResultadoExecucaoExecutor({order_id:orderId,status:v.status,motivo:v.motivo||dados.motivo,confirmacao:v.confirmacao});return res.json({recebido:true,orfa:!entregue});});
app.post('/collector-health',async(req,res)=>{if(!requisicaoInternaAutorizada(req))return res.status(401).json({erro:'Nao autorizado'});return res.json({recebido:true,continuidade:'REDIS_TIPMINER'});});

function timestampTipMinerEmMs(valor){if(valor===null||valor===undefined||valor==='')return null;const texto=String(valor).trim(),num=Number(texto);if(Number.isFinite(num)&&num>0)return Math.trunc(num<100000000000?num*1000:num);const p=Date.parse(texto);return Number.isFinite(p)&&p>0?Math.trunc(p):null;}
function tokenResultadoTipMiner(tipo,resultado){const t=String(tipo||'').trim().toUpperCase(),n=Number(resultado);if(!Number.isFinite(n)||!Number.isInteger(n)||n<0)throw new Error('TipMiner result inválido');if(t==='BANKER')return`BankerWon:${n}`;if(t==='PLAYER')return`PlayerWon:${n}`;if(t==='TIE')return`Tie:${n}`;throw new Error(`TipMiner type inválido: ${t||'vazio'}`);}
function traduzirRoundTipMiner(round,{sessao,seq=null}={}){if(!round||typeof round!=='object')throw new Error('Round TipMiner inválido');const uuid=String(round.uuid||'').trim(),tipo=String(round.type||'').trim().toUpperCase(),resultado=Number(round.result),instant=String(round.instant||'').trim(),timestamp=timestampTipMinerEmMs(instant),sessaoNormalizada=String(sessao||estadoTipMinerRedis.sessao||'').trim();if(!uuid||!timestamp||!sessaoNormalizada)throw new Error('Round TipMiner incompleto');const winnerToken=tokenResultadoTipMiner(tipo,resultado),seqNumero=Number(seq);return{winner:winnerToken,vencedor:winnerToken,resultado:winnerToken,tipminer_type:tipo,tipminer_result:resultado,uuid,round_id:uuid,rodada_origem:uuid,instant,coletor_sessao:sessaoNormalizada,id_sessao:sessaoNormalizada,coletor_seq:Number.isSafeInteger(seqNumero)&&seqNumero>0?seqNumero:null,timestamp_coleta:timestamp,timestamp_ms:timestamp,fonte_dados:'TIPMINER_REDIS'};}
function registrarUuidTipMiner(uuid){const id=String(uuid||'').trim();if(!id||uuidsTipMinerRecentes.has(id))return false;uuidsTipMinerRecentes.add(id);while(uuidsTipMinerRecentes.size>LIMITE_UUIDS_TIPMINER_MEMORIA)uuidsTipMinerRecentes.delete(uuidsTipMinerRecentes.values().next().value);return true;}
function criarSessaoTipMiner(history,agora=Date.now()){return`TIPMINER:${Math.trunc(agora)}:${String(history?.[history.length-1]?.uuid||'SEM_UUID').trim().slice(0,64)}`.slice(0,128);}

async function sincronizarHistoricoTipMinerDoRedis(motivo='history_sync',{obrigatorio=true}={}){let liberar=null;try{const serializado=await redisBacBoClient.get(REDIS_BACBO_HISTORY_KEY);if(!serializado){if(obrigatorio)throw new Error(`Redis key ${REDIS_BACBO_HISTORY_KEY} ausente`);return false;}const bruto=JSON.parse(serializado);if(!Array.isArray(bruto)||!bruto.length||bruto.length>200)throw new Error('Histórico TipMiner inválido');const agora=Date.now(),sessao=criarSessaoTipMiner(bruto,agora);const history=bruto.map((round,indice)=>({indice,dados:traduzirRoundTipMiner(round,{sessao,seq:indice+1})})).sort((a,b)=>a.dados.timestamp_coleta-b.dados.timestamp_coleta||a.indice-b.indice).map(i=>i.dados);liberar=await aguardarTurnoProcessamentoResultado();if(estadoTipMinerRedis.sessao)await invalidarSequenciasAposBuracoDados(`TIPMINER_${String(motivo).toUpperCase()}`);hardResetSnapshotRoad(`TIPMINER_${String(motivo).toUpperCase()}`,sessao);if(!substituirRoadPorSnapshotFresco({history,coletor_sessao:sessao,id_sessao:sessao,timestamp_coleta:agora,orientacao:ORIENTACAO_ROAD_NATIVA.OLD_TO_NEW},agora))throw new Error('ROAD SNAPSHOT TipMiner foi recusado');uuidsTipMinerRecentes.clear();history.forEach(i=>registrarUuidTipMiner(i.uuid));Object.assign(estadoTipMinerRedis,{sessao,live_seq:0,ultimo_uuid:history[history.length-1]?.uuid||null,sincronizado_em:agora});estadoContinuidadeRecepcao={sessao,seq:null,timestamp_coleta:agora};estadoContinuidadeColetor={...estadoContinuidadeRecepcao};console.log(`♻️ REDIS BAC BO | ${history.length} giro(s) TipMiner sincronizados; sessão=${sessao}; gatilhos bloqueados até live_round incremental.`);return true;}finally{if(liberar)liberar();}}

function planoDadosMesa(dados,vencedor){const total=Number(dados.tipminer_result);return{p1:null,p2:null,b1:null,b2:null,totalP:null,totalB:null,totalTipMiner:Number.isFinite(total)?total:null,nEmp:0,mult:'4x',placarMesa:`[TIPMINER:${String(dados.winner||dados.resultado||vencedor)}]`};}

async function processarRodadaIncremental(payload){let liberar=null;try{const vencedor=resultadoRoadNativo(payload?.vencedor||payload?.resultado||payload?.winner);if(!vencedor)throw new Error('Rodada incremental sem vencedor reconhecido');const recebidoEm=Date.now(),gatilho=avaliarGatilhoHardResetRoad(payload,recebidoEm,{registrarPacote:true});if(gatilho.reset)hardResetSnapshotRoad(gatilho.motivo,gatilho.sessao_esperada);const continuidade=reservarContinuidadeResultado(payload);if(!continuidade?.aceitar)return{ignorado:true,motivo:continuidade?.motivo};liberar=await aguardarTurnoProcessamentoResultado();estadoContinuidadeColetor=continuidade.estado;const incremental=atualizarRoadNativoComIncremental(payload,recebidoEm);try{await integracaoContadorDiario.processarViradaDiaria();}catch(e){}try{await ativarAutoTradersAguardandoMesa();}catch(e){}const mesa=planoDadosMesa(payload,vencedor),{p1,p2,b1,b2,nEmp,mult,placarMesa}=mesa;let giroId=0;try{const ts=Number(payload.timestamp_coleta)||Date.now();const[r]=await dbPool.query(`INSERT INTO giros_recentes (resultado,p_d1,p_d2,b_d1,b_d2,numero_empate,multiplicador,id_sessao,data_hora) VALUES (?,?,?,?,?,?,?,?,FROM_UNIXTIME(?))`,[vencedor,p1||0,p2||0,b1||0,b2||0,nEmp,mult,idSessaoContinua,ts/1000]);giroId=Number(r.insertId)||0;historicoGirosAnalitico.push({id:giroId,resultado:vencedor,multiplicador:mult,id_sessao:idSessaoContinua,timestamp_ms:ts});}catch(e){console.error('❌ Falha ao persistir giro recente:',e.message);}if(giroId)try{await autoPilotIA.registrarNovoGiro({giro_id:giroId});}catch(e){}
    let sinalFinalizadoAgora=false;
    for(const est of ESTRATEGIAS_MEMORIA){const st=estadoApostas[est.id];if(!st?.aguardandoResultado)continue;let finalizar=false,isTie=vencedor==='Tie';if(vencedor===est.entrada||(isTie&&est.protegerEmpate)){if(!isTie){if(st.galeAtual===0)est.stats.greenDireto++;else if(st.galeAtual===1)est.stats.gale1++;else est.stats.gale2++;}await registrarHistoricoResultadoEstrategia(est,isTie?'TIE':'GREEN',st.galeAtual,isTie?mult:'',payload.timestamp_coleta).catch(()=>{});await aguardarInscricaoTelegram(st);await registrarHistoricoRobosInscritos(est,st,isTie?'TIE':'GREEN',st.galeAtual,isTie?mult:'',payload.timestamp_coleta).catch(()=>{});emitirAlertaWebRobo('GREEN',est,st,{resultado:isTie?'TIE':'GREEN',multiplicador:isTie?mult:''});void enviarTelegramParaInscritos('GREEN',est,st,{resultado:isTie?'TIE':'GREEN',multiplicador:isTie?mult:''});for(const trader of AUTO_TRADERS_MEMORIA){if(!(trader.ativo&&autoTraderAutorizaEstrategia(trader.config,est,ROBOS_MEMORIA)))continue;const[p]=await dbPool.query(`SELECT id,valor_entrada,valor_empate FROM auditoria_ordens WHERE trader_id=? AND status_ordem='PENDENTE' LIMIT 1`,[trader.id]);if(p.length){const lucro=calcularPnLEtapa({resultado:vencedor,alvoPrincipal:est.entrada,valorPrincipal:Number(p[0].valor_entrada)||0,valorEmpate:Number(p[0].valor_empate)||0,multiplicadorEmpate:mult});await dbPool.query(`UPDATE auditoria_ordens SET status_ordem=?,lucro_prejuizo=?,resultado_confirmado_em=?,placar_mesa=? WHERE id=?`,[isTie?'TIE':'WIN',lucro,Date.now(),placarMesa,p[0].id]);}}finalizar=true;}else if(st.galeAtual<est.gales){st.galeAtual++;emitirAlertaWebRobo('GALE',est,st,{nivel:st.galeAtual});void enviarTelegramParaInscritos('GALE',est,st,{nivel:st.galeAtual});for(const trader of AUTO_TRADERS_MEMORIA){if(!(trader.ativo&&trader.status_operacao==='OPERANDO'&&autoTraderAutorizaEstrategia(trader.config,est,ROBOS_MEMORIA)))continue;const[p]=await dbPool.query(`SELECT id,risco_total FROM auditoria_ordens WHERE trader_id=? AND status_ordem='PENDENTE' LIMIT 1`,[trader.id]);if(!p.length)continue;const plano=calcularPlanoAposta(trader.config,est,st.galeAtual);if(!plano.ok)continue;const ordemId=crypto.randomUUID();const intencao=await criarIntencaoOrdem(dbPool,{trader_id:trader.id,estrategia_nome:est.nome,fonte_sinal:est.origem,alvo:plano.apostas[0].alvo,nivel:`GALE ${st.galeAtual}`,risco_total:Number(p[0].risco_total)+plano.exposicao_etapa,valor_entrada:plano.valor_principal,valor_empate:plano.valor_empate,order_id:ordemId});try{const c=await enviarOrdemAoExecutor(plano.apostas[0].alvo,plano.valor_principal,ordemId,plano.apostas),ev=c.execucao.confirmacao;await dbPool.query(`UPDATE auditoria_ordens SET status_ordem='PENDENTE',executor_confirmacao_metodo=?,executor_saldo_antes=?,executor_saldo_depois=?,executor_debito_observado=?,execucao_confirmada_em=? WHERE id=? AND status_ordem='PREPARANDO'`,[ev.metodo,ev.saldo_antes,ev.saldo_depois,ev.debito_observado,ev.confirmada_em,intencao.auditoria_id]);}catch(e){const status=await marcarIntencaoAposFalhaEnvio(intencao.auditoria_id,e,`GALE ${st.galeAtual}`);await bloquearTraderAposExecucaoAmbigua(trader,status,'GALE');}}}else{est.stats.red++;await registrarHistoricoResultadoEstrategia(est,'RED',st.galeAtual,'',payload.timestamp_coleta).catch(()=>{});emitirAlertaWebRobo('RED',est,st);void enviarTelegramParaInscritos('RED',est,st);finalizar=true;}if(finalizar){st.aguardandoResultado=false;st.galeAtual=0;sinalFinalizadoAgora=true;ioServer.emit('atualizar_interface');}}
    if(sinalFinalizadoAgora||!incremental)return{processado:true,disparo_avaliado:false};const estado=obterHistoricoRoadNativo();if(!estado.pronto)return{processado:true,disparo_avaliado:false};const historico=estado.history;if(!Object.values(estadoApostas).some(e=>e.aguardandoResultado)){for(const est of ESTRATEGIAS_MEMORIA){if(!est.ativo||!estrategiaCombinaFimRoadNativo(est,historico))continue;let selecao;try{selecao=await selecionarRobosParaEstrategia(est,historico);}catch(e){continue;}if(!selecao.todos?.length)continue;estadoApostas[est.id]={aguardandoResultado:true,galeAtual:0,robosCiclo:unirRobosInscritos(selecao.todos),robosWebInscritos:selecao.web,robosTelegramInscritos:[],robosInscritos:unirRobosInscritos(selecao.todos),assertividadeSinal:selecao.assertividade,mensagensEntrada:[],mensagensGale:[]};const st=estadoApostas[est.id];emitirAlertaWebRobo('ENTRADA',est,st);st.telegramEntradaPromise=inscreverRobosTelegramEntrada(est,st,selecao.telegram);for(const trader of AUTO_TRADERS_MEMORIA){if(!(trader.ativo&&trader.status_operacao==='OPERANDO'&&autoTraderAutorizaEstrategia(trader.config,est,ROBOS_MEMORIA)))continue;if(!traderDentroHorarioExecucao(trader.config)||!(await autorizarNovaEntradaFinanceiraTrader(trader)))continue;const plano=calcularPlanoAposta(trader.config,est,0);if(!plano.ok)continue;const ordemId=crypto.randomUUID();let intencao;try{intencao=await criarIntencaoOrdem(dbPool,{trader_id:trader.id,estrategia_nome:est.nome,fonte_sinal:est.origem,alvo:plano.apostas[0].alvo,nivel:'DIRETO',risco_total:plano.exposicao_etapa,valor_entrada:plano.valor_principal,valor_empate:plano.valor_empate,order_id:ordemId});const c=await enviarOrdemAoExecutor(plano.apostas[0].alvo,plano.valor_principal,ordemId,plano.apostas),ev=c.execucao.confirmacao;await dbPool.query(`UPDATE auditoria_ordens SET status_ordem='PENDENTE',executor_confirmacao_metodo=?,executor_saldo_antes=?,executor_saldo_depois=?,executor_debito_observado=?,execucao_confirmada_em=? WHERE id=? AND status_ordem='PREPARANDO'`,[ev.metodo,ev.saldo_antes,ev.saldo_depois,ev.debito_observado,ev.confirmada_em,intencao.auditoria_id]);trader.entradas_feitas=(Number(trader.entradas_feitas)||0)+1;}catch(e){if(intencao){const status=await marcarIntencaoAposFalhaEnvio(intencao.auditoria_id,e,'DIRETO');await bloquearTraderAposExecucaoAmbigua(trader,status,'DIRETO');}}}break;}}
    return{processado:true,disparo_avaliado:true};
}finally{if(liberar)liberar();}}

async function processarLiveRoundTipMiner(round){if(!estadoTipMinerRedis.sessao)throw new Error('live_round recebido antes de ROAD SNAPSHOT');const uuid=String(round?.uuid||'').trim();if(!uuid)throw new Error('live_round sem uuid');if(uuidsTipMinerRecentes.has(uuid))return false;const seq=estadoTipMinerRedis.live_seq+1,dados=traduzirRoundTipMiner(round,{sessao:estadoTipMinerRedis.sessao,seq});registrarUuidTipMiner(uuid);estadoTipMinerRedis.live_seq=seq;estadoTipMinerRedis.ultimo_uuid=uuid;await processarRodadaIncremental(dados);return true;}
async function processarMensagemRedisBacBo(mensagem){const evento=JSON.parse(String(mensagem||''));const action=String(evento.action||'').trim();if(action==='history_sync')return sincronizarHistoricoTipMinerDoRedis('HISTORY_SYNC');if(action==='live_round')return processarLiveRoundTipMiner(evento.data);}
function enfileirarMensagemRedisBacBo(mensagem){caudaEventosRedisBacBo=caudaEventosRedisBacBo.then(()=>processarMensagemRedisBacBo(mensagem)).catch(async erro=>{console.error(`❌ REDIS BAC BO | evento falhou em modo fail-closed: ${erro.message}`);hardResetSnapshotRoad('FALHA_EVENTO_REDIS',estadoTipMinerRedis.sessao||'');try{await sincronizarHistoricoTipMinerDoRedis('RECOVERY',{obrigatorio:false});}catch(e){}});}
async function iniciarIngestaoRedisBacBo(){await redisBacBoClient.connect();await redisBacBoSubscriber.connect();await redisBacBoSubscriber.subscribe(REDIS_BACBO_EVENTS_CHANNEL,mensagem=>enfileirarMensagemRedisBacBo(mensagem));console.log(`✅ REDIS BAC BO | conectado | canal=${REDIS_BACBO_EVENTS_CHANNEL} | history=${REDIS_BACBO_HISTORY_KEY} | executor=${REDIS_AUTO_TRADER_COMMANDS_CHANNEL}`);await sincronizarHistoricoTipMinerDoRedis('STARTUP',{obrigatorio:false});}

async function iniciarApp(){await prepararBancoDeDados();await carregarHistoricoGirosAnalitico();await carregarSistemasParaMemoria();try{await autoPilotIA.executarTodos({forcar:true,motivo:'startup'});}catch(e){console.error('⚠️ Auto Pilot IA não conseguiu revalidar no startup:',e.message);}await iniciarIngestaoRedisBacBo();backendPronto=true;console.log('✅ Backend inicializado e pronto para atender APIs.');}
async function encerrarAposFalhaInicializacao(erro){backendPronto=false;console.error('🔥 Inicialização do backend falhou; encerrando processo em modo seguro:',erro);try{if(redisBacBoSubscriber.isOpen)await redisBacBoSubscriber.quit();}catch(e){}try{if(redisBacBoClient.isOpen)await redisBacBoClient.quit();}catch(e){}try{ioServer.close();}catch(e){}try{await new Promise(resolve=>server.close(resolve));}catch(e){}try{await dbPool.end();}catch(e){}process.exitCode=1;}
iniciarApp().catch(encerrarAposFalhaInicializacao);
