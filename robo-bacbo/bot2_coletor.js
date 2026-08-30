// MICRO-COMMIT 8: rodada_inicio imutável de nascimento.
// MICRO-COMMIT 6: tolerância de consistência inicial para evitar falsos positivos.
const mysql = require("mysql2/promise");
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const {
    validarPoliticaProtecao,
    calcularPlanoAposta,
    calcularPnLEtapa
} = require("./tie_protection");
const { Server } = require("socket.io");
const { criarAutoPilotService } = require("./auto_pilot_ia");
const { analisarOraculo, extrairMesaAtual, normalizarResultadoOraculo } = require("./oraculo_dinamico");
const { criarControleDiarioAutoTrader } = require("./bug051b_daily_counter");
const { criarIntegracaoContadorDiario } = require("./bug051b_integration");
const {
    normalizarConfigAutoTrader,
    traderDentroHorarioExecucao,
    formatarFaixasHorario,
    normalizarEstadoCiclo,
    estadoInicialCiclo,
    configuracaoCicloMudou,
    processarResultadoDormindo,
    avaliarSinalOnda,
    avancarAposSinalOperado,
    aplicarEstadoCiclo
} = require("./auto_trader");
const { criarArbitroFinanceiroAutoTrader } = require("./auto_trader_round_arbiter");
const { obterMesaRuntime } = require("./mesa_runtime_context");
const {
    nomeCookieEscopadoPorMesa
} = require("./mesa_operational_scope");
const {
    afirmarMesaFinanceiraAutorizada
} = require("./mesa_financial_scope");
require("./env_loader").loadEnvFile(path.join(__dirname, "..", ".env"));

// Erros globais realmente não tratados são fatais: continuar pode deixar estado financeiro incoerente.
process.on('uncaughtException', (err) => {
    console.error('🔥 ERRO CRÍTICO NÃO TRATADO; encerrando processo:', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error('🔥 REJEIÇÃO DE PROMISE NÃO TRATADA; encerrando processo:', reason);
    process.exit(1);
});

// ==========================================
// 1. CONFIGURAÇÕES E BANCO DE DADOS
// ==========================================
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
    const mesaRuntime = obterMesaRuntime();
    const mesaId = Number(mesaRuntime.id);

    if (!Number.isInteger(mesaId) || mesaId <= 0) {
        throw new Error(
            'MC22-V-B: mesa runtime invalida na limpeza IA'
        );
    }

    const conexao = await dbPool.getConnection();
    try {
        await conexao.beginTransaction();

        const [orfaos] = await conexao.query(`
            SELECT e.id
            FROM estrategias e
            LEFT JOIN robos_canais r
              ON r.id = e.robo_dono_id
             AND r.mesa_id = e.mesa_id
            WHERE e.mesa_id = ?
              AND e.is_dinamico = true
              AND (e.robo_dono_id IS NULL OR r.id IS NULL)
            FOR UPDATE
        `, [mesaId]);

        const ids = orfaos.map(row => String(row.id));
        if (ids.length > 0) {
            const placeholders = ids.map(() => '?').join(',');
            await conexao.query(
                `DELETE FROM historico_resultados
                 WHERE mesa_id=?
                   AND estrategia_id IN (${placeholders})`,
                [mesaId, ...ids]
            );
            await conexao.query(
                `DELETE FROM historico_disparos_robos
                 WHERE mesa_id=?
                   AND estrategia_id IN (${placeholders})`,
                [mesaId, ...ids]
            );
            await conexao.query(
                `DELETE FROM historico_shadow_ia
                 WHERE mesa_id=?
                   AND estrategia_id IN (${placeholders})`,
                [mesaId, ...ids]
            );
            await conexao.query(
                `DELETE FROM estrategias
                 WHERE mesa_id=?
                   AND id IN (${placeholders})
                   AND is_dinamico = true`,
                [mesaId, ...ids]
            );
        }

        const [historicosOrfaos] = await conexao.query(`
            DELETE h
            FROM historico_disparos_robos h
            LEFT JOIN robos_canais r
              ON r.id = h.robo_id
             AND r.mesa_id = h.mesa_id
            WHERE h.mesa_id = ?
              AND r.id IS NULL
        `, [mesaId]);

        await conexao.commit();

        const historicosRemovidos = Math.max(0, Number(historicosOrfaos.affectedRows) || 0);
        if (ids.length > 0 || historicosRemovidos > 0) {
            console.log(
                `🧹 Limpeza IA: ${ids.length} padrão(ões) dinâmico(s) órfão(s) e `
                + `${historicosRemovidos} histórico(s) de robô órfão(s) removido(s).`
            );
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
        // MC22-T: em fresh install estas tabelas nascem depois
        // da migration de escopo. O bootstrap ja fixou a mesa
        // canonica antes de carregar este modulo.
        const mesaRuntimeSchema = obterMesaRuntime();
        const mesaIdSchema = Number(mesaRuntimeSchema.id);

        if (
            !Number.isInteger(mesaIdSchema)
            || mesaIdSchema <= 0
        ) {
            throw new Error(
                'MC22-T: mesa runtime invalida ao preparar schema canonico'
            );
        }

        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS origens (
                id INT AUTO_INCREMENT PRIMARY KEY,
                mesa_id SMALLINT UNSIGNED NOT NULL,
                nome VARCHAR(100)
            )
        `);

        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS estrategias (
                id VARCHAR(100) PRIMARY KEY,
                mesa_id SMALLINT UNSIGNED NOT NULL,
                nome VARCHAR(100),
                origem VARCHAR(100),
                padrao TEXT,
                entrada VARCHAR(20),
                gales INT DEFAULT 0,
                proteger_empate BOOLEAN DEFAULT true,
                ativo BOOLEAN DEFAULT true,
                green_direto INT DEFAULT 0,
                gale1 INT DEFAULT 0,
                gale2 INT DEFAULT 0,
                red INT DEFAULT 0,
                ties_json TEXT,
                is_dinamico BOOLEAN DEFAULT false,
                robo_dono_id INT DEFAULT NULL,
                criado_em BIGINT DEFAULT 0,
                quarentena_restante INT DEFAULT 0
            )
        `);

        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS historico_resultados (
                id INT AUTO_INCREMENT PRIMARY KEY,
                mesa_id SMALLINT UNSIGNED NOT NULL,
                estrategia_id VARCHAR(100),
                tipo_resultado VARCHAR(20),
                nivel VARCHAR(20),
                multiplicador VARCHAR(10),
                data_hora DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS historico_shadow_ia (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                mesa_id SMALLINT UNSIGNED NOT NULL,
                estrategia_id VARCHAR(100) NOT NULL,
                robo_id INT NOT NULL,
                giro_resultado_id INT NOT NULL,
                tipo_resultado VARCHAR(20) NOT NULL,
                nivel VARCHAR(20) DEFAULT 'DIRETO',
                multiplicador VARCHAR(10) DEFAULT '',
                data_hora DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_shadow_mesa_estrategia_giro (mesa_id, estrategia_id, giro_resultado_id),
                INDEX idx_shadow_robo (robo_id),
                INDEX idx_shadow_estrategia (estrategia_id)
            )
        `);

        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS giros_recentes (
                id INT AUTO_INCREMENT PRIMARY KEY,
                mesa_id SMALLINT UNSIGNED NOT NULL,
                resultado VARCHAR(20),
                p_d1 INT DEFAULT 0,
                p_d2 INT DEFAULT 0,
                b_d1 INT DEFAULT 0,
                b_d2 INT DEFAULT 0,
                numero_empate INT DEFAULT 0,
                multiplicador VARCHAR(10) DEFAULT '',
                id_sessao BIGINT,
                data_hora DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS robos_canais (
                id INT AUTO_INCREMENT PRIMARY KEY,
                mesa_id SMALLINT UNSIGNED NOT NULL,
                nome VARCHAR(100),
                tag_visual VARCHAR(20),
                cor_hex VARCHAR(10) DEFAULT '#007bff',
                telegram_token VARCHAR(100),
                telegram_chat_id VARCHAR(50),
                enviar_telegram BOOLEAN DEFAULT true,
                enviar_web BOOLEAN DEFAULT true,
                min_assertividade INT DEFAULT 0,
                stop_reds_seguidos INT DEFAULT 0,
                greens_consecutivos INT DEFAULT 0,
                reds_consecutivos INT DEFAULT 0,
                standby_ate BIGINT DEFAULT 0,
                historico_reds_json TEXT,
                ativo BOOLEAN DEFAULT true,
                config_json TEXT
            )
        `);

        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS destinatarios_robo (
                id INT AUTO_INCREMENT PRIMARY KEY,
                robo_id INT,
                nome_cliente VARCHAR(100),
                chat_id VARCHAR(50),
                FOREIGN KEY (robo_id) REFERENCES robos_canais(id) ON DELETE CASCADE
            )
        `);

        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS historico_disparos_robos (
                id INT AUTO_INCREMENT PRIMARY KEY,
                mesa_id SMALLINT UNSIGNED NOT NULL,
                robo_id INT,
                estrategia_id VARCHAR(100),
                tipo_resultado VARCHAR(20),
                nivel VARCHAR(20),
                multiplicador VARCHAR(10),
                estrategia_origem VARCHAR(100) DEFAULT '',
                data_hora DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 🌟 NOVAS TABELAS DO MOTOR DE EXECUÇÃO (AUTO-TRADER)
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS auto_traders (
                id INT AUTO_INCREMENT PRIMARY KEY,
                mesa_id SMALLINT UNSIGNED NOT NULL,
                nome VARCHAR(100),
                ativo BOOLEAN DEFAULT false,
                config_json TEXT,
                saldo_inicial DECIMAL(12,2) DEFAULT 0,
                saldo_atual DECIMAL(12,2) DEFAULT 0,
                status_operacao VARCHAR(50) DEFAULT 'STANDBY',
                entradas_feitas INT DEFAULT 0,
                pulos_restantes INT DEFAULT 0,
                estado_ciclo VARCHAR(20) DEFAULT 'DORMINDO',
                reds_virtuais_observados INT DEFAULT 0,
                sinais_operados_onda INT DEFAULT 0,
                ciclos_concluidos INT DEFAULT 0,
                data_contador_entradas VARCHAR(10) DEFAULT NULL,
                reds_consecutivos INT DEFAULT 0,
                stop_reds_pausado_ate BIGINT DEFAULT 0,
                trailing_pico_lucro DECIMAL(12,2) DEFAULT 0,
                data_atualizacao DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);

        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS auditoria_ordens (
                id INT AUTO_INCREMENT PRIMARY KEY,
                mesa_id SMALLINT UNSIGNED NOT NULL,
                trader_id INT,
                estrategia_id VARCHAR(100) DEFAULT NULL,
                estrategia_nome VARCHAR(100),
                fonte_sinal VARCHAR(100),
                alvo VARCHAR(20),
                nivel VARCHAR(20),
                risco_total DECIMAL(12,2),
                valor_entrada DECIMAL(12,2),
                valor_empate DECIMAL(12,2) DEFAULT 0,
                executor_order_id VARCHAR(64) DEFAULT NULL,
                executor_confirmacao_metodo VARCHAR(40) DEFAULT NULL,
                executor_saldo_antes DECIMAL(12,2) DEFAULT NULL,
                executor_saldo_depois DECIMAL(12,2) DEFAULT NULL,
                executor_debito_observado DECIMAL(12,2) DEFAULT NULL,
                execucao_confirmada_em BIGINT DEFAULT NULL,
                status_ordem VARCHAR(20) DEFAULT 'PENDENTE',
                placar_mesa VARCHAR(50) DEFAULT '',
                lucro_prejuizo DECIMAL(12,2) DEFAULT 0,
                saldo_pos DECIMAL(12,2) DEFAULT NULL,
                resultado_confirmado_em BIGINT DEFAULT NULL,
                saldo_pos_confirmado_em BIGINT DEFAULT NULL,
                data_hora DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (trader_id) REFERENCES auto_traders(id) ON DELETE CASCADE
            )
        `);

        const adicionarColuna = async (query) => {
            try {
                await dbPool.query(query);
            } catch (e) {
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
        await adicionarColuna("ALTER TABLE auditoria_ordens ADD COLUMN estrategia_id VARCHAR(100) DEFAULT NULL");
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
        await adicionarColuna("ALTER TABLE auto_traders ADD COLUMN estado_ciclo VARCHAR(20) DEFAULT 'DORMINDO'");
        await adicionarColuna("ALTER TABLE auto_traders ADD COLUMN reds_virtuais_observados INT DEFAULT 0");
        await adicionarColuna("ALTER TABLE auto_traders ADD COLUMN sinais_operados_onda INT DEFAULT 0");
        await adicionarColuna("ALTER TABLE auto_traders ADD COLUMN ciclos_concluidos INT DEFAULT 0");
        await integracaoContadorDiario.inicializarDatasLegadas();

        // Corrige estados legados impossíveis: um trader desligado manualmente não pode permanecer OPERANDO/STANDBY.
        // Estados de parada explícita (STOP_WIN/STOP_LOSS/STOP_REDS/TRAILING_STOP) são preservados.
        await dbPool.query(
            `UPDATE auto_traders
             SET status_operacao='DESLIGADO'
             WHERE mesa_id=?
               AND ativo=false
               AND status_operacao IN ('OPERANDO', 'STANDBY')`,
            [mesaIdSchema]
        );

        // BUG-012: padrões IA não podem sobreviver sem o Robô/Canal proprietário.
        // A limpeza é idempotente e também corrige órfãos deixados por versões anteriores.
        await limparPadroesDinamicosOrfaos();

        console.log("\n========================================================");
        console.log("🚀 MÓDULO BACKEND V12.0 PRO - MOTOR DE EXECUÇÃO INTEGRADO");
        console.log("========================================================\n");
    } catch (e) {
        console.error("❌ Erro Crítico ao preparar banco de dados:", e.message);
        throw e;
    }
}

// ==========================================
// 2. VARIÁVEIS GLOBAIS DE ESTADO EM MEMÓRIA
// ==========================================
let ESTRATEGIAS_MEMORIA = [];
let ROBOS_MEMORIA = [];
let AUTO_TRADERS_MEMORIA = [];
let arbitroFinanceiroAutoTrader = null;
let historicoGirosAnalitico = [];
let estadoApostas = {};

// MICRO-COMMIT 2:
// Um robô pode participar de somente um ciclo de sinal por vez.
// Locks são independentes por robo.id, permitindo paralelismo entre robôs diferentes.
const locksSinalPorRobo = new Map();

// Quando um robô sai de um ciclo, grava a rodada em que voltou a escutar.
// Um padrão novo só poderá ser reconhecido quando TODAS as suas casas tiverem
// ocorrido depois dessa fronteira.
const cursorRetomadaPorRobo = new Map();

// Cursor monotônico das rodadas aceitas pelo Node nesta execução.
let contadorRodadasSinal = 0;

let estadoStandbyRobos = {};
let idSessaoContinua = Date.now();
let estadoContinuidadeColetor = {
    sessao: null,
    seq: null,
    timestamp_coleta: null
};
// BUG-014C: a admissão avança sincronamente no recebimento para que duas requisições
// consecutivas nunca avaliem o mesmo estado enquanto a rodada anterior aguarda I/O.
let estadoContinuidadeRecepcao = {
    sessao: null,
    seq: null,
    timestamp_coleta: null
};
let caudaProcessamentoResultados = Promise.resolve();
let resultadosAguardandoProcessamento = 0;

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
            resultadosAguardandoProcessamento = Math.max(0, resultadosAguardandoProcessamento - 1);
            liberarProximo();
            return true;
        };
    });
}

function reservarContinuidadeResultado(dados) {
    const continuidade = avaliarContinuidadeResultado(estadoContinuidadeRecepcao, dados);
    if (continuidade.aceitar) {
        estadoContinuidadeRecepcao = { ...continuidade.estado };
    }
    return continuidade;
}

let contadorGirosParaLimpeza = 0;
let contadorGirosGlobalPiloto = 0;
let saldoGlobalCorretora = null;
let saldoGlobalAtualizadoEm = 0;
let backendPronto = false;

// ==========================================
// 3. SERVIDOR WEB E SOCKET
// ==========================================
function hostNodeEhLoopback(host) {
    const normalizado = String(host || '').trim().toLowerCase();
    return normalizado === '127.0.0.1' || normalizado === 'localhost' || normalizado === '::1';
}

function hostPermitidoParaNode(hostHeader, nodeHost, porta) {
    const recebido = String(hostHeader || '').trim().toLowerCase();
    if (!recebido) return false;

    const hostConfigurado = String(nodeHost || '').trim().toLowerCase();
    const portaTexto = String(porta);

    if (hostNodeEhLoopback(hostConfigurado)) {
        return new Set([
            `127.0.0.1:${portaTexto}`,
            `localhost:${portaTexto}`,
            `[::1]:${portaTexto}`
        ]).has(recebido);
    }

    const hostFormatado = hostConfigurado.includes(':') && !hostConfigurado.startsWith('[')
        ? `[${hostConfigurado}]`
        : hostConfigurado;
    return recebido === `${hostFormatado}:${portaTexto}`;
}

function origemCombinaComHost(origin, host) {
    if (!origin) return true;
    if (!host) return false;

    try {
        const urlOrigem = new URL(origin);
        const protocoloValido = urlOrigem.protocol === 'http:' || urlOrigem.protocol === 'https:';
        return protocoloValido && urlOrigem.host.toLowerCase() === String(host).toLowerCase();
    } catch (e) {
        return false;
    }
}

// SEC003B-ADMIN-AUTH
function compararTextoSeguro(recebido, esperado) {
    const recebidoBuffer = Buffer.from(String(recebido ?? ''), 'utf8');
    const esperadoBuffer = Buffer.from(String(esperado ?? ''), 'utf8');
    return recebidoBuffer.length === esperadoBuffer.length
        && crypto.timingSafeEqual(recebidoBuffer, esperadoBuffer);
}

function cookiesDoHeader(cookieHeader) {
    const cookies = {};
    for (const parte of String(cookieHeader || '').split(';')) {
        const indice = parte.indexOf('=');
        if (indice <= 0) continue;
        const nome = parte.slice(0, indice).trim();
        const valorBruto = parte.slice(indice + 1).trim();
        if (!nome) continue;
        try {
            cookies[nome] = decodeURIComponent(valorBruto);
        } catch (e) {
            cookies[nome] = valorBruto;
        }
    }
    return cookies;
}

function limparSessoesAdminExpiradas(agora = Date.now()) {
    for (const [token, expiraEm] of SESSOES_ADMIN.entries()) {
        if (!Number.isFinite(expiraEm) || expiraEm <= agora) {
            SESSOES_ADMIN.delete(token);
        }
    }
}

function criarSessaoAdmin(agora = Date.now()) {
    limparSessoesAdminExpiradas(agora);
    const token = crypto.randomBytes(32).toString('hex');
    SESSOES_ADMIN.set(token, agora + ADMIN_SESSION_TTL_MS);
    return token;
}

function tokenSessaoAdminDoCookie(cookieHeader) {
    return cookiesDoHeader(cookieHeader)[ADMIN_SESSION_COOKIE] || '';
}

function sessaoAdminValidaCookie(cookieHeader, agora = Date.now()) {
    if (!ADMIN_AUTH_REQUIRED) return true;
    limparSessoesAdminExpiradas(agora);
    const token = tokenSessaoAdminDoCookie(cookieHeader);
    if (!token) return false;
    const expiraEm = SESSOES_ADMIN.get(token);
    if (!Number.isFinite(expiraEm) || expiraEm <= agora) {
        if (token) SESSOES_ADMIN.delete(token);
        return false;
    }
    return true;
}

function cookieSessaoAdmin(token, maxAgeSeconds) {
    const secure = ADMIN_COOKIE_SECURE ? '; Secure' : '';
    return `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}${secure}`;
}

const app = express();
app.use((req, res, next) => {
    const host = req.get('Host');
    const hostPermitido = hostPermitidoParaNode(host, NODE_HOST, PORTA);
    const origemPermitida = origemCombinaComHost(req.get('Origin'), host);

    if (!hostPermitido || !origemPermitida) {
        return res.status(403).json({ erro: 'Origem ou host nao permitido' });
    }
    next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.get('/login', (req, res) => {
    if (!ADMIN_AUTH_REQUIRED || sessaoAdminValidaCookie(req.get('Cookie'))) {
        return res.redirect('/');
    }
    return res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/auth/login', (req, res) => {
    if (!ADMIN_AUTH_REQUIRED) {
        return res.redirect('/');
    }

    const usuario = String(req.body?.usuario || '').trim();
    const senha = String(req.body?.senha || '');
    const usuarioOk = compararTextoSeguro(usuario, ADMIN_USERNAME);
    const senhaOk = compararTextoSeguro(senha, ADMIN_PASSWORD);

    if (!usuarioOk || !senhaOk) {
        return res.redirect('/login?erro=1');
    }

    const token = criarSessaoAdmin();
    res.setHeader(
        'Set-Cookie',
        cookieSessaoAdmin(token, Math.floor(ADMIN_SESSION_TTL_MS / 1000))
    );
    return res.redirect('/');
});

app.post('/auth/logout', (req, res) => {
    const token = tokenSessaoAdminDoCookie(req.get('Cookie'));
    if (token) SESSOES_ADMIN.delete(token);
    res.setHeader('Set-Cookie', cookieSessaoAdmin('', 0));
    return res.redirect(ADMIN_AUTH_REQUIRED ? '/login' : '/');
});

app.use((req, res, next) => {
    const rotaInterna = req.path === '/receber-sinal'
        || req.path === '/executor-status'
        || req.path === '/collector-health';
    if (rotaInterna) return next();
    if (!ADMIN_AUTH_REQUIRED || sessaoAdminValidaCookie(req.get('Cookie'))) return next();

    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ erro: 'autenticacao_administrativa_necessaria' });
    }
    return res.redirect('/login');
});
app.use((req, res, next) => {
    const rotaDependeDeInicializacao = req.path === '/receber-sinal'
        || req.path === '/executor-status'
        || req.path === '/collector-health'
        || req.path.startsWith('/api/');
    if (rotaDependeDeInicializacao && !backendPronto) {
        return res.status(503).json({ erro: 'backend_inicializando' });
    }
    next();
});
app.use(express.static(path.join(__dirname, 'public')));

const NODE_HOST = (process.env.NODE_HOST || '127.0.0.1').trim() || '127.0.0.1';
const PORTA = Number(process.env.NODE_PORT || 3000);
const EXECUTOR_URL = process.env.EXECUTOR_URL || "http://127.0.0.1:5000/apostar";
const INTERNAL_API_TOKEN = (process.env.INTERNAL_API_TOKEN || "").trim();

const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || '').trim();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '');
const adminSessionTtlMinutesConfig = Number(process.env.ADMIN_SESSION_TTL_MINUTES || 720);
const ADMIN_SESSION_TTL_MS = (
    Number.isFinite(adminSessionTtlMinutesConfig)
    && adminSessionTtlMinutesConfig >= 5
    && adminSessionTtlMinutesConfig <= 1440
        ? adminSessionTtlMinutesConfig
        : 720
) * 60 * 1000;
const ADMIN_SESSION_COOKIE =
    nomeCookieEscopadoPorMesa(
        'bacbo_admin_session',
        process.env
    );
const adminCookieSecureConfig = String(process.env.ADMIN_COOKIE_SECURE || '').trim().toLowerCase();
const ADMIN_COOKIE_SECURE = adminCookieSecureConfig === 'true'
    || (adminCookieSecureConfig !== 'false' && !hostNodeEhLoopback(NODE_HOST));
const SESSOES_ADMIN = new Map();
const ADMIN_AUTH_CONFIGURED = Boolean(ADMIN_USERNAME || ADMIN_PASSWORD);
const ADMIN_AUTH_REQUIRED = !hostNodeEhLoopback(NODE_HOST) || ADMIN_AUTH_CONFIGURED;

if (ADMIN_AUTH_REQUIRED && (!ADMIN_USERNAME || !ADMIN_PASSWORD)) {
    throw new Error(
        "ADMIN_USERNAME/ADMIN_PASSWORD incompletos. Fora do loopback a autenticacao administrativa e obrigatoria."
    );
}

if (!INTERNAL_API_TOKEN) {
    throw new Error("INTERNAL_API_TOKEN nao configurado. Defina o segredo compartilhado no .env antes de iniciar o backend.");
}

function requisicaoInternaAutorizada(req) {
    const tokenRecebido = req.get("X-Internal-Token") || "";
    const recebido = Buffer.from(tokenRecebido, "utf8");
    const esperado = Buffer.from(INTERNAL_API_TOKEN, "utf8");
    return recebido.length === esperado.length && crypto.timingSafeEqual(recebido, esperado);
}

function headersInternos() {
    return {
        "Content-Type": "application/json",
        "X-Internal-Token": INTERNAL_API_TOKEN
    };
}

const EXECUTOR_TIMEOUT_MS = 5000;
const EXECUTOR_MAX_ATTEMPTS = 2;
const executorExecutionTimeoutConfig = Number(process.env.EXECUTOR_EXECUTION_TIMEOUT_MS || 210000);
const EXECUTOR_EXECUTION_TIMEOUT_MS = (
    Number.isFinite(executorExecutionTimeoutConfig)
    // O callback do Node precisa sobreviver ao fusível máximo de 180 s do
    // executor Python; valores antigos de 30 s voltam ao default seguro.
    && executorExecutionTimeoutConfig >= 195000
    && executorExecutionTimeoutConfig <= 360000
        ? executorExecutionTimeoutConfig
        : 210000
);
const CONFIRMACOES_EXECUTOR_PENDENTES = new Map();
const STATUS_EXECUTOR_VALIDOS = new Set(['EXECUTADA', 'FALHOU', 'EXPIRADA', 'AMBIGUA']);
const INTERRUPCOES_COLETOR_PROCESSADAS = new Map();
const LIMITE_INTERRUPCOES_COLETOR_MEMORIA = 1000;
const TELEGRAM_TIMEOUT_MS = 3000;
const balanceSyncMaxAgeSecondsConfig = Number(process.env.BALANCE_SYNC_MAX_AGE_SECONDS || 90);
const BALANCE_SYNC_MAX_AGE_MS = (
    Number.isFinite(balanceSyncMaxAgeSecondsConfig) && balanceSyncMaxAgeSecondsConfig >= 5
        ? balanceSyncMaxAgeSecondsConfig
        : 90
) * 1000;
const REDIS_URL = String(process.env.REDIS_URL || 'redis://127.0.0.1:6379').trim() || 'redis://127.0.0.1:6379';
const redisConnectTimeoutConfig = Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 3000);
const REDIS_CONNECT_TIMEOUT_MS = (
    Number.isFinite(redisConnectTimeoutConfig)
    && redisConnectTimeoutConfig >= 500
    && redisConnectTimeoutConfig <= 15000
        ? redisConnectTimeoutConfig
        : 3000
);
const balanceSyncResponseTimeoutConfig = Number(process.env.BALANCE_SYNC_RESPONSE_TIMEOUT_MS || 8000);
const BALANCE_SYNC_RESPONSE_TIMEOUT_MS = (
    Number.isFinite(balanceSyncResponseTimeoutConfig)
    && balanceSyncResponseTimeoutConfig >= 1000
    && balanceSyncResponseTimeoutConfig <= 30000
        ? balanceSyncResponseTimeoutConfig
        : 8000
);
let redisClient = null;
let redisSubscriber = null;
let redisSaldoAssinado = false;
let redisSaldoInicializacaoPromise = null;
const ESPERAS_ATUALIZACAO_SALDO_REDIS = new Set();

function snapshotSaldoGlobal(agora = Date.now()) {
    const saldoValido = Number.isFinite(saldoGlobalCorretora) && saldoGlobalCorretora >= 0;
    const timestampValido = Number.isFinite(saldoGlobalAtualizadoEm) && saldoGlobalAtualizadoEm > 0;
    const idadeMs = timestampValido ? Math.max(0, agora - saldoGlobalAtualizadoEm) : null;
    const fresco = saldoValido
        && timestampValido
        && idadeMs <= BALANCE_SYNC_MAX_AGE_MS;

    return {
        saldo_atual: saldoValido ? saldoGlobalCorretora : null,
        atualizado_em: timestampValido ? saldoGlobalAtualizadoEm : null,
        idade_ms: idadeMs,
        fresco
    };
}

function obterSaldoGlobalFresco(agora = Date.now()) {
    const snapshot = snapshotSaldoGlobal(agora);
    return snapshot.fresco ? snapshot.saldo_atual : null;
}

function criarClientesRedisSaldo() {
    if (redisClient && redisSubscriber) return;

    const { createClient } = require('redis');
    redisClient = createClient({
        url: REDIS_URL,
        socket: {
            connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
            reconnectStrategy: () => false
        }
    });
    redisSubscriber = redisClient.duplicate();

    redisClient.on('error', erro => {
        console.error('⚠️ Redis publisher do saldo:', erro.message);
    });
    redisSubscriber.on('error', erro => {
        console.error('⚠️ Redis subscriber do saldo:', erro.message);
    });
    redisSubscriber.on('end', () => {
        redisSaldoAssinado = false;
    });
}

function criarEsperaAtualizacaoSaldoRedis() {
    let ativa = true;
    let resolverPromessa = null;
    let rejeitarPromessa = null;
    let timeoutId = null;

    const promessa = new Promise((resolve, reject) => {
        resolverPromessa = resolve;
        rejeitarPromessa = reject;
    });

    const espera = {
        resolver(snapshot) {
            if (!ativa) return false;
            ativa = false;
            if (timeoutId) clearTimeout(timeoutId);
            ESPERAS_ATUALIZACAO_SALDO_REDIS.delete(espera);
            resolverPromessa(snapshot);
            return true;
        },
        cancelar() {
            if (!ativa) return false;
            ativa = false;
            if (timeoutId) clearTimeout(timeoutId);
            ESPERAS_ATUALIZACAO_SALDO_REDIS.delete(espera);
            return true;
        }
    };

    timeoutId = setTimeout(() => {
        if (!ativa) return;
        ativa = false;
        ESPERAS_ATUALIZACAO_SALDO_REDIS.delete(espera);
        rejeitarPromessa(new Error(`Sem balance_update via Redis em ${BALANCE_SYNC_RESPONSE_TIMEOUT_MS}ms`));
    }, BALANCE_SYNC_RESPONSE_TIMEOUT_MS);
    if (timeoutId && typeof timeoutId.unref === 'function') timeoutId.unref();

    ESPERAS_ATUALIZACAO_SALDO_REDIS.add(espera);
    return { promessa, cancelar: espera.cancelar };
}

function resolverEsperasAtualizacaoSaldoRedis(snapshot) {
    for (const espera of [...ESPERAS_ATUALIZACAO_SALDO_REDIS]) {
        espera.resolver(snapshot);
    }
}

async function aplicarSaldoGlobalRecebido(saldo, atualizadoEm = Date.now()) {
    const saldoNumero = Number(saldo);
    const timestampNumero = Number(atualizadoEm);
    if (!Number.isFinite(saldoNumero) || saldoNumero < 0) {
        throw new Error('balance_update invalido recebido via Redis');
    }
    if (!Number.isFinite(timestampNumero) || timestampNumero <= 0) {
        throw new Error('timestamp de balance_update invalido');
    }

    const timestampConfirmado = Math.trunc(timestampNumero);
    const mesaSaldo =
        afirmarMesaFinanceiraAutorizada(
            'balance_update'
        );
    const mesaIdSaldo = Number(mesaSaldo.id);

    await dbPool.query(
        'UPDATE auto_traders SET saldo_atual=? WHERE ativo=true AND mesa_id=?',
        [saldoNumero, mesaIdSaldo]
    );

    saldoGlobalCorretora = saldoNumero;
    saldoGlobalAtualizadoEm = timestampConfirmado;
    await confirmarSaldosPosLiquidacao(saldoNumero, timestampConfirmado);

    for (const trader of AUTO_TRADERS_MEMORIA) {
        if (trader.ativo) trader.saldo_atual = saldoNumero;
    }

    const snapshot = snapshotSaldoGlobal(timestampConfirmado);
    ioServer.emit('atualizar_interface');
    return snapshot;
}

async function processarRespostaSaldoRedis(mensagem) {
    let dados = null;
    try {
        dados = JSON.parse(String(mensagem || ''));
    } catch (e) {
        console.warn('⚠️ Resposta Redis de saldo ignorada: JSON invalido.');
        return false;
    }

    if (!dados || dados.action !== 'balance_update') return false;

    const saldo = Number(dados.balance);
    if (!Number.isFinite(saldo) || saldo < 0) {
        console.warn('⚠️ Resposta Redis balance_update ignorada: balance invalido.');
        return false;
    }

    const snapshot = await aplicarSaldoGlobalRecebido(saldo, Date.now());
    resolverEsperasAtualizacaoSaldoRedis(snapshot);
    console.log(`💰 Saldo real atualizado via Redis: R$ ${saldo.toFixed(2)}.`);
    return true;
}

async function garantirRedisSaldoPronto() {
    if (
        redisClient?.isReady === true
        && redisSubscriber?.isReady === true
        && redisSaldoAssinado
    ) {
        return true;
    }

    if (redisSaldoInicializacaoPromise) {
        await redisSaldoInicializacaoPromise;
        return true;
    }

    redisSaldoInicializacaoPromise = (async () => {
        criarClientesRedisSaldo();

        if (!redisClient.isOpen) {
            await redisClient.connect();
        }
        if (!redisSubscriber.isOpen) {
            await redisSubscriber.connect();
        }
        if (!redisSaldoAssinado) {
            await redisSubscriber.subscribe('auto_trader_responses', mensagem => {
                void processarRespostaSaldoRedis(mensagem).catch(erro => {
                    console.error('⚠️ Falha ao processar balance_update recebido via Redis:', erro.message);
                });
            });
            redisSaldoAssinado = true;
        }
    })();

    try {
        await redisSaldoInicializacaoPromise;
        return true;
    } finally {
        redisSaldoInicializacaoPromise = null;
    }
}

async function solicitarSincronizacaoSaldoRedis() {
    afirmarMesaFinanceiraAutorizada(
        'sync_balance'
    );

    await garantirRedisSaldoPronto();
    const espera = criarEsperaAtualizacaoSaldoRedis();

    try {
        await redisClient.publish('auto_trader_commands', JSON.stringify({action: 'sync_balance'}));
        return await espera.promessa;
    } catch (e) {
        espera.cancelar();
        throw e;
    }
}

// MC19:
// Ativação financeira nunca reutiliza saldo vencido.
// Se o cache global não estiver fresco, solicita uma
// leitura física ao executor e só libera a operação
// depois que o MESMO gate de freshness confirmar
// o balance_update recebido.
async function obterSaldoAutoTraderParaAtivacao() {
    try {
        afirmarMesaFinanceiraAutorizada(
            'ativacao_auto_trader'
        );
    } catch (e) {
        console.warn(
            'AUTO-TRADER | ativacao financeira bloqueada:',
            e.message
        );

        return {
            ok: false,
            saldo: null,
            sincronizado_agora: false,
            erro: String(
                e?.code
                || e?.message
                || 'MESA_FINANCEIRA_NAO_AUTORIZADA'
            )
        };
    }

    const saldoJaFresco = obterSaldoGlobalFresco();

    if (saldoJaFresco !== null) {
        return {
            ok: true,
            saldo: saldoJaFresco,
            sincronizado_agora: false,
            erro: null
        };
    }

    try {
        await solicitarSincronizacaoSaldoRedis();

        const saldoConfirmado =
            obterSaldoGlobalFresco();

        if (saldoConfirmado === null) {
            console.warn(
                '⚠️ AUTO-TRADER | sync de saldo respondeu, '
                + 'mas o gate de freshness permaneceu fechado.'
            );

            return {
                ok: false,
                saldo: null,
                sincronizado_agora: false,
                erro: 'SALDO_NAO_FICOU_FRESCO'
            };
        }

        return {
            ok: true,
            saldo: saldoConfirmado,
            sincronizado_agora: true,
            erro: null
        };
    } catch (e) {
        console.warn(
            '⚠️ AUTO-TRADER | sincronização automática '
            + 'de saldo para ativação falhou:',
            e.message
        );

        return {
            ok: false,
            saldo: null,
            sincronizado_agora: false,
            erro: String(
                e && e.message
                    ? e.message
                    : 'SYNC_BALANCE_FALHOU'
            )
        };
    }
}

function normalizarInterrupcaoColetorId(dados) {
    const id = String(dados?.interrupcao_id || '').trim();
    if (!id || id.length > 256 || !/^[A-Za-z0-9:_-]+$/.test(id)) return '';
    return id;
}

function reservarInterrupcaoColetor(dados, agora = Date.now()) {
    const id = normalizarInterrupcaoColetorId(dados);
    if (!id) return { id: '', repetida: false, legado: true };
    const existente = INTERRUPCOES_COLETOR_PROCESSADAS.get(id);
    if (existente) return { id, repetida: true, legado: false, estado: existente.estado };

    INTERRUPCOES_COLETOR_PROCESSADAS.set(id, { estado: 'PROCESSANDO', atualizado_em: agora });
    while (INTERRUPCOES_COLETOR_PROCESSADAS.size > LIMITE_INTERRUPCOES_COLETOR_MEMORIA) {
        const maisAntigo = INTERRUPCOES_COLETOR_PROCESSADAS.keys().next().value;
        INTERRUPCOES_COLETOR_PROCESSADAS.delete(maisAntigo);
    }
    return { id, repetida: false, legado: false, estado: 'PROCESSANDO' };
}

function concluirInterrupcaoColetor(id, sucesso, agora = Date.now()) {
    const normalizado = String(id || '').trim();
    if (!normalizado) return false;
    if (!sucesso) return INTERRUPCOES_COLETOR_PROCESSADAS.delete(normalizado);
    INTERRUPCOES_COLETOR_PROCESSADAS.set(normalizado, { estado: 'APLICADA', atualizado_em: agora });
    return true;
}

function interrupcaoColetorJaAplicada(dados) {
    const id = normalizarInterrupcaoColetorId(dados);
    if (!id) return false;
    const registro = INTERRUPCOES_COLETOR_PROCESSADAS.get(id);
    return registro?.estado === 'APLICADA';
}

function normalizarConfirmacaoExecucao(statusRecebido, confirmacaoRecebida) {
    const status = String(statusRecebido || '').trim().toUpperCase();
    if (status !== 'EXECUTADA') {
        return { status, confirmacao: null, motivo: null };
    }

    const confirmacao = confirmacaoRecebida && typeof confirmacaoRecebida === 'object'
        ? confirmacaoRecebida
        : {};
    const metodo = String(confirmacao.metodo || '').trim().toUpperCase();
    const saldoAntes = Number(confirmacao.saldo_antes);
    const saldoDepois = Number(confirmacao.saldo_depois);
    const exposicaoEsperada = Number(confirmacao.exposicao_esperada);
    const debitoObservado = Number(confirmacao.debito_observado);
    const confirmadaEm = Number(confirmacao.confirmada_em);
    const debitoCalculado = saldoAntes - saldoDepois;
    const tolerancia = 0.11;
    const valida = confirmacao.confirmada === true
        && metodo === 'SALDO_DEBITADO'
        && Number.isFinite(saldoAntes) && saldoAntes >= 0
        && Number.isFinite(saldoDepois) && saldoDepois >= 0
        && Number.isFinite(exposicaoEsperada) && exposicaoEsperada > 0
        && Number.isFinite(debitoObservado) && debitoObservado > 0
        && Number.isFinite(confirmadaEm) && confirmadaEm > 0
        && Math.abs(debitoCalculado - debitoObservado) <= tolerancia
        && Math.abs(debitoObservado - exposicaoEsperada) <= tolerancia;

    if (!valida) {
        return {
            status: 'AMBIGUA',
            confirmacao: null,
            motivo: 'Callback EXECUTADA recusado: aceite financeiro da Evolution ausente ou inconsistente'
        };
    }

    return {
        status: 'EXECUTADA',
        motivo: null,
        confirmacao: {
            metodo,
            saldo_antes: Number(saldoAntes.toFixed(2)),
            saldo_depois: Number(saldoDepois.toFixed(2)),
            exposicao_esperada: Number(exposicaoEsperada.toFixed(2)),
            debito_observado: Number(debitoObservado.toFixed(2)),
            confirmada_em: Math.trunc(confirmadaEm)
        }
    };
}

function criarEsperaResultadoExecutor(orderId) {
    const id = String(orderId || '').trim().toLowerCase();
    if (!id) throw new Error('order_id ausente ao criar espera de execução');
    if (CONFIRMACOES_EXECUTOR_PENDENTES.has(id)) {
        throw new Error(`Já existe espera de execução ativa para ${id}`);
    }

    let finalizado = false;
    let resultadoAtual = null;
    let resolverPromessa = null;
    let timeoutId = null;
    const promessa = new Promise(resolve => { resolverPromessa = resolve; });

    const finalizar = (resultado) => {
        if (finalizado) return false;
        finalizado = true;
        resultadoAtual = resultado;
        if (timeoutId) clearTimeout(timeoutId);
        CONFIRMACOES_EXECUTOR_PENDENTES.delete(id);
        resolverPromessa(resultado);
        return true;
    };

    timeoutId = setTimeout(() => {
        finalizar({
            order_id: id,
            status: 'TIMEOUT',
            motivo: `Sem callback do executor em ${EXECUTOR_EXECUTION_TIMEOUT_MS}ms`
        });
    }, EXECUTOR_EXECUTION_TIMEOUT_MS);
    if (timeoutId && typeof timeoutId.unref === 'function') timeoutId.unref();

    CONFIRMACOES_EXECUTOR_PENDENTES.set(id, {
        criado_em: Date.now(),
        finalizar
    });

    return {
        promessa,
        resultadoAtual: () => resultadoAtual,
        cancelar: () => finalizar({ order_id: id, status: 'CANCELADA', motivo: 'Espera cancelada' })
    };
}

function registrarResultadoExecucaoExecutor(dados) {
    const id = String(dados && dados.order_id || '').trim().toLowerCase();
    const pendente = CONFIRMACOES_EXECUTOR_PENDENTES.get(id);
    if (!pendente) return false;
    return pendente.finalizar({
        order_id: id,
        status: String(dados.status || '').trim().toUpperCase(),
        motivo: String(dados.motivo || '').slice(0, 300),
        confirmacao: dados.confirmacao || null
    });
}

function erroResultadoExecucaoExecutor(resultado) {
    const status = String(resultado && resultado.status || 'TIMEOUT').toUpperCase();
    const motivo = String(resultado && resultado.motivo || status);
    const erro = new Error(`Executor reportou ${status}: ${motivo}`);
    erro.status_executor = status;
    erro.envio_ambiguo = status === 'AMBIGUA' || status === 'TIMEOUT';
    return erro;
}

async function enviarOrdemAoExecutor(alvo, valor, orderId = crypto.randomUUID(), apostas = null) {
    afirmarMesaFinanceiraAutorizada(
        'place_bet'
    );

    const esperaExecucao = criarEsperaResultadoExecutor(orderId);
    let ultimoErro = null;
    let confirmacaoAceite = null;
    const planoLog = Array.isArray(apostas) && apostas.length > 0
        ? apostas.map(perna => `${perna.alvo}=R$${Number(perna.valor || 0).toFixed(2)}`).join(' + ')
        : `${alvo}=R$${Number(valor || 0).toFixed(2)}`;
    const exposicaoLog = Array.isArray(apostas) && apostas.length > 0
        ? apostas.reduce((total, perna) => total + (Number(perna.valor) || 0), 0)
        : Number(valor || 0);
    console.log(
        `📤 EXECUTOR | order_id=${orderId} | plano=${planoLog} | `
        + `exposição=R$${Number(exposicaoLog || 0).toFixed(2)} | aguardando execução física e prova de débito`
    );

    try {
        for (let tentativa = 1; tentativa <= EXECUTOR_MAX_ATTEMPTS; tentativa++) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), EXECUTOR_TIMEOUT_MS);

            try {
                const resposta = await fetch(EXECUTOR_URL, {
                    method: 'POST',
                    headers: headersInternos(),
                    body: JSON.stringify({
                        order_id: orderId,
                        alvo,
                        valor,
                        ...(Array.isArray(apostas) && apostas.length > 0
                            ? { apostas }
                            : {})
                    }),
                    signal: controller.signal
                });

                let corpo = null;
                try { corpo = await resposta.json(); } catch(e) {}

                if (!resposta.ok) {
                    const detalhe = corpo && (corpo.erro || corpo.status)
                        ? (corpo.erro || corpo.status)
                        : `HTTP ${resposta.status}`;
                    const erroHttp = new Error(`Executor recusou a ordem: ${detalhe}`);
                    erroHttp.statusHttp = resposta.status;
                    erroHttp.envio_ambiguo = !(corpo && corpo.aceita === false) && resposta.status >= 500;
                    throw erroHttp;
                }

                if (
                    !corpo
                    || !corpo.dados
                    || corpo.dados.order_id !== orderId
                    || corpo.dados.alvo !== alvo
                    || Number(corpo.dados.valor) !== Number(valor)
                ) {
                    throw new Error("Executor respondeu sem confirmar o ID e os dados da ordem");
                }

                if (corpo.duplicada === true) {
                    console.warn(`♻️ Executor confirmou ordem idempotente já recebida: ${orderId}`);
                }

                confirmacaoAceite = corpo;
                break;
            } catch (e) {
                const timeout = e && e.name === 'AbortError';
                const statusHttp = Number(e && e.statusHttp);
                const classificacaoExplicita = e && typeof e.envio_ambiguo === 'boolean';
                const erroRepetivel = classificacaoExplicita
                    ? e.envio_ambiguo
                    : (timeout || !Number.isFinite(statusHttp) || statusHttp >= 500);

                ultimoErro = timeout
                    ? new Error(`Timeout de ${EXECUTOR_TIMEOUT_MS}ms aguardando aceite da ordem ${orderId}`)
                    : e;
                ultimoErro.envio_ambiguo = erroRepetivel;

                // Um callback pode chegar mesmo quando a resposta HTTP do aceite se perdeu.
                if (esperaExecucao.resultadoAtual()) break;

                if (erroRepetivel && tentativa < EXECUTOR_MAX_ATTEMPTS) {
                    console.warn(`⚠️ Falha ambígua no aceite ${orderId}; repetindo com o mesmo ID (${tentativa + 1}/${EXECUTOR_MAX_ATTEMPTS}).`);
                    continue;
                }
                break;
            } finally {
                clearTimeout(timeoutId);
            }
        }

        const resultadoAntecipado = esperaExecucao.resultadoAtual();
        if (
            !confirmacaoAceite
            && ultimoErro
            && ultimoErro.envio_ambiguo !== true
            && !resultadoAntecipado
        ) {
            throw ultimoErro;
        }

        const resultadoExecucao = resultadoAntecipado || await esperaExecucao.promessa;
        if (resultadoExecucao.status !== 'EXECUTADA') {
            console.error(
                `❌ EXECUTOR | order_id=${orderId} | status=${resultadoExecucao.status} | `
                + `plano=${planoLog} | motivo=${String(resultadoExecucao.motivo || 'sem motivo')}`
            );
            throw erroResultadoExecucaoExecutor(resultadoExecucao);
        }

        const evidenciaLog = resultadoExecucao.confirmacao || {};
        console.log(
            `✅ EXECUTOR | order_id=${orderId} | plano=${planoLog} | método=${evidenciaLog.metodo || 'n/a'} | `
            + `saldo=${Number(evidenciaLog.saldo_antes).toFixed(2)}→${Number(evidenciaLog.saldo_depois).toFixed(2)} | `
            + `débito=R$${Number(evidenciaLog.debito_observado || 0).toFixed(2)} | `
            + `esperado=R$${Number(evidenciaLog.exposicao_esperada || exposicaoLog || 0).toFixed(2)} | `
            + `aceite financeiro confirmado`
        );

        const exposicaoEsperadaNode = Array.isArray(apostas) && apostas.length > 0
            ? apostas.reduce((total, perna) => total + (Number(perna.valor) || 0), 0)
            : Number(valor);
        const exposicaoConfirmadaExecutor = Number(resultadoExecucao.confirmacao?.exposicao_esperada);
        if (
            !Number.isFinite(exposicaoEsperadaNode)
            || exposicaoEsperadaNode <= 0
            || !Number.isFinite(exposicaoConfirmadaExecutor)
            || Math.abs(exposicaoConfirmadaExecutor - exposicaoEsperadaNode) > 0.11
        ) {
            throw erroResultadoExecucaoExecutor({
                status: 'AMBIGUA',
                motivo: 'Exposição confirmada pelo executor diverge do plano financeiro emitido pelo Node'
            });
        }

        if (!confirmacaoAceite && ultimoErro) {
            console.warn(
                `⚠️ ACK HTTP da ordem ${orderId} ficou ambíguo, mas callback EXECUTADA foi recebido; `
                + `o resultado local da interação DOM prevaleceu.`
            );
        }

        return {
            ...(confirmacaoAceite || {}),
            status: confirmacaoAceite?.status || 'Execução DOM confirmada por callback',
            duplicada: confirmacaoAceite?.duplicada === true,
            dados: confirmacaoAceite?.dados || { order_id: orderId, alvo, valor },
            execucao: resultadoExecucao
        };
    } finally {
        esperaExecucao.cancelar();
    }
}

function classificarStatusFalhaEnvioExecutor(erro) {
    const statusExecutor = String(erro && erro.status_executor || '').toUpperCase();
    if (statusExecutor === 'FALHOU') return 'FALHA_EXECUCAO';
    if (statusExecutor === 'EXPIRADA') return 'ORDEM_EXPIRADA';
    return erro && erro.envio_ambiguo === true ? 'ENVIO_AMBIGUO' : 'FALHA_ENVIO';
}

async function criarIntencaoOrdem(queryable, dados) {
    const mesaRuntime = obterMesaRuntime();
    const mesaId = Number(mesaRuntime.id);

    if (!Number.isInteger(mesaId) || mesaId <= 0) {
        throw new Error(
            'MC22-X: mesa runtime invalida ao criar intencao financeira'
        );
    }

    const orderId = String(
        dados.order_id || crypto.randomUUID()
    );

    const [resultado] = await queryable.query(
        `INSERT INTO auditoria_ordens
            (mesa_id, trader_id, estrategia_id, estrategia_nome,
             fonte_sinal, alvo, nivel, risco_total,
             valor_entrada, valor_empate,
             executor_order_id, status_ordem)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PREPARANDO')`,
        [
            mesaId,
            dados.trader_id,
            dados.estrategia_id ?? null,
            dados.estrategia_nome,
            dados.fonte_sinal,
            dados.alvo,
            dados.nivel,
            dados.risco_total,
            dados.valor_entrada,
            Math.max(
                0,
                Number(dados.valor_empate) || 0
            ),
            orderId
        ]
    );

    const auditoriaId = Number(resultado.insertId);

    if (
        !Number.isInteger(auditoriaId)
        || auditoriaId <= 0
    ) {
        throw new Error(
            'MySQL nao retornou ID valido para a intencao de ordem'
        );
    }

    return {
        auditoria_id: auditoriaId,
        order_id: orderId,
        mesa_id: mesaId
    };
}

async function marcarIntencaoAposFalhaEnvio(
    auditoriaId,
    erro,
    contexto
) {
    const mesaRuntime = obterMesaRuntime();
    const status =
        classificarStatusFalhaEnvioExecutor(erro);

    try {
        const [resultado] = await dbPool.query(
            `UPDATE auditoria_ordens
             SET status_ordem=?
             WHERE id=?
               AND mesa_id=?
               AND status_ordem='PREPARANDO'`,
            [
                status,
                auditoriaId,
                mesaRuntime.id
            ]
        );

        if (Number(resultado.affectedRows) !== 1) {
            console.error(
                `${contexto}: intencao ${auditoriaId} ` +
                `nao estava PREPARANDO na mesa ` +
                `${mesaRuntime.codigo} ao registrar ${status}.`
            );
        }
    } catch (persistenciaErro) {
        console.error(
            `${contexto}: falha ao persistir ${status} ` +
            `na intencao ${auditoriaId}; PREPARANDO permanece ` +
            `como evidencia conservadora:`,
            persistenciaErro.message
        );
    }

    return status;
}

async function bloquearTraderAposExecucaoAmbigua(
    trader,
    statusFalha,
    contexto
) {
    if (
        statusFalha !== 'ENVIO_AMBIGUO'
        || !trader
    ) {
        return false;
    }

    let mesaId;

    try {
        mesaId = mesaIdFinanceiroTrader(
            trader,
            'bloqueio por execucao ambigua'
        );
    } catch (erroMesa) {
        trader.ativo = false;
        trader.status_operacao =
            'BLOQUEADO_AMBIGUIDADE';

        console.error(
            `MC22-X: Trader ${trader.id} com ownership ` +
            `de mesa invalido; bloqueado somente em memoria.`,
            erroMesa.message
        );

        return false;
    }

    trader.ativo = false;
    trader.status_operacao =
        'BLOQUEADO_AMBIGUIDADE';

    try {
        const [resultado] = await dbPool.query(
            `UPDATE auto_traders
             SET ativo=false,
                 status_operacao='BLOQUEADO_AMBIGUIDADE'
             WHERE id=?
               AND mesa_id=?`,
            [
                trader.id,
                mesaId
            ]
        );

        if (Number(resultado.affectedRows) !== 1) {
            throw new Error(
                'Trader nao encontrado na mesa runtime'
            );
        }

        console.error(
            `Auto-Trader ${trader.id} bloqueado por ` +
            `execucao financeira ambigua (${contexto}).`
        );

        return true;
    } catch (erro) {
        console.error(
            `Falha ao persistir bloqueio de seguranca do ` +
            `Auto-Trader ${trader.id}:`,
            erro.message
        );

        return false;
    }
}

if (!hostNodeEhLoopback(NODE_HOST)) {
    console.warn(
        `SEC-003B: NODE_HOST=${NODE_HOST} fora do loopback com autenticacao administrativa ativa. `
        + `Use HTTPS/reverse proxy e mantenha ADMIN_COOKIE_SECURE habilitado em rede nao confiavel.`
    );
} else if (ADMIN_AUTH_REQUIRED) {
    console.log('SEC-003B: autenticacao administrativa ativa tambem no loopback.');
}

const server = app.listen(PORTA, NODE_HOST, () => {
    const hostExibicao = NODE_HOST.includes(':') ? `[${NODE_HOST}]` : NODE_HOST;
    console.log(`🌐 Painel Web rodando em http://${hostExibicao}:${PORTA}`);
    console.log(`📡 Webhook aguardando sinais em: http://${hostExibicao}:${PORTA}/receber-sinal`);
});

const ioServer = new Server(server, {
    allowRequest: (req, callback) => {
        const host = req.headers.host;
        const hostPermitido = hostPermitidoParaNode(host, NODE_HOST, PORTA);
        const origemPermitida = origemCombinaComHost(req.headers.origin, host);
        const authAdminPermitida = !ADMIN_AUTH_REQUIRED
            || sessaoAdminValidaCookie(req.headers.cookie);
        callback(
            null,
            backendPronto && hostPermitido && origemPermitida && authAdminPermitida
        );
    }
});

const integracaoContadorDiario = criarIntegracaoContadorDiario({
    controleDiarioAutoTrader,
    dbPool,
    ioServer,
    traders: () => AUTO_TRADERS_MEMORIA
});

const autoPilotIA = criarAutoPilotService({
    dbPool,
    estaOcupado: () => Object.values(estadoApostas).some(estado => estado && estado.aguardandoResultado),
    recarregarMemoria: carregarSistemasParaMemoria,
    notificar: (roboId, resumo) => {
        ioServer.emit('atualizar_robos');
        ioServer.emit('atualizar_interface');
        console.log(
            `🧠 Auto Pilot IA ${roboId}: ${resumo.ativos.length} ativo(s), `
            + `${resumo.reservas} reserva(s), ${resumo.sombra} sombra.`
        );
    },
    log: console
});

// ==========================================
// 4. FUNÇÕES DE ARREDONDAMENTO (SMART ROUNDING)
// ==========================================
function calcularFichaSegura(valorDesejado) {
    let valor = parseFloat(valorDesejado);
    if (isNaN(valor) || valor <= 0) return 0;

    let valorArredondado = Math.round(valor / 5) * 5;
    if (valorArredondado === 0 && valor > 0) {
        valorArredondado = 5;
    }
    return valorArredondado;
}

function criarDetalhesPadraoVazios() {
    const periodo = () => ({
        green_direto: 0,
        gale1: 0,
        gale2: 0,
        red: 0,
        ties: { direto: {}, gale1: {}, gale2: {} }
    });
    return {
        '24h': periodo(),
        hoje: periodo(),
        semana: periodo(),
        mes: periodo(),
        geral: periodo()
    };
}

function limitesPeriodosHistorico(agoraMs = Date.now()) {
    const agora = new Date(agoraMs);
    if (!Number.isFinite(agoraMs) || Number.isNaN(agora.getTime())) {
        return limitesPeriodosHistorico(Date.now());
    }

    const inicioHoje = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate()).getTime();
    const inicioSemana = new Date(
        agora.getFullYear(),
        agora.getMonth(),
        agora.getDate() - agora.getDay()
    ).getTime();
    const inicioMes = new Date(agora.getFullYear(), agora.getMonth(), 1).getTime();

    return {
        '24h': agoraMs - (24 * 60 * 60 * 1000),
        hoje: inicioHoje,
        semana: inicioSemana,
        mes: inicioMes
    };
}

function calcularDetalhesPadraoNoHistorico(est, dadosArr, agoraMs = Date.now()) {
    const detalhes = criarDetalhesPadraoVazios();
    if (!est || !Array.isArray(dadosArr) || dadosArr.length === 0) return detalhes;

    let padraoArr = est.padrao;
    if (!Array.isArray(padraoArr)) {
        try { padraoArr = JSON.parse(String(padraoArr || '[]')); } catch (e) { padraoArr = []; }
    }
    if (!Array.isArray(padraoArr) || padraoArr.length === 0) return detalhes;
    padraoArr = padraoArr.map(String);

    const alvo = String(est.entrada || '');
    if (alvo !== 'Player' && alvo !== 'Banker') return detalhes;

    const gales = Math.max(0, Math.floor(Number(est.gales) || 0));
    const protegerEmpate = est.proteger_empate === true
        || Number(est.proteger_empate) === 1
        || est.protegerEmpate === true;
    const limites = limitesPeriodosHistorico(agoraMs);
    const tamanho = padraoArr.length;

    const periodosDaOcorrencia = (timestampMs) => {
        const periodos = ['geral'];
        const ts = Number(timestampMs);
        if (!Number.isFinite(ts) || ts <= 0) return periodos;
        if (ts >= limites['24h']) periodos.push('24h');
        if (ts >= limites.hoje) periodos.push('hoje');
        if (ts >= limites.semana) periodos.push('semana');
        if (ts >= limites.mes) periodos.push('mes');
        return periodos;
    };

    const registrarDesfecho = (periodos, tipo, nivel, multiplicador) => {
        for (const periodo of periodos) {
            const stats = detalhes[periodo];
            if (tipo === 'GREEN') {
                if (nivel === 0) stats.green_direto++;
                else if (nivel === 1) stats.gale1++;
                else if (nivel === 2) stats.gale2++;
            } else if (tipo === 'TIE') {
                const nivelTie = nivel === 0 ? 'direto' : (nivel === 1 ? 'gale1' : 'gale2');
                const mult = String(multiplicador || '4x');
                if (!stats.ties[nivelTie][mult]) stats.ties[nivelTie][mult] = 0;
                stats.ties[nivelTie][mult]++;
            } else if (tipo === 'RED') {
                stats.red++;
            }
        }
    };

    for (let i = 0; i <= dadosArr.length - tamanho - 1; i++) {
        const sessaoBase = dadosArr[i].id_sessao;
        let match = true;

        for (let p = 0; p < tamanho; p++) {
            const giroPadrao = dadosArr[i + p];
            if (!giroPadrao
                || String(giroPadrao.resultado) !== padraoArr[p]
                || giroPadrao.id_sessao !== sessaoBase) {
                match = false;
                break;
            }
        }
        if (!match) continue;

        let currentIndex = i + tamanho;
        if (currentIndex >= dadosArr.length || dadosArr[currentIndex].id_sessao !== sessaoBase) continue;

        let step = 0;
        let desfecho = null;
        let lastIndexChecked = currentIndex;

        while (step <= gales && currentIndex < dadosArr.length) {
            const giroResultado = dadosArr[currentIndex];
            if (giroResultado.id_sessao !== sessaoBase) break;

            lastIndexChecked = currentIndex;
            const resultado = String(giroResultado.resultado || '');
            if (resultado === alvo) {
                desfecho = { tipo: 'GREEN', nivel: step, multiplicador: '' };
                break;
            }
            if (resultado === 'Tie' && protegerEmpate) {
                desfecho = {
                    tipo: 'TIE',
                    nivel: step,
                    multiplicador: giroResultado.multiplicador || '4x'
                };
                break;
            }

            step++;
            currentIndex++;
        }

        if (!desfecho
            && step > gales
            && lastIndexChecked < dadosArr.length
            && dadosArr[lastIndexChecked].id_sessao === sessaoBase) {
            desfecho = { tipo: 'RED', nivel: gales, multiplicador: '' };
        }
        if (!desfecho) continue;

        const periodos = periodosDaOcorrencia(dadosArr[i].timestamp_ms);
        registrarDesfecho(periodos, desfecho.tipo, desfecho.nivel, desfecho.multiplicador);
    }

    return detalhes;
}

async function carregarHistoricoGirosAnalitico() {
    const mesaRuntime = obterMesaRuntime();

    const [linhas] = await dbPool.query(`
        SELECT
            id,
            resultado,
            multiplicador,
            id_sessao,
            UNIX_TIMESTAMP(data_hora) * 1000 AS timestamp_ms
        FROM giros_recentes
        WHERE mesa_id=?
        ORDER BY id ASC
    `, [mesaRuntime.id]);

    historicoGirosAnalitico = linhas.map(row => ({
        id: Number(row.id) || 0,
        resultado: String(row.resultado || ''),
        multiplicador: String(row.multiplicador || ''),
        id_sessao: row.id_sessao,
        timestamp_ms: Number(row.timestamp_ms) || 0
    }));

    console.log(`📚 Histórico analítico carregado: ${historicoGirosAnalitico.length} giros.`);
}

function mesaIdRuntimeApi() {
    const mesaRuntime = obterMesaRuntime();
    const mesaId = Number(mesaRuntime.id);

    if (!Number.isInteger(mesaId) || mesaId <= 0) {
        throw new Error(
            'MC22-W-BC: mesa runtime invalida para API'
        );
    }

    return mesaId;
}

// ==========================================
// 5. ROTAS DE API
// ==========================================
app.get("/api/saldo-global", async (req, res) => {
    try {
        const snapshot = await solicitarSincronizacaoSaldoRedis();
        return res.json(snapshot);
    } catch (e) {
        console.error('⚠️ GET /api/saldo-global: sincronização sob demanda via Redis falhou:', e.message);
        return res.status(503).json({
            ...snapshotSaldoGlobal(),
            erro: 'sincronizacao_saldo_indisponivel'
        });
    }
});

app.get("/api/estrategias", async (req, res) => {
    try {
        const mesaId = mesaIdRuntimeApi();
        const [linhas] = await dbPool.query(
            'SELECT * FROM estrategias WHERE mesa_id=? ORDER BY id DESC',
            [mesaId]
        );
        const agoraMs = Date.now();

        res.json(linhas.map(est => ({
            ...est,
            detalhes: calcularDetalhesPadraoNoHistorico(est, historicoGirosAnalitico, agoraMs)
        })));
    } catch (erro) {
        console.error('❌ GET /api/estrategias falhou:', erro.message);
        res.status(500).json({ erro: "Erro ao buscar estratégias" });
    }
});

app.get("/api/dashboard-stats", async (req, res) => {
    try {
        const mesaId = mesaIdRuntimeApi();
        const { robo_id, periodo = '24h', origem = 'TODAS' } = req.query;
        let queryWhere = "WHERE h.mesa_id=?";
        let queryParams = [mesaId];

        if (periodo === '24h') queryWhere += " AND h.data_hora >= DATE_SUB(NOW(), INTERVAL 24 HOUR)";
        else if (periodo === 'hoje') queryWhere += " AND DATE(h.data_hora) = CURDATE()";
        else if (periodo === 'semana') queryWhere += " AND YEARWEEK(h.data_hora, 0) = YEARWEEK(CURDATE(), 0)";
        else if (periodo === 'mes') queryWhere += " AND YEAR(h.data_hora) = YEAR(CURDATE()) AND MONTH(h.data_hora) = MONTH(CURDATE())";

        if (robo_id && robo_id !== 'TODOS') { queryWhere += " AND h.robo_id = ?"; queryParams.push(robo_id); }
        if (origem && origem !== 'TODAS') { queryWhere += " AND h.estrategia_origem = ?"; queryParams.push(origem); }

        const [linhas] = await dbPool.query(`
            SELECT h.id, h.tipo_resultado, h.nivel, h.multiplicador, h.data_hora
            FROM historico_disparos_robos h
            LEFT JOIN estrategias e
              ON h.estrategia_id = e.id
             AND e.mesa_id = h.mesa_id
            ${queryWhere}
            ORDER BY h.data_hora ASC, h.id ASC
        `, queryParams);

        let sinais = linhas.length;
        let greens = 0;
        let reds = 0;
        let ties = 0;
        let greenSeq = 0;
        let redSeq = 0;
        let maxGreenSeq = 0;
        let maxRedSeq = 0;

        linhas.forEach(row => {
            if (row.tipo_resultado === 'GREEN' || row.tipo_resultado === 'TIE') {
                greens++;
                if (row.tipo_resultado === 'TIE') ties++;
                greenSeq++;
                redSeq = 0;
                maxGreenSeq = Math.max(maxGreenSeq, greenSeq);
            } else if (row.tipo_resultado === 'RED') {
                reds++;
                redSeq++;
                greenSeq = 0;
                maxRedSeq = Math.max(maxRedSeq, redSeq);
            } else {
                greenSeq = 0;
                redSeq = 0;
            }
        });

        let assertividade = (sinais > 0) ? ((greens / sinais) * 100).toFixed(1) : 0;
        res.json({
            sinais,
            greens,
            reds,
            ties,
            max_green_seq: maxGreenSeq,
            max_red_seq: maxRedSeq,
            assertividade: assertividade + '%'
        });
    } catch (e) {
        console.error('❌ GET /api/dashboard-stats falhou:', e.message);
        res.status(500).json({
            sinais: 0,
            greens: 0,
            reds: 0,
            ties: 0,
            max_green_seq: 0,
            max_red_seq: 0,
            assertividade: '0%'
        });
    }
});

app.get("/api/historico-giros", async (req, res) => {
    try {
        const mesaId = mesaIdRuntimeApi();
        let limit = parseInt(req.query.limit) || 1000;
        if (limit > 10000) limit = 10000;
        const [linhas] = await dbPool.query(
            `SELECT resultado, multiplicador, data_hora, id_sessao
             FROM giros_recentes
             WHERE mesa_id=?
             ORDER BY id DESC
             LIMIT ${limit}`,
            [mesaId]
        );
        res.json(linhas.reverse());
    } catch (e) {
        console.error('❌ GET /api/historico-giros falhou:', e.message);
        res.status(500).json([]);
    }
});


app.post("/api/oraculo/analisar", async (req, res) => {
    try {
        const mesaId = mesaIdRuntimeApi();
        const gales = Number(req.body?.gales);
        const janela = String(req.body?.janela || '').trim().toLowerCase();
        const confiancaMinima = Number(req.body?.confianca_minima);
        const janelasSql = {
            '24h': 'data_hora >= DATE_SUB(NOW(), INTERVAL 24 HOUR)',
            '48h': 'data_hora >= DATE_SUB(NOW(), INTERVAL 48 HOUR)',
            '7d': 'data_hora >= DATE_SUB(NOW(), INTERVAL 7 DAY)'
        };

        if (!Number.isInteger(gales) || gales < 0 || gales > 2) {
            return res.status(400).json({ erro: 'gales_invalidos', mensagem: 'Gales Permitidos deve ser 0, 1 ou 2.' });
        }
        if (!janelasSql[janela]) {
            return res.status(400).json({ erro: 'janela_invalida', mensagem: 'Janela Histórica deve ser 24h, 48h ou 7d.' });
        }
        if (!Number.isFinite(confiancaMinima) || confiancaMinima < 0 || confiancaMinima > 100) {
            return res.status(400).json({ erro: 'confianca_invalida', mensagem: 'Confiança Mínima deve estar entre 0 e 100.' });
        }

        const mesaClientePrevia =
            (Array.isArray(req.body?.mesa_atual) ? req.body.mesa_atual : [])
                .map(normalizarResultadoOraculo)
                .filter(Boolean)
                .slice(-20);

        const empatesClienteUltimos5 =
            mesaClientePrevia
                .slice(-5)
                .filter(item => item === 'T')
                .length;

        if (
            mesaClientePrevia.length >= 5
            && empatesClienteUltimos5 >= 2
        ) {
            return res.json({
                status: 'REJEITADO',
                motivo: 'MESA_INSTAVEL',
                detalhe: 'EMPATES_EXCESSIVOS',
                melhor_confianca: 0,
                empates_ultimos_5: empatesClienteUltimos5,
                mensagem: 'Mesa Instável: dois ou mais empates foram observados nos últimos cinco giros.'
            });
        }

        const sql =
            'SELECT id, resultado, id_sessao, UNIX_TIMESTAMP(data_hora) * 1000 AS timestamp_ms '
            + 'FROM giros_recentes WHERE mesa_id=? AND ('
            + janelasSql[janela]
            + ') ORDER BY id ASC';

        const [linhas] = await dbPool.query(
            sql,
            [mesaId]
        );
        const historico = Array.isArray(linhas) ? linhas : [];
        const mesaAtual = extrairMesaAtual(historico, 20);

        const mesaCliente = (Array.isArray(req.body?.mesa_atual) ? req.body.mesa_atual : [])
            .map(normalizarResultadoOraculo)
            .filter(Boolean)
            .slice(-6);
        const mesaCanonica6 = mesaAtual.slice(-6).map(item => item.resultado);
        if (
            mesaCliente.length >= 6
            && mesaCanonica6.length >= 6
            && mesaCliente.join(',') !== mesaCanonica6.join(',')
        ) {
            return res.json({
                status: 'REJEITADO',
                motivo: 'MESA_INSTAVEL',
                detalhe: 'MESA_DESSINCRONIZADA',
                melhor_confianca: 0,
                mensagem: 'A mesa mudou entre o visor e o histórico canônico. Atualize e analise novamente.'
            });
        }

        const resultado = analisarOraculo({
            historico,
            mesaAtual,
            gales,
            confiancaMinima
        });

        const confiancaLog = resultado.status === 'APROVADO'
            ? resultado.confianca_wilson
            : resultado.melhor_confianca;
        console.log(
            '🔮 ORÁCULO | ' + resultado.status
            + ' | janela=' + janela
            + ' | gales=' + gales
            + ' | wilson=' + Number(confiancaLog || 0).toFixed(1) + '%'
        );
        return res.json(resultado);
    } catch (e) {
        console.error('❌ POST /api/oraculo/analisar falhou:', e.message);
        return res.status(500).json({
            erro: 'falha_oraculo',
            mensagem: 'Não foi possível concluir a análise estatística sob demanda.'
        });
    }
});

app.post("/api/simular-banca", async (req, res) => {
    try {
        const mesaId = mesaIdRuntimeApi();
        const { tipo_alvo, alvo_id, banca_inicial, stake_principal, cobrir_empate, pct_empate, mult_gale, periodo, filtro_horario, hora_inicio, hora_fim } = req.body;
        let query = ""; let params = [];

        if (tipo_alvo === 'ESTRATEGIA') {
            query = "SELECT tipo_resultado, nivel, multiplicador, data_hora, estrategia_id FROM historico_resultados WHERE mesa_id=? AND estrategia_id=?";
            params.push(mesaId, alvo_id);
        } else if (tipo_alvo === 'ORIGEM') {
            query = "SELECT h.tipo_resultado, h.nivel, h.multiplicador, h.data_hora, h.estrategia_id FROM historico_resultados h JOIN estrategias e ON h.estrategia_id=e.id AND e.mesa_id=h.mesa_id WHERE h.mesa_id=? AND e.origem=?";
            params.push(mesaId, alvo_id);
        } else if (tipo_alvo === 'ROBO') {
            query = "SELECT tipo_resultado, nivel, multiplicador, data_hora, estrategia_id FROM historico_disparos_robos WHERE mesa_id=? AND robo_id=?";
            params.push(mesaId, alvo_id);
        }

        if (periodo === '24h') query += " AND data_hora >= DATE_SUB(NOW(), INTERVAL 24 HOUR)";
        else if (periodo === 'hoje') query += " AND DATE(data_hora) = CURDATE()";
        else if (periodo === 'semana') query += " AND YEARWEEK(data_hora, 0) = YEARWEEK(CURDATE(), 0)";
        else if (periodo === 'mes') query += " AND YEAR(data_hora) = YEAR(CURDATE()) AND MONTH(data_hora) = MONTH(CURDATE())";

        query += " ORDER BY data_hora ASC";
        const [linhas] = await dbPool.query(query, params);

        const [estrategias] = await dbPool.query(
            'SELECT id, gales FROM estrategias WHERE mesa_id=?',
            [mesaId]
        );
        let estMap = {}; estrategias.forEach(e => { estMap[e.id] = e.gales; });

        let filtered = linhas;
        if (filtro_horario && hora_inicio && hora_fim) {
            const tStart = parseInt(hora_inicio.replace(':', '')); const tEnd = parseInt(hora_fim.replace(':', ''));
            filtered = linhas.filter(r => {
                let d = new Date(r.data_hora); let timeNum = d.getHours() * 100 + d.getMinutes();
                if (tStart <= tEnd) return timeNum >= tStart && timeNum <= tEnd;
                else return timeNum >= tStart || timeNum <= tEnd;
            });
        }

        let saldo = parseFloat(banca_inicial); let peak = saldo; let max_dd = 0; let equity_curve = [saldo]; let dates = ['Início']; let greens = 0; let reds = 0;

        for (let i = 0; i < filtered.length; i++) {
            let row = filtered[i]; let gales_jogados = 0; let is_win = (row.tipo_resultado === 'GREEN' || row.tipo_resultado === 'TIE');
            if (is_win) {
                if (row.nivel === 'DIRETO') gales_jogados = 0; else if (row.nivel === 'GALE1') gales_jogados = 1; else if (row.nivel === 'GALE2') gales_jogados = 2;
            } else { gales_jogados = estMap[row.estrategia_id] !== undefined ? estMap[row.estrategia_id] : 2; }

            let custoSoma = 0; let lucro = 0; let stakeAtual = parseFloat(stake_principal);
            let tieAtual = cobrir_empate ? stakeAtual * (parseFloat(pct_empate) / 100) : 0; let mult = parseFloat(mult_gale);

            for (let g = 0; g < gales_jogados; g++) { custoSoma += (stakeAtual + tieAtual); stakeAtual *= mult; tieAtual *= mult; }
            custoSoma += (stakeAtual + tieAtual);

            if (is_win) {
                if (row.tipo_resultado === 'TIE') {
                    let tieMult = parseInt((row.multiplicador || '4x').replace('x', ''));
                    lucro = (tieAtual * tieMult) + (stakeAtual * 0.9);
                } else { lucro = stakeAtual * 2; }
            }

            saldo = saldo - custoSoma + lucro;
            if (saldo > peak) peak = saldo;
            let current_dd = peak - saldo; if (current_dd > max_dd) max_dd = current_dd;

            equity_curve.push(saldo);
            let dObj = new Date(row.data_hora); dates.push(`${dObj.getDate()}/${dObj.getMonth()+1} ${dObj.getHours().toString().padStart(2, '0')}:${dObj.getMinutes().toString().padStart(2, '0')}`);

            if (is_win) greens++; else reds++;
        }

        let total_sinais = greens + reds; let win_rate = total_sinais > 0 ? ((greens / total_sinais) * 100).toFixed(1) : 0;
        let lucro_liquido = saldo - parseFloat(banca_inicial); let lucro_perc = ((lucro_liquido / parseFloat(banca_inicial)) * 100).toFixed(2);

        res.json({ sucesso: true, banca_inicial: parseFloat(banca_inicial), saldo_final: saldo, lucro_liquido, lucro_perc, max_drawdown: max_dd, max_drawdown_perc: ((max_dd / peak) * 100).toFixed(2), win_rate, total_sinais, equity_curve, dates });
    } catch (e) {
        console.error('❌ POST /api/simular-banca falhou:', e.message);
        res.status(500).json({ sucesso: false, erro: e.message });
    }
});

app.post("/api/novo-padrao", async (req, res) => {
    try {
        const mesaId = mesaIdRuntimeApi();
        const { nome, origem, padrao, entrada, gales, protegerEmpate, ativo } = req.body;
        const padraoJson = JSON.stringify(padrao.split(',').map(s => s.trim()));
        const id = "padrao_" + Date.now();
        const tiesZerado = JSON.stringify({ direto: { '88x': 0, '25x': 0, '10x': 0, '6x': 0, '4x': 0 }, gale1: { '88x': 0, '25x': 0, '10x': 0, '6x': 0, '4x': 0 }, gale2: { '88x': 0, '25x': 0, '10x': 0, '6x': 0, '4x': 0 } });
        await dbPool.query(
            'INSERT INTO estrategias (id, mesa_id, nome, origem, padrao, entrada, gales, proteger_empate, ativo, green_direto, gale1, gale2, red, ties_json, is_dinamico) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, false)',
            [
                id, mesaId, nome, origem, padraoJson, entrada,
                parseInt(gales), protegerEmpate ? 1 : 0,
                ativo ? 1 : 0, tiesZerado
            ]
        );
        await carregarSistemasParaMemoria(); ioServer.emit('atualizar_interface'); res.json({ sucesso: true });
    } catch (erro) {
        console.error('❌ POST /api/novo-padrao falhou:', erro.message);
        res.status(500).json({ sucesso: false });
    }
});

app.put("/api/estrategia/:id", async (req, res) => {
    try {
        const mesaId = mesaIdRuntimeApi();
        const { nome, origem, padrao, entrada, gales, protegerEmpate, ativo } = req.body;
        const padraoJson = JSON.stringify(padrao.split(',').map(s => s.trim()));
        const [resultadoUpdate] = await dbPool.query(
            'UPDATE estrategias SET nome=?, origem=?, padrao=?, entrada=?, gales=?, proteger_empate=?, ativo=? WHERE id=? AND mesa_id=? AND is_dinamico=false',
            [
                nome, origem, padraoJson, entrada, parseInt(gales),
                protegerEmpate ? 1 : 0, ativo ? 1 : 0,
                req.params.id, mesaId
            ]
        );

        if (Number(resultadoUpdate.affectedRows) !== 1) {
            return res.status(404).json({
                sucesso: false,
                erro: 'estrategia_nao_encontrada'
            });
        }

        await carregarSistemasParaMemoria(); ioServer.emit('atualizar_interface'); res.json({ sucesso: true });
    } catch (erro) {
        console.error(`❌ PUT /api/estrategia/${req.params.id} falhou:`, erro.message);
        res.status(500).json({ sucesso: false });
    }
});

app.delete("/api/estrategia/:id", async (req, res) => {
    try {
        const mesaId = mesaIdRuntimeApi();
        const [existentes] = await dbPool.query(
            'SELECT id, nome, is_dinamico FROM estrategias WHERE id=? AND mesa_id=? LIMIT 1',
            [req.params.id, mesaId]
        );

        if (existentes.length === 0) {
            return res.status(404).json({
                sucesso: false,
                erro: 'estrategia_nao_encontrada',
                mensagem: 'Padrão não encontrado.'
            });
        }

        const estrategia = existentes[0];
        const dinamico =
            estrategia.is_dinamico === true
            || estrategia.is_dinamico === 1
            || estrategia.is_dinamico === '1';

        // Padrões IA são propriedade do robô pai.
        // A rota CRUD manual nunca pode removê-los.
        if (dinamico) {
            return res.status(409).json({
                sucesso: false,
                erro: 'padrao_dinamico_gerenciado_pelo_robo',
                mensagem:
                    'Padrões dinâmicos devem ser gerenciados '
                    + 'pelo Robô IA pai.'
            });
        }

        await apagarEstrategiaEDados(
            req.params.id,
            mesaId
        );

        await carregarSistemasParaMemoria();

        ioServer.emit(
            'atualizar_interface'
        );

        console.log(
            `🗑️ PADRÃO MANUAL | ${req.params.id} — `
            + `${estrategia.nome}: excluído pelo painel.`
        );

        return res.json({
            sucesso: true
        });

    } catch (erro) {
        console.error(
            `❌ DELETE /api/estrategia/${req.params.id} falhou:`,
            erro.message
        );

        return res.status(500).json({
            sucesso: false
        });
    }
});

async function apagarEstrategiaEDados(id, mesaId) {
    await dbPool.query(
        'DELETE FROM estrategias WHERE id=? AND mesa_id=?',
        [id, mesaId]
    );

    await dbPool.query(
        'DELETE FROM historico_resultados WHERE estrategia_id=? AND mesa_id=?',
        [id, mesaId]
    );
}

app.get("/api/origens", async (req, res) => {
    try {
        const mesaId =
            mesaIdRuntimeApi();

        const [linhas] =
            await dbPool.query(
                `SELECT *
                 FROM origens
                 WHERE mesa_id=?
                 ORDER BY nome ASC`,
                [mesaId]
            );

        return res.json(
            linhas
        );
    } catch (e) {
        console.error(
            '? GET /api/origens falhou:',
            e.message
        );

        return res
            .status(500)
            .json([]);
    }
});

app.post("/api/nova-origem", async (req, res) => {
    try {
        const mesaId =
            mesaIdRuntimeApi();

        const nome =
            String(
                req.body?.nome || ''
            ).trim();

        if (!nome) {
            return res
                .status(400)
                .json({
                    sucesso: false,
                    erro: 'nome_origem_invalido'
                });
        }

        await dbPool.query(
            `INSERT INTO origens
                (mesa_id, nome)
             VALUES (?, ?)`,
            [
                mesaId,
                nome
            ]
        );

        ioServer.emit(
            'atualizar_interface'
        );

        return res.json({
            sucesso: true
        });
    } catch (e) {
        console.error(
            '? POST /api/nova-origem falhou:',
            e.message
        );

        return res
            .status(500)
            .json({
                sucesso: false
            });
    }
});

app.put("/api/origem/:id", async (req, res) => {
    let conexao = null;
    let transacaoAberta = false;

    try {
        const mesaId =
            mesaIdRuntimeApi();

        const novoNome =
            String(
                req.body?.novoNome || ''
            ).trim();

        if (!novoNome) {
            return res
                .status(400)
                .json({
                    sucesso: false,
                    erro: 'nome_origem_invalido'
                });
        }

        conexao =
            await dbPool.getConnection();

        await conexao.beginTransaction();
        transacaoAberta = true;

        const [origens] =
            await conexao.query(
                `SELECT id, nome
                 FROM origens
                 WHERE id=?
                   AND mesa_id=?
                 LIMIT 1
                 FOR UPDATE`,
                [
                    req.params.id,
                    mesaId
                ]
            );

        if (
            origens.length === 0
        ) {
            await conexao.rollback();
            transacaoAberta = false;

            return res
                .status(404)
                .json({
                    sucesso: false,
                    erro: 'origem_nao_encontrada'
                });
        }

        const nomeAnterior =
            String(
                origens[0].nome || ''
            );

        const [resultadoOrigem] =
            await conexao.query(
                `UPDATE origens
                 SET nome=?
                 WHERE id=?
                   AND mesa_id=?`,
                [
                    novoNome,
                    req.params.id,
                    mesaId
                ]
            );

        if (
            Number(
                resultadoOrigem.affectedRows
            ) !== 1
        ) {
            throw new Error(
                'MC23-B: origem mudou de ownership durante rename'
            );
        }

        await conexao.query(
            `UPDATE estrategias
             SET origem=?
             WHERE origem=?
               AND is_dinamico=false
               AND mesa_id=?`,
            [
                novoNome,
                nomeAnterior,
                mesaId
            ]
        );

        await conexao.commit();
        transacaoAberta = false;

        await carregarSistemasParaMemoria();

        ioServer.emit(
            'atualizar_interface'
        );

        return res.json({
            sucesso: true
        });
    } catch (e) {
        if (
            conexao
            && transacaoAberta
        ) {
            try {
                await conexao.rollback();
            } catch (rollbackError) {
                console.error(
                    '? MC23-B rollback origem:',
                    rollbackError.message
                );
            }
        }

        console.error(
            `? PUT /api/origem/${req.params.id} falhou:`,
            e.message
        );

        return res
            .status(500)
            .json({
                sucesso: false
            });
    } finally {
        if (conexao) {
            conexao.release();
        }
    }
});

app.delete("/api/origem/:id", async (req, res) => {
    try {
        const mesaId =
            mesaIdRuntimeApi();

        const [resultado] =
            await dbPool.query(
                `DELETE FROM origens
                 WHERE id=?
                   AND mesa_id=?`,
                [
                    req.params.id,
                    mesaId
                ]
            );

        if (
            Number(
                resultado.affectedRows
            ) !== 1
        ) {
            return res
                .status(404)
                .json({
                    sucesso: false,
                    erro: 'origem_nao_encontrada'
                });
        }

        ioServer.emit(
            'atualizar_interface'
        );

        return res.json({
            sucesso: true
        });
    } catch (e) {
        console.error(
            `? DELETE /api/origem/${req.params.id} falhou:`,
            e.message
        );

        return res
            .status(500)
            .json({
                sucesso: false
            });
    }
});

app.get("/api/robos", async (req, res) => {
    try {
        const mesaId = mesaIdRuntimeApi();

        const [linhas] = await dbPool.query(
            'SELECT * FROM robos_canais WHERE mesa_id=? ORDER BY id DESC',
            [mesaId]
        );

        const [destinatarios] = await dbPool.query(
            `SELECT d.*
             FROM destinatarios_robo d
             JOIN robos_canais r
               ON r.id=d.robo_id
             WHERE r.mesa_id=?`,
            [mesaId]
        );
        const [countDinamicos] = await dbPool.query(`SELECT robo_dono_id, COUNT(id) AS qtd_total, SUM(ativo = true) AS qtd_ativos, SUM(ativo = false AND (ia_status='RESERVA' OR (ia_status IS NULL AND quarentena_restante=0))) AS qtd_reserva, SUM(ativo = false AND ia_status='SHADOW_HISTORICO') AS qtd_shadow_historico, SUM(ativo = false AND ia_status='SHADOW_LIVE') AS qtd_shadow_live, SUM(ativo = false AND (ia_status LIKE 'SHADOW_%' OR (ia_status IS NULL AND quarentena_restante>0))) AS qtd_sombra FROM estrategias WHERE mesa_id=? AND is_dinamico = true GROUP BY robo_dono_id`, [mesaId]);

        // UX-002/003: estatísticas cronológicas dos robôs para os cards e máximas de sequência.
        const [historicoRobos] = await dbPool.query(`
            SELECT
                id, robo_id, tipo_resultado, nivel, multiplicador,
                data_hora >= DATE_SUB(NOW(), INTERVAL 24 HOUR) AS is_24h,
                DATE(data_hora) = CURDATE() AS is_hoje,
                YEARWEEK(data_hora, 0) = YEARWEEK(CURDATE(), 0) AS is_semana,
                YEAR(data_hora) = YEAR(CURDATE()) AND MONTH(data_hora) = MONTH(CURDATE()) AS is_mes
            FROM historico_disparos_robos
            WHERE mesa_id=?
            ORDER BY robo_id ASC, data_hora ASC, id ASC
        `, [mesaId]);

        let mapRobos = {};
        let sequenciasRobos = {};
        const createEmptyPeriod = () => ({
            green_direto: 0,
            gale1: 0,
            gale2: 0,
            red: 0,
            ties: { direto:{}, gale1:{}, gale2:{} },
            max_green_seq: 0,
            max_red_seq: 0
        });
        const createEmptyStats = () => ({
            '24h': createEmptyPeriod(),
            hoje: createEmptyPeriod(),
            semana: createEmptyPeriod(),
            mes: createEmptyPeriod(),
            geral: createEmptyPeriod()
        });
        const createEmptyStreaks = () => ({
            '24h': { green: 0, red: 0 },
            hoje: { green: 0, red: 0 },
            semana: { green: 0, red: 0 },
            mes: { green: 0, red: 0 },
            geral: { green: 0, red: 0 }
        });

        linhas.forEach(r => {
            mapRobos[r.id] = createEmptyStats();
            sequenciasRobos[r.id] = createEmptyStreaks();
        });

        historicoRobos.forEach(row => {
            let rid = row.robo_id;
            if (!mapRobos[rid] || !sequenciasRobos[rid]) return;

            let levelKey = 'green_direto';
            let tieLevelKey = 'direto';
            if (row.nivel === 'GALE1') { levelKey = 'gale1'; tieLevelKey = 'gale1'; }
            if (row.nivel === 'GALE2') { levelKey = 'gale2'; tieLevelKey = 'gale2'; }

            const addStat = (period) => {
                const stats = mapRobos[rid][period];
                const streak = sequenciasRobos[rid][period];

                if (row.tipo_resultado === 'GREEN') {
                    stats[levelKey]++;
                } else if (row.tipo_resultado === 'RED') {
                    stats.red++;
                } else if (row.tipo_resultado === 'TIE') {
                    let m = row.multiplicador || '4x';
                    if (!stats.ties[tieLevelKey][m]) stats.ties[tieLevelKey][m] = 0;
                    stats.ties[tieLevelKey][m]++;
                }

                if (row.tipo_resultado === 'GREEN' || row.tipo_resultado === 'TIE') {
                    streak.green++;
                    streak.red = 0;
                    stats.max_green_seq = Math.max(stats.max_green_seq, streak.green);
                } else if (row.tipo_resultado === 'RED') {
                    streak.red++;
                    streak.green = 0;
                    stats.max_red_seq = Math.max(stats.max_red_seq, streak.red);
                } else {
                    streak.green = 0;
                    streak.red = 0;
                }
            };

            if (row.is_24h) addStat('24h');
            if (row.is_hoje) addStat('hoje');
            if (row.is_semana) addStat('semana');
            if (row.is_mes) addStat('mes');
            addStat('geral');
        });

        let robosSanitizados = linhas.map(r => {
            let confObj = { origens: [], avulsos: [], excecoes: [], mostrar_nome: true, mostrar_padrao: true, mostrar_assertividade: true, detalhar_empates: true, cabecalho: '', rodape: '', auto_tuning: { ativo: false }, cooldown: { ativo: false } };
            try { if (r.config_json) confObj = { ...confObj, ...JSON.parse(r.config_json) }; } catch(err){}
            let meusDestinatarios = destinatarios.filter(d => d.robo_id === r.id);
            let contagemIA = countDinamicos.find(d => d.robo_dono_id === r.id);
            let cState = estadoStandbyRobos[r.id];
            const { telegram_token: telegramTokenPrivado, ...roboPublico } = r;
            return {
                ...roboPublico,
                telegram_configurado: Boolean(String(telegramTokenPrivado || '').trim()),
                config: confObj,
                destinatarios: meusDestinatarios,
                qtd_padroes_ia: contagemIA ? Number(contagemIA.qtd_ativos || 0) : 0,
                qtd_padroes_ia_ativos: contagemIA ? Number(contagemIA.qtd_ativos || 0) : 0,
                qtd_padroes_ia_reserva: contagemIA ? Number(contagemIA.qtd_reserva || 0) : 0,
                qtd_padroes_ia_sombra: contagemIA ? Number(contagemIA.qtd_sombra || 0) : 0,
                qtd_padroes_ia_shadow_historico: contagemIA ? Number(contagemIA.qtd_shadow_historico || 0) : 0,
                qtd_padroes_ia_shadow_live: contagemIA ? Number(contagemIA.qtd_shadow_live || 0) : 0,
                qtd_padroes_ia_total: contagemIA ? Number(contagemIA.qtd_total || 0) : 0,
                detalhes: mapRobos[r.id],
                em_standby_ate: cState ? cState.em_standby_ate : 0
            };
        });

        res.json(robosSanitizados);
    } catch(e) { console.error('❌ GET /api/robos falhou:', e.message); res.status(500).json([]); }
});

app.post("/api/robo", async (req, res) => {
    try {
        const mesaId = mesaIdRuntimeApi();
        const { nome, tag, cor, telegram_token, telegram_chat_id, enviar_telegram, enviar_web, min_assert, stop_reds, ativo, config, destinatarios } = req.body;
        const configJson = JSON.stringify(config || {});
        const tokenNormalizado = typeof telegram_token === 'string' ? telegram_token.trim() : '';
        const chatPrincipal = typeof telegram_chat_id === 'string' ? telegram_chat_id.trim() : '';
        const [result] = await dbPool.query(
            `INSERT INTO robos_canais
                (mesa_id, nome, tag_visual, cor_hex, telegram_token,
                 telegram_chat_id, enviar_telegram, enviar_web,
                 min_assertividade, stop_reds_seguidos,
                 greens_consecutivos, ativo, config_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
            [
                mesaId, nome, tag, cor, tokenNormalizado,
                chatPrincipal, enviar_telegram ? 1 : 0,
                enviar_web ? 1 : 0, min_assert, stop_reds,
                ativo ? 1 : 0, configJson
            ]
        );
        let roboId = result.insertId;
        if (destinatarios && Array.isArray(destinatarios)) { for (let d of destinatarios) { if (d.chat_id && d.chat_id.trim() !== '') await dbPool.query('INSERT INTO destinatarios_robo (robo_id, nome_cliente, chat_id) VALUES (?, ?, ?)', [roboId, d.nome_cliente || 'Cliente', d.chat_id.trim()]); } }
        await carregarSistemasParaMemoria();
        autoPilotIA.resetarContador(roboId);
        try {
            await autoPilotIA.executarRobo(roboId, { forcar: true, motivo: 'config_criacao' });
        } catch (e) {
            console.error(`⚠️ Robô ${roboId}: mineração IA inicial falhou, configuração foi preservada:`, e.message);
        }
        ioServer.emit('atualizar_robos');
        res.json({ sucesso: true });
    } catch(e) { console.error('❌ POST /api/robo falhou:', e.message); res.status(500).json({ sucesso: false }); }
});

app.put("/api/robo/:id", async (req, res) => {
    try {
        const mesaId = mesaIdRuntimeApi();
        const { id } = req.params;
        const {
            nome, tag, cor, telegram_token, telegram_chat_id,
            enviar_telegram, enviar_web, min_assert, stop_reds,
            ativo, config, destinatarios
        } = req.body;

        const configJson = JSON.stringify(config || {});
        const tokenRecebido = typeof telegram_token === 'string' ? telegram_token.trim() : '';
        const chatPrincipal = typeof telegram_chat_id === 'string' ? telegram_chat_id.trim() : '';
        const novoAtivo = ativo === true || ativo === 1;
        const stopNovo = Math.max(0, Math.trunc(Number(stop_reds) || 0));

        const [existentes] = await dbPool.query(
            'SELECT ativo, stop_reds_seguidos FROM robos_canais WHERE id=? AND mesa_id=? LIMIT 1',
            [id, mesaId]
        );

        if (existentes.length === 0) {
            return res.status(404).json({ sucesso: false, erro: 'robo_nao_encontrado' });
        }

        const estavaAtivo = existentes[0].ativo === true || existentes[0].ativo === 1;
        const reativando = !estavaAtivo && novoAtivo;
        const stopAnterior = Math.max(
            0,
            Math.trunc(Number(existentes[0].stop_reds_seguidos) || 0)
        );
        const stopMudou = stopAnterior !== stopNovo;

        if (reativando || stopMudou) {
            await dbPool.query(
                `UPDATE robos_canais
                 SET nome=?, tag_visual=?, cor_hex=?,
                     telegram_token=COALESCE(NULLIF(?, ''), telegram_token),
                     telegram_chat_id=?, enviar_telegram=?, enviar_web=?,
                     min_assertividade=?, stop_reds_seguidos=?, ativo=?,
                     config_json=?, reds_consecutivos=0
                 WHERE id=? AND mesa_id=?`,
                [
                    nome, tag, cor, tokenRecebido, chatPrincipal,
                    enviar_telegram ? 1 : 0, enviar_web ? 1 : 0,
                    min_assert, stopNovo, novoAtivo ? 1 : 0,
                    configJson, id, mesaId
                ]
            );
        } else {
            await dbPool.query(
                `UPDATE robos_canais
                 SET nome=?, tag_visual=?, cor_hex=?,
                     telegram_token=COALESCE(NULLIF(?, ''), telegram_token),
                     telegram_chat_id=?, enviar_telegram=?, enviar_web=?,
                     min_assertividade=?, stop_reds_seguidos=?, ativo=?,
                     config_json=?
                 WHERE id=? AND mesa_id=?`,
                [
                    nome, tag, cor, tokenRecebido, chatPrincipal,
                    enviar_telegram ? 1 : 0, enviar_web ? 1 : 0,
                    min_assert, stopNovo, novoAtivo ? 1 : 0,
                    configJson, id, mesaId
                ]
            );
        }

        await dbPool.query('DELETE FROM destinatarios_robo WHERE robo_id = ?', [id]);
        if (destinatarios && Array.isArray(destinatarios)) {
            for (let d of destinatarios) {
                if (d.chat_id && d.chat_id.trim() !== '') {
                    await dbPool.query(
                        'INSERT INTO destinatarios_robo (robo_id, nome_cliente, chat_id) VALUES (?, ?, ?)',
                        [id, d.nome_cliente || 'Cliente', d.chat_id.trim()]
                    );
                }
            }
        }

        await carregarSistemasParaMemoria();
        autoPilotIA.resetarContador(id);
        try {
            await autoPilotIA.executarRobo(id, { forcar: true, motivo: 'config_edicao' });
        } catch (e) {
            console.error(`⚠️ Robô ${id}: remineração IA após edição falhou, configuração foi preservada:`, e.message);
        }

        if (reativando) {
            const [contagemReativada] =
                await dbPool.query(
                    `SELECT COUNT(*) AS qtd
                     FROM estrategias
                     WHERE mesa_id=?
                       AND is_dinamico=true
                       AND robo_dono_id=?
                       AND ativo=true`,
                    [mesaId, id]
                );

            const qtdAtivos = Math.max(
                0,
                Number(
                    contagemReativada?.[0]?.qtd
                ) || 0
            );

            console.log(
                `🤖 Robô/Canal ${id} — ${nome}: reativado; `
                + `${qtdAtivos} padrão(ões) dinâmico(s) ativo(s) liberado(s).`
            );
        }

        ioServer.emit('atualizar_robos');
        res.json({
            sucesso: true,
            stop_reds_resetado: reativando || stopMudou
        });
    } catch(e) {
        console.error(`❌ PUT /api/robo/${req.params.id} falhou:`, e.message);
        res.status(500).json({ sucesso: false });
    }
});

app.post("/api/robo/:id/testar-telegram", async (req, res) => {
    const roboId = Number(req.params.id);
    if (!Number.isInteger(roboId) || roboId <= 0) {
        return res.status(400).json({ sucesso: false, erro: 'robo_id_invalido' });
    }

    try {
        const mesaId = mesaIdRuntimeApi();

        const [robos] = await dbPool.query(
            `SELECT id, nome, telegram_token, telegram_chat_id
             FROM robos_canais
             WHERE id=? AND mesa_id=?
             LIMIT 1`,
            [roboId, mesaId]
        );
        if (robos.length === 0) {
            return res.status(404).json({ sucesso: false, erro: 'robo_nao_encontrado' });
        }

        const robo = robos[0];
        const token = String(robo.telegram_token || '').trim();
        if (!token) {
            return res.status(422).json({ sucesso: false, erro: 'telegram_token_ausente' });
        }

        const [destinatarios] = await dbPool.query(
            'SELECT nome_cliente, chat_id FROM destinatarios_robo WHERE robo_id=? ORDER BY id ASC',
            [roboId]
        );
        const destinos = destinosTelegramRobo({ ...robo, destinatarios });
        if (destinos.length === 0) {
            return res.status(422).json({ sucesso: false, erro: 'telegram_destino_ausente' });
        }

        const mensagem = [
            '━━━━━━━━━━━━━━━━━━━━',
            '🔔 TESTE DE CONEXÃO',
            '━━━━━━━━━━━━━━━━━━━━',
            `🤖 Robô: ${String(robo.nome || `#${roboId}`).trim()}`,
            '✅ O bot está conectado e apto a enviar sinais para este destino.',
            '━━━━━━━━━━━━━━━━━━━━'
        ].join('\n');

        const resultados = await Promise.all(
            destinos.map(chatId => enviarMensagemTelegram(token, chatId, mensagem))
        );
        const detalhes = resultados.map((resultado, indice) => ({
            destino: mascararChatIdTelegram(destinos[indice]),
            sucesso: resultadoTelegramOk(resultado),
            erro: resultadoTelegramOk(resultado) ? null : resultado.descricao,
            codigo: resultadoTelegramOk(resultado) ? null : resultado.error_code
        }));
        const entregues = detalhes.filter(item => item.sucesso).length;

        detalhes.filter(item => !item.sucesso).forEach(item => {
            console.warn(
                `⚠️ Robô ${roboId}: teste Telegram falhou para chat ${item.destino} — ${item.erro}`
                + `${item.codigo ? ` (código ${item.codigo})` : ''}.`
            );
        });
        console.log(`📨 Robô ${roboId}: teste Telegram confirmado em ${entregues}/${destinos.length} destino(s).`);

        return res.status(entregues > 0 ? 200 : 422).json({
            sucesso: entregues === destinos.length,
            entregues,
            total: destinos.length,
            detalhes
        });
    } catch (e) {
        console.error(`❌ POST /api/robo/${roboId}/testar-telegram falhou:`, e.message);
        return res.status(500).json({ sucesso: false, erro: 'falha_interna' });
    }
});

app.delete("/api/robo/:id", async (req, res) => {
    const roboId = Number(req.params.id);
    if (!Number.isInteger(roboId) || roboId <= 0) {
        return res.status(400).json({ sucesso: false, erro: 'robo_id_invalido' });
    }

    let conexao = null;
    let padroesIaExcluidos = 0;

    try {
        const mesaRuntime = obterMesaRuntime();
        const mesaId = Number(mesaRuntime.id);

        if (!Number.isInteger(mesaId) || mesaId <= 0) {
            throw new Error(
                'MC22-V-B: mesa runtime invalida ao excluir Robo/Canal'
            );
        }

        conexao = await dbPool.getConnection();
        await conexao.beginTransaction();

        const [robos] = await conexao.query(
            'SELECT id FROM robos_canais WHERE id=? AND mesa_id=? FOR UPDATE',
            [roboId, mesaId]
        );
        if (robos.length === 0) {
            await conexao.rollback();
            return res.status(404).json({ sucesso: false, erro: 'robo_nao_encontrado' });
        }

        const [padroesIa] = await conexao.query(
            `SELECT id
             FROM estrategias
             WHERE mesa_id=?
               AND is_dinamico=true
               AND robo_dono_id=?
             FOR UPDATE`,
            [mesaId, roboId]
        );
        const idsPadroes = padroesIa.map(row => String(row.id));

        if (idsPadroes.length > 0) {
            const placeholders = idsPadroes.map(() => '?').join(',');
            await conexao.query(
                `DELETE FROM historico_resultados
                 WHERE mesa_id=?
                   AND estrategia_id IN (${placeholders})`,
                [mesaId, ...idsPadroes]
            );
            await conexao.query(
                `DELETE FROM historico_disparos_robos
                 WHERE mesa_id=?
                   AND estrategia_id IN (${placeholders})`,
                [mesaId, ...idsPadroes]
            );
            const [resultadoPadroes] = await conexao.query(
                `DELETE FROM estrategias
                 WHERE mesa_id=?
                   AND is_dinamico=true
                   AND robo_dono_id=?`,
                [mesaId, roboId]
            );
            padroesIaExcluidos = Math.max(0, Number(resultadoPadroes.affectedRows) || 0);
        }

        // O histórico live de padrões expirados é preservado enquanto o robô existir.
        // Na exclusão definitiva do proprietário, remove também IDs IA já arquivados pelo TTL.
        const prefixoHistoricoIa = `ia_${roboId}_`;
        await conexao.query(
            `DELETE FROM historico_resultados
             WHERE mesa_id=?
               AND LEFT(estrategia_id, ?) = ?`,
            [mesaId, prefixoHistoricoIa.length, prefixoHistoricoIa]
        );

        // Ao excluir o Robô/Canal, seu histórico de distribuição também deixa de ter proprietário.
        await conexao.query(
            'DELETE FROM historico_shadow_ia WHERE mesa_id=? AND robo_id=?',
            [mesaId, roboId]
        );
        await conexao.query(
            'DELETE FROM historico_disparos_robos WHERE mesa_id=? AND robo_id=?',
            [mesaId, roboId]
        );
        await conexao.query('DELETE FROM destinatarios_robo WHERE robo_id=?', [roboId]);
        const [resultadoRobo] = await conexao.query(
            'DELETE FROM robos_canais WHERE id=? AND mesa_id=?',
            [roboId, mesaId]
        );

        if (Number(resultadoRobo.affectedRows) !== 1) {
            throw new Error(
                `MC22-V-B: Robo/Canal ${roboId} deixou de pertencer ` +
                `a mesa ${mesaRuntime.codigo} durante a exclusao`
            );
        }

        await conexao.commit();
    } catch (e) {
        try { await conexao.rollback(); } catch (rollbackError) {
            console.error(`❌ Rollback falhou ao excluir Robô/Canal ${roboId}:`, rollbackError.message);
        }
        console.error(`❌ DELETE /api/robo/${roboId} falhou:`, e.message);
        return res.status(500).json({ sucesso: false });
    } finally {
        if (conexao) conexao.release();
    }

    delete estadoStandbyRobos[roboId];

    try {
        await carregarSistemasParaMemoria();
        ioServer.emit('atualizar_robos');
        ioServer.emit('atualizar_interface');
        console.log(`🗑️ Robô/Canal ${roboId} excluído com ${padroesIaExcluidos} padrão(ões) IA filho(s).`);
        return res.json({ sucesso: true, padroes_ia_excluidos: padroesIaExcluidos });
    } catch (e) {
        console.error(`❌ Robô/Canal ${roboId} foi excluído no banco, mas a recarga de memória falhou:`, e.message);
        return res.status(500).json({
            sucesso: false,
            erro: 'robo_excluido_recarga_memoria_falhou',
            padroes_ia_excluidos: padroesIaExcluidos
        });
    }
});

app.get("/api/auto-traders", async (req, res) => {
    try {
        const mesaId = mesaIdRuntimeApi();

        const [linhas] = await dbPool.query(
            'SELECT * FROM auto_traders WHERE mesa_id=? ORDER BY id DESC',
            [mesaId]
        );
        let sanitizados = linhas.map(at => {
            let confObj = {}; try { confObj = JSON.parse(at.config_json); } catch(e) {}
            confObj = normalizarConfigAutoTrader(confObj);
            const estadoCiclo = normalizarEstadoCiclo(at);
            return {
                id: at.id,
                nome: at.nome,
                ativo: at.ativo === 1,
                config: confObj,
                saldo_inicial: parseFloat(at.saldo_inicial),
                saldo_atual: parseFloat(at.saldo_atual),
                status_operacao: at.status_operacao,
                entradas_feitas: at.entradas_feitas,
                pulos_restantes: estadoCiclo.pulos_restantes,
                estado_ciclo: estadoCiclo.estado_ciclo,
                reds_virtuais_observados: estadoCiclo.reds_virtuais_observados,
                sinais_operados_onda: estadoCiclo.sinais_operados_onda,
                ciclos_concluidos: estadoCiclo.ciclos_concluidos,
                data_contador_entradas: String(at.data_contador_entradas || ''),
                reds_consecutivos: Math.max(0, Number(at.reds_consecutivos) || 0),
                stop_reds_pausado_ate: Math.max(0, Number(at.stop_reds_pausado_ate) || 0),
                trailing_pico_lucro: Math.max(0, Number(at.trailing_pico_lucro) || 0)
            };
        });
        res.json(sanitizados);
    } catch (e) { console.error('❌ GET /api/auto-traders falhou:', e.message); res.status(500).json([]); }
});

app.post("/api/auto-trader", async (req, res) => {
    try {
        const mesaId = mesaIdRuntimeApi();
        const { nome, ativo, config } = req.body;
        const configNormalizada = normalizarConfigAutoTrader(config || {});
        const configJson = JSON.stringify(configNormalizada);
        const novoAtivo = ativo === true || ativo === 1;
        if (novoAtivo) {
            const politicaEmpate = validarPoliticaProtecao(configNormalizada);
            if (!politicaEmpate.ok) {
                return res.status(400).json({ sucesso: false, erro: 'protecao_empate_invalida', mensagem: politicaEmpate.motivo });
            }
        }
        let saldoBaseline = 0;
        let saldoSincronizadoAgora = false;

        if (novoAtivo) {
            const gateSaldo =
                await obterSaldoAutoTraderParaAtivacao();

            if (!gateSaldo.ok) {
                return res.status(409).json({
                    sucesso: false,
                    erro: 'saldo_global_indisponivel',
                    mensagem:
                        'Não foi possível confirmar um saldo real recente. '
                        + 'O Auto-Trader permaneceu desligado.',
                    detalhe: gateSaldo.erro
                });
            }

            saldoBaseline = gateSaldo.saldo;
            saldoSincronizadoAgora =
                gateSaldo.sincronizado_agora;
        }

        const statusInicial =
            novoAtivo
                ? 'STANDBY'
                : 'DESLIGADO';
        const dataContadorEntradas = controleDiarioAutoTrader.dataOperacional();
        const estadoCiclo = estadoInicialCiclo();
        await dbPool.query(
            `INSERT INTO auto_traders
                (mesa_id, nome, ativo, config_json,
                 saldo_inicial, saldo_atual, status_operacao,
                 entradas_feitas, pulos_restantes,
                 estado_ciclo, reds_virtuais_observados,
                 sinais_operados_onda, ciclos_concluidos,
                 data_contador_entradas)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
            [
                mesaId,
                nome,
                novoAtivo ? 1 : 0,
                configJson,
                saldoBaseline,
                saldoBaseline,
                statusInicial,
                estadoCiclo.pulos_restantes,
                estadoCiclo.estado_ciclo,
                estadoCiclo.reds_virtuais_observados,
                estadoCiclo.sinais_operados_onda,
                estadoCiclo.ciclos_concluidos,
                dataContadorEntradas
            ]
        );
        await carregarSistemasParaMemoria();
        res.json({
            sucesso: true,
            saldo_inicial: saldoBaseline,
            saldo_sincronizado_agora: saldoSincronizadoAgora
        });
    } catch (e) {
        console.error('❌ POST /api/auto-trader falhou:', e.message);

        if (
            e
            && e.code === 'BUG051D_CONFIG_INVALIDA'
        ) {
            return res.status(400).json({
                sucesso: false,
                erro: 'configuracao_auto_trader_invalida',
                campo: e.campo_configuracao || null,
                mensagem: String(
                    e.message ||
                    'Configuração Auto-Trader inválida'
                ).replace(
                    /^Configuração Auto-Trader rejeitada:\s*/,
                    ''
                )
            });
        }

        res.status(500).json({
            sucesso: false
        });
    }
});

app.put("/api/auto-trader/:id", async (req, res) => {
    try {
        const mesaId = mesaIdRuntimeApi();
        const { id } = req.params;
        const { nome, ativo, config } = req.body;
        const configNova = normalizarConfigAutoTrader(config || {});
        const configJson = JSON.stringify(configNova);
        const novoAtivo = ativo === true || ativo === 1;
        if (novoAtivo) {
            const politicaEmpate = validarPoliticaProtecao(configNova);
            if (!politicaEmpate.ok) {
                return res.status(400).json({ sucesso: false, erro: 'protecao_empate_invalida', mensagem: politicaEmpate.motivo });
            }
        }

        const [existentes] = await dbPool.query(
            'SELECT ativo, config_json, status_operacao FROM auto_traders WHERE id=? AND mesa_id=? LIMIT 1',
            [id, mesaId]
        );
        if (existentes.length === 0) {
            return res.status(404).json({ sucesso: false, erro: 'auto_trader_nao_encontrado' });
        }

        let configAnterior = {};
        try { configAnterior = JSON.parse(existentes[0].config_json || '{}'); } catch(e) {}
        configAnterior = normalizarConfigAutoTrader(configAnterior);
        const trailingAnteriorAtivo = configAnterior.trailing_stop === true;
        const trailingNovoAtivo = configNova.trailing_stop === true;
        const trailingAnteriorRecuo = Math.max(0, Number(configAnterior.trailing_recuo) || 0);
        const trailingNovoRecuo = Math.max(0, Number(configNova.trailing_recuo) || 0);
        const cicloConfigMudou = configuracaoCicloMudou(configAnterior, configNova);
        const trailingConfigMudou =
            trailingAnteriorAtivo !== trailingNovoAtivo
            || trailingAnteriorRecuo !== trailingNovoRecuo;

        const estavaAtivo = existentes[0].ativo === true || existentes[0].ativo === 1;
        const reativando = !estavaAtivo && novoAtivo;
        const desligando = estavaAtivo && !novoAtivo;
        let saldoSincronizadoAgora = false;

        if (reativando) {
            const gateSaldo =
                await obterSaldoAutoTraderParaAtivacao();

            if (!gateSaldo.ok) {
                return res.status(409).json({
                    sucesso: false,
                    erro: 'saldo_global_indisponivel',
                    mensagem:
                        'Não foi possível confirmar um saldo real recente. '
                        + 'O Auto-Trader permaneceu desligado.',
                    detalhe: gateSaldo.erro
                });
            }

            const saldoFresco = gateSaldo.saldo;
            saldoSincronizadoAgora =
                gateSaldo.sincronizado_agora;

            const estadoCiclo = estadoInicialCiclo();
            await dbPool.query(
                `UPDATE auto_traders
                 SET nome=?, ativo=true, config_json=?, saldo_inicial=?, saldo_atual=?,
                     status_operacao='STANDBY',
                     reds_consecutivos=0, stop_reds_pausado_ate=0, trailing_pico_lucro=0,
                     estado_ciclo=?, reds_virtuais_observados=?, sinais_operados_onda=?,
                     ciclos_concluidos=?, pulos_restantes=?
                 WHERE id=? AND mesa_id=?`,
                [
                    nome, configJson, saldoFresco, saldoFresco, estadoCiclo.estado_ciclo,
                    estadoCiclo.reds_virtuais_observados, estadoCiclo.sinais_operados_onda,
                    estadoCiclo.ciclos_concluidos, estadoCiclo.pulos_restantes, id, mesaId
                ]
            );
        } else if (desligando) {
            if (trailingConfigMudou) {
                await dbPool.query(
                    `UPDATE auto_traders
                     SET nome=?, ativo=false, config_json=?,
                         status_operacao='DESLIGADO', trailing_pico_lucro=0
                     WHERE id=? AND mesa_id=?`,
                    [nome, configJson, id, mesaId]
                );
            } else {
                await dbPool.query(
                    `UPDATE auto_traders
                     SET nome=?, ativo=false, config_json=?, status_operacao='DESLIGADO'
                     WHERE id=? AND mesa_id=?`,
                    [nome, configJson, id, mesaId]
                );
            }
        } else if (cicloConfigMudou) {
            const estadoCiclo = estadoInicialCiclo();
            if (trailingConfigMudou) {
                await dbPool.query(
                    `UPDATE auto_traders
                     SET nome=?, ativo=?, config_json=?, trailing_pico_lucro=0,
                         estado_ciclo=?, reds_virtuais_observados=?, sinais_operados_onda=?,
                         ciclos_concluidos=?, pulos_restantes=?
                     WHERE id=? AND mesa_id=?`,
                    [
                        nome, novoAtivo ? 1 : 0, configJson, estadoCiclo.estado_ciclo,
                        estadoCiclo.reds_virtuais_observados, estadoCiclo.sinais_operados_onda,
                        estadoCiclo.ciclos_concluidos, estadoCiclo.pulos_restantes, id, mesaId
                    ]
                );
            } else {
                await dbPool.query(
                    `UPDATE auto_traders
                     SET nome=?, ativo=?, config_json=?, estado_ciclo=?, reds_virtuais_observados=?,
                         sinais_operados_onda=?, ciclos_concluidos=?, pulos_restantes=?
                     WHERE id=? AND mesa_id=?`,
                    [
                        nome, novoAtivo ? 1 : 0, configJson, estadoCiclo.estado_ciclo,
                        estadoCiclo.reds_virtuais_observados, estadoCiclo.sinais_operados_onda,
                        estadoCiclo.ciclos_concluidos, estadoCiclo.pulos_restantes, id, mesaId
                    ]
                );
            }
        } else {
            if (trailingConfigMudou) {
                await dbPool.query(
                    'UPDATE auto_traders SET nome=?, ativo=?, config_json=?, trailing_pico_lucro=0 WHERE id=? AND mesa_id=?',
                    [nome, novoAtivo ? 1 : 0, configJson, id, mesaId]
                );
            } else {
                await dbPool.query(
                    'UPDATE auto_traders SET nome=?, ativo=?, config_json=? WHERE id=? AND mesa_id=?',
                    [nome, novoAtivo ? 1 : 0, configJson, id, mesaId]
                );
            }
        }

        await carregarSistemasParaMemoria();
        res.json({
            sucesso: true,
            baseline_recapturado: reativando,
            ciclo_resetado: reativando || cicloConfigMudou,
            saldo_sincronizado_agora: saldoSincronizadoAgora
        });
    } catch (e) {
        console.error(
            `❌ PUT /api/auto-trader/${req.params.id} falhou:`,
            e.message
        );

        if (
            e
            && e.code === 'BUG051D_CONFIG_INVALIDA'
        ) {
            return res.status(400).json({
                sucesso: false,
                erro: 'configuracao_auto_trader_invalida',
                campo: e.campo_configuracao || null,
                mensagem: String(
                    e.message ||
                    'Configuração Auto-Trader inválida'
                ).replace(
                    /^Configuração Auto-Trader rejeitada:\s*/,
                    ''
                )
            });
        }

        res.status(500).json({
            sucesso: false
        });
    }
});

app.delete("/api/auto-trader/:id", async (req, res) => {
    try {
        const mesaId = mesaIdRuntimeApi();

        const [resultado] = await dbPool.query(
            'DELETE FROM auto_traders WHERE id=? AND mesa_id=?',
            [req.params.id, mesaId]
        );

        if (Number(resultado.affectedRows) !== 1) {
            return res.status(404).json({
                sucesso: false,
                erro: 'auto_trader_nao_encontrado'
            });
        }

        await carregarSistemasParaMemoria();

        return res.json({
            sucesso: true
        });
    } catch (e) {
        console.error(
            `DELETE /api/auto-trader/${req.params.id} falhou:`,
            e.message
        );

        return res.status(500).json({
            sucesso: false
        });
    }
});

app.get("/api/auditoria-ordens/:trader_id", async (req, res) => {
    try {
        const mesaId = mesaIdRuntimeApi();

        const [ordens] = await dbPool.query(
            `SELECT *
             FROM auditoria_ordens
             WHERE trader_id=?
               AND mesa_id=?
             ORDER BY id DESC
             LIMIT 500`,
            [
                req.params.trader_id,
                mesaId
            ]
        );

        return res.json(ordens);
    } catch (e) {
        console.error(
            `GET /api/auditoria-ordens/${req.params.trader_id} falhou:`,
            e.message
        );

        return res.status(500).json([]);
    }
});

// ==========================================
// 7. MEMÓRIA E WEBHOOK TITÃ (COM LOGS COMPLETOS)
// ==========================================

async function ativarAutoTradersAguardandoMesa() {
    const mesaRuntime = obterMesaRuntime();
    const mesaId = Number(mesaRuntime.id);

    const aguardandoMesa = AUTO_TRADERS_MEMORIA.filter(
        trader => trader.ativo && trader.status_operacao === 'STANDBY'
    );

    if (aguardandoMesa.length === 0) return;

    const ids = aguardandoMesa.map(trader => trader.id);
    const placeholders = ids.map(() => '?').join(',');

    for (const trader of aguardandoMesa) {
        if (Number(trader.mesa_id) !== mesaId) {
            throw new Error(
                `MC22-X: Trader ${trader.id} fora da mesa runtime na ativacao`
            );
        }
    }

    const [resultadoAtivacao] = await dbPool.query(
        `UPDATE auto_traders
         SET status_operacao='OPERANDO'
         WHERE mesa_id=?
           AND ativo=true
           AND status_operacao='STANDBY'
           AND id IN (${placeholders})`,
        [mesaId, ...ids]
    );

    if (
        Number(resultadoAtivacao.affectedRows)
        !== ids.length
    ) {
        throw new Error(
            'MC22-X: ativacao STANDBY incompleta na mesa runtime'
        );
    }

    aguardandoMesa.forEach(trader => {
        trader.status_operacao = 'OPERANDO';
    });

    console.log(`🟢 ${aguardandoMesa.length} Auto-Trader(s) sincronizado(s) com a mesa e liberado(s) para OPERANDO.`);
}

function avaliarContinuidadeResultado(estadoAnterior, dados) {
    const anterior = estadoAnterior || {};
    const atual = dados || {};

    const sessaoAnterior = String(anterior.sessao || '').trim();
    const seqAnteriorNumero = Number(anterior.seq);
    const seqAnterior = Number.isSafeInteger(seqAnteriorNumero) && seqAnteriorNumero > 0 ? seqAnteriorNumero : null;
    const timestampAnteriorNumero = Number(anterior.timestamp_coleta);
    const timestampAnterior = Number.isFinite(timestampAnteriorNumero) && timestampAnteriorNumero > 0 ? Math.trunc(timestampAnteriorNumero) : null;

    const sessaoRecebidaBruta = String(atual.coletor_sessao || '').trim();
    const sessaoRecebida = sessaoRecebidaBruta.length > 0 && sessaoRecebidaBruta.length <= 128 ? sessaoRecebidaBruta : '';
    const seqRecebidaNumero = Number(atual.coletor_seq);
    const seqRecebida = Number.isSafeInteger(seqRecebidaNumero) && seqRecebidaNumero > 0 ? seqRecebidaNumero : null;
    const timestampRecebidoNumero = Number(atual.timestamp_coleta);
    const timestampRecebido = Number.isFinite(timestampRecebidoNumero) && timestampRecebidoNumero > 0 ? Math.trunc(timestampRecebidoNumero) : null;

    const tinhaMetadados = Boolean(sessaoAnterior) && seqAnterior !== null;
    const temMetadados = Boolean(sessaoRecebida) && seqRecebida !== null;

    if (tinhaMetadados && temMetadados && sessaoRecebida === sessaoAnterior && seqRecebida <= seqAnterior) {
        return {
            aceitar: false,
            interrupcao: false,
            buraco_confirmado: false,
            motivo: seqRecebida === seqAnterior ? 'DUPLICADO' : 'FORA_DE_ORDEM',
            estado: { sessao: sessaoAnterior, seq: seqAnterior, timestamp_coleta: timestampAnterior }
        };
    }

    let interrupcao = false;
    let buracoConfirmado = false;
    let motivo = null;

    if (tinhaMetadados) {
        if (!temMetadados) {
            interrupcao = true;
            buracoConfirmado = true;
            motivo = 'METADADOS_COLETOR_AUSENTES';
        } else if (sessaoRecebida !== sessaoAnterior) {
            interrupcao = true;
            buracoConfirmado = true;
            motivo = 'COLETOR_REINICIADO';
        } else if (seqRecebida > seqAnterior + 1) {
            interrupcao = true;
            buracoConfirmado = true;
            motivo = 'SALTO_SEQUENCIA';
        }
    }

    if (!interrupcao && atual.interrupcao_fluxo === true) {
        interrupcao = true;
        motivo = 'INTERRUPCAO_PYTHON';
    }

    return {
        aceitar: true,
        interrupcao,
        buraco_confirmado: buracoConfirmado,
        motivo,
        estado: {
            sessao: temMetadados ? sessaoRecebida : (sessaoAnterior || null),
            seq: temMetadados ? seqRecebida : seqAnterior,
            timestamp_coleta: timestampRecebido !== null ? timestampRecebido : timestampAnterior
        }
    };
}

function rotacionarSessaoAposInterrupcao(dados) {
    if (!dados || dados.interrupcao_fluxo !== true) return false;

    const sessaoAnterior = idSessaoContinua;
    const timestampColeta = Number(dados.timestamp_coleta);
    let novaSessao = Number.isFinite(timestampColeta) && timestampColeta > 0 ? Math.trunc(timestampColeta) : Date.now();

    if (novaSessao === sessaoAnterior) novaSessao++;
    idSessaoContinua = novaSessao;

    const motivo = String(dados.motivo_interrupcao || 'INTERRUPCAO_PYTHON');
    console.log(`🧭 Interrupção de fluxo detectada (${motivo}). Nova sessão contínua: ${sessaoAnterior} -> ${idSessaoContinua}`);
    return true;
}

async function invalidarSequenciasAposBuracoDados(motivo) {
    let sinaisInvalidados = 0;

    for (const [estrategiaId, estado] of Object.entries(estadoApostas)) {
        if (!estado || !estado.aguardandoResultado) continue;

        // A interrupção encerra a escuta anterior e cria uma nova fronteira.
        liberarLocksSinalDoEstado(estrategiaId, estado);

        estado.aguardandoResultado = false;
        estado.galeAtual = 0;
        estado.robosWebInscritos = [];
        estado.robosTelegramInscritos = [];
        estado.robosInscritos = [];
        estado.telegramEntradaPromise = null;
        sinaisInvalidados++;
    }

    const mesaRuntime = obterMesaRuntime();
    const conexao = await dbPool.getConnection();
    let traderIds = [];

    try {
        await conexao.beginTransaction();

        // MC22-S:
        // Mantem a mesma ordem de locks do caminho financeiro:
        // primeiro Auto-Trader, depois auditoria.
        const [tradersMesa] = await conexao.query(
            `SELECT id, mesa_id
             FROM auto_traders
             WHERE mesa_id=?
             ORDER BY id ASC
             FOR UPDATE`,
            [mesaRuntime.id]
        );

        const traderIdsMesa = new Set();

        for (const trader of tradersMesa) {
            const traderId = Number(trader.id);
            const traderMesaId = Number(trader.mesa_id);

            if (
                !Number.isInteger(traderId)
                || traderId <= 0
                || traderMesaId !== Number(mesaRuntime.id)
            ) {
                throw new Error(
                    'MC22-S: Trader invalido na mesa runtime'
                );
            }

            traderIdsMesa.add(traderId);
        }

        // So depois de travar os proprietarios financeiros
        // trava o conjunto PENDENTE da mesa.
        const [ordensPendentes] = await conexao.query(
            `SELECT id, trader_id
             FROM auditoria_ordens
             WHERE mesa_id=?
               AND status_ordem='PENDENTE'
             ORDER BY id ASC
             FOR UPDATE`,
            [mesaRuntime.id]
        );

        const ordemIds = [];
        const traderIdsPorOrdem = [];

        for (const ordem of ordensPendentes) {
            const ordemId = Number(ordem.id);
            const traderId = Number(ordem.trader_id);

            if (
                !Number.isInteger(ordemId)
                || ordemId <= 0
            ) {
                throw new Error(
                    'MC22-S: auditoria PENDENTE com ID invalido'
                );
            }

            if (
                !Number.isInteger(traderId)
                || traderId <= 0
            ) {
                throw new Error(
                    `MC22-S: ordem ${ordemId} sem Trader valido`
                );
            }

            if (!traderIdsMesa.has(traderId)) {
                throw new Error(
                    `MC22-S: Trader ${traderId} da ordem ${ordemId} ` +
                    `nao pertence a mesa ${mesaRuntime.codigo}`
                );
            }

            ordemIds.push(ordemId);
            traderIdsPorOrdem.push(traderId);
        }

        traderIds = [
            ...new Set(traderIdsPorOrdem)
        ];

        if (ordemIds.length > 0) {
            const placeholdersOrdens =
                ordemIds.map(() => '?').join(',');

            const [resultadoOrdens] =
                await conexao.query(
                    `UPDATE auditoria_ordens
                     SET status_ordem='DADOS_INCOMPLETOS'
                     WHERE id IN (${placeholdersOrdens})
                       AND mesa_id=?
                       AND status_ordem='PENDENTE'`,
                    [
                        ...ordemIds,
                        mesaRuntime.id
                    ]
                );

            if (
                Number(resultadoOrdens.affectedRows)
                !== ordemIds.length
            ) {
                throw new Error(
                    `MC22-S: esperadas ${ordemIds.length} ` +
                    `ordens invalidadas; afetadas ` +
                    `${resultadoOrdens.affectedRows}`
                );
            }

            const placeholdersTraders =
                traderIds.map(() => '?').join(',');

            await conexao.query(
                `UPDATE auto_traders
                 SET ativo=false,
                     status_operacao='DADOS_INCOMPLETOS'
                 WHERE mesa_id=?
                   AND id IN (${placeholdersTraders})`,
                [
                    mesaRuntime.id,
                    ...traderIds
                ]
            );

            const [tradersBloqueados] =
                await conexao.query(
                    `SELECT id, mesa_id, ativo, status_operacao
                     FROM auto_traders
                     WHERE mesa_id=?
                       AND id IN (${placeholdersTraders})
                     ORDER BY id ASC
                     FOR UPDATE`,
                    [
                        mesaRuntime.id,
                        ...traderIds
                    ]
                );

            if (
                tradersBloqueados.length
                !== traderIds.length
            ) {
                throw new Error(
                    'MC22-S: conjunto de Traders bloqueados incompleto'
                );
            }

            for (const trader of tradersBloqueados) {
                const mesaCorreta =
                    Number(trader.mesa_id)
                    === Number(mesaRuntime.id);

                const estaDesligado =
                    Number(trader.ativo) === 0;

                const statusCorreto =
                    String(trader.status_operacao)
                    === 'DADOS_INCOMPLETOS';

                if (
                    !mesaCorreta
                    || !estaDesligado
                    || !statusCorreto
                ) {
                    throw new Error(
                        `MC22-S: Trader ${trader.id} nao ficou ` +
                        `bloqueado corretamente na mesa ` +
                        `${mesaRuntime.codigo}`
                    );
                }
            }
        }

        // Segunda barreira fail-closed antes do COMMIT.
        const [pendentesRestantes] =
            await conexao.query(
                `SELECT id
                 FROM auditoria_ordens
                 WHERE mesa_id=?
                   AND status_ordem='PENDENTE'
                 LIMIT 1
                 FOR UPDATE`,
                [mesaRuntime.id]
            );

        if (pendentesRestantes.length > 0) {
            throw new Error(
                `MC22-S: ainda existe ordem PENDENTE na mesa ` +
                `${mesaRuntime.codigo} apos invalidacao`
            );
        }

        await conexao.commit();
    } catch (e) {
        try {
            await conexao.rollback();
        } catch (rollbackError) {
            console.error(
                'Rollback falhou ao tratar buraco de dados:',
                rollbackError.message
            );
        }

        throw e;
    } finally {
        conexao.release();
    }

    if (traderIds.length > 0) {
        const idsBloqueados =
            new Set(traderIds.map(String));

        for (const trader of AUTO_TRADERS_MEMORIA) {
            if (!idsBloqueados.has(String(trader.id))) {
                continue;
            }

            trader.ativo = false;
            trader.status_operacao = 'DADOS_INCOMPLETOS';
        }
    }

    console.warn(`⚠️ Continuidade de dados comprometida (${motivo || 'DESCONHECIDO'}): ${sinaisInvalidados} sinal(is) pendente(s) invalidado(s), ${traderIds.length} Auto-Trader(s) com ordem pendente bloqueado(s).`);
    ioServer.emit('atualizar_interface');
    return { sinais_invalidados: sinaisInvalidados, traders_bloqueados: traderIds.length };
}

function nivelHistoricoResultado(galeAtual) {
    if (galeAtual === 1) return 'GALE1';
    if (galeAtual === 2) return 'GALE2';
    return 'DIRETO';
}

async function registrarHistoricoResultadoEstrategia(est, tipoResultado, galeAtual, multiplicador, timestampColeta) {
    const mesaRuntime = obterMesaRuntime();
    const timestampMs = Number(timestampColeta);
    const timestampSegundos = Number.isFinite(timestampMs) && timestampMs > 0
        ? timestampMs / 1000
        : Date.now() / 1000;

    await dbPool.query(
        `INSERT INTO historico_resultados
            (mesa_id, estrategia_id, tipo_resultado, nivel, multiplicador, data_hora)
         VALUES (?, ?, ?, ?, ?, FROM_UNIXTIME(?))`,
        [
            mesaRuntime.id,
            est.id,
            tipoResultado,
            nivelHistoricoResultado(galeAtual),
            multiplicador || '',
            timestampSegundos
        ]
    );
}

function contarTiesLegados(tiesJson) {
    if (!tiesJson) return 0;

    try {
        const ties = typeof tiesJson === 'string' ? JSON.parse(tiesJson) : tiesJson;
        let total = 0;

        for (const nivel of ['direto', 'gale1', 'gale2']) {
            for (const valor of Object.values((ties && ties[nivel]) || {})) {
                total += Number(valor) || 0;
            }
        }

        return total;
    } catch (e) {
        return 0;
    }
}

function calcularAssertividadeLiveCanonica(est, historicoLiveCanonico) {
    const dadosCanonicos = (Array.isArray(historicoLiveCanonico) ? historicoLiveCanonico : [])
        .map(giro => ({
            resultado: String(giro?.resultado || ''),
            multiplicador: String(giro?.multiplicador || ''),
            id_sessao: String(giro?.id_sessao || 'EVOLUTION_CANONICA'),
            timestamp_ms: Number(giro?.timestamp_ms) || 0
        }));

    if (!est || dadosCanonicos.length === 0) return 0;
    const detalhes = calcularDetalhesPadraoNoHistorico(
        est,
        dadosCanonicos,
        Date.now()
    ).geral;
    const greens = (Number(detalhes.green_direto) || 0)
        + (Number(detalhes.gale1) || 0)
        + (Number(detalhes.gale2) || 0)
        + contarTiesLegados(detalhes.ties);
    const reds = Number(detalhes.red) || 0;
    const total = greens + reds;
    return total > 0 ? (greens / total) * 100 : 0;
}

function roboSintonizaEstrategia(robo, est) {
    const config = robo.config || {};

    if (est.is_dinamico) {
        return Number(est.robo_dono_id) === Number(robo.id);
    }

    const estrategiaId = String(est.id);
    const origem = String(est.origem || '');
    const excecoes = Array.isArray(config.excecoes) ? config.excecoes.map(String) : [];
    const avulsos = Array.isArray(config.avulsos) ? config.avulsos.map(String) : [];
    const origens = Array.isArray(config.origens) ? config.origens.map(String) : [];

    if (excecoes.includes(estrategiaId)) return false;
    if (avulsos.includes(estrategiaId)) return true;
    return origens.includes(origem);
}

function idsRobosSelecionadosAutoTrader(config, robos = []) {
    const fontes = Array.isArray(config && config.fontes_sinal)
        ? config.fontes_sinal.map(fonte => String(fonte || '').trim()).filter(Boolean)
        : [];
    const listaRobos = Array.isArray(robos) ? robos : [];
    const ids = new Set();

    for (const fonte of fontes) {
        let match = /^ROBO:(\d+)$/i.exec(fonte);
        if (match) {
            ids.add(Number(match[1]));
            continue;
        }

        // Migração defensiva de configurações anteriores ao BUG-033.
        match = /^AUTO_PILOT_IA:(\d+)$/i.exec(fonte);
        if (match) {
            ids.add(Number(match[1]));
            continue;
        }
        match = /^\[AUTO\]\s*(.+)$/i.exec(fonte);
        if (match) {
            const nome = String(match[1] || '').trim();
            const roboLegado = listaRobos.find(robo => String(robo && robo.nome || '').trim() === nome);
            if (roboLegado) ids.add(Number(roboLegado.id));
        }
    }

    return ids;
}

function robosAutoTraderAutorizadores(config, est, robos = []) {
    const listaRobos = Array.isArray(robos) ? robos : [];
    const idsSelecionados = idsRobosSelecionadosAutoTrader(config, listaRobos);
    return listaRobos.filter(robo => {
        const id = Number(robo && robo.id);
        const ativo = !(robo && (robo.ativo === false || Number(robo.ativo) === 0));
        return ativo && idsSelecionados.has(id) && roboSintonizaEstrategia(robo, est);
    });
}

function autoTraderAutorizaEstrategia(config, est, robos = []) {
    if (robosAutoTraderAutorizadores(config, est, robos).length > 0) return true;

    const fontes = Array.isArray(config && config.fontes_sinal)
        ? config.fontes_sinal.map(fonte => String(fonte || '').trim()).filter(Boolean)
        : [];

    // Último fallback para motores antigos que gravavam uma origem manual.
    return !est.is_dinamico && fontes.includes(String(est.origem || '').trim());
}

function autoTraderParticipouDoSinal(trader, est, estado) {
    const idsSelecionados = idsRobosSelecionadosAutoTrader(trader && trader.config, ROBOS_MEMORIA);
    const robosSinal = unirRobosInscritos(
        Array.isArray(estado && estado.robosCiclo) ? estado.robosCiclo : [],
        Array.isArray(estado && estado.robosInscritos) ? estado.robosInscritos : []
    );
    const idsSinal = robosSinal.map(robo => Number(robo.id)).filter(Number.isFinite);

    if (idsSelecionados.size > 0 && idsSinal.length > 0) {
        return idsSinal.some(id => idsSelecionados.has(id));
    }

    return autoTraderAutorizaEstrategia(trader && trader.config, est, ROBOS_MEMORIA);
}

function mesaIdFinanceiroTrader(
    trader,
    contexto = 'operacao financeira'
) {
    const mesaRuntime = obterMesaRuntime();
    const mesaId = Number(mesaRuntime.id);
    const traderMesaId = Number(trader?.mesa_id);

    if (
        !Number.isInteger(mesaId)
        || mesaId <= 0
        || !Number.isInteger(traderMesaId)
        || traderMesaId !== mesaId
    ) {
        throw new Error(
            `MC22-X: Trader ${trader?.id ?? 'n/a'} nao pertence ` +
            `a mesa runtime em ${contexto}`
        );
    }

    return mesaId;
}

async function persistirEstadoCicloAutoTrader(trader, estadoBruto, { autoStop = false } = {}) {
    const mesaId = mesaIdFinanceiroTrader(
        trader,
        'persistir estado de ciclo'
    );

    const estado = normalizarEstadoCiclo(estadoBruto || {});
    const desligarPorCiclos = autoStop === true && trader && trader.ativo === true;

    if (desligarPorCiclos) {
        await dbPool.query(
            `UPDATE auto_traders
             SET ativo=false, status_operacao='LIMITE_CICLOS', estado_ciclo=?,
                 reds_virtuais_observados=?, sinais_operados_onda=?, ciclos_concluidos=?, pulos_restantes=?
             WHERE id=? AND mesa_id=?`,
            [
                estado.estado_ciclo,
                estado.reds_virtuais_observados,
                estado.sinais_operados_onda,
                estado.ciclos_concluidos,
                estado.pulos_restantes,
                trader.id,
                mesaId
            ]
        );
    } else {
        await dbPool.query(
            `UPDATE auto_traders
             SET estado_ciclo=?, reds_virtuais_observados=?, sinais_operados_onda=?,
                 ciclos_concluidos=?, pulos_restantes=?
             WHERE id=? AND mesa_id=?`,
            [
                estado.estado_ciclo,
                estado.reds_virtuais_observados,
                estado.sinais_operados_onda,
                estado.ciclos_concluidos,
                estado.pulos_restantes,
                trader.id,
                mesaId
            ]
        );
    }

    aplicarEstadoCiclo(trader, estado);
    if (desligarPorCiclos) {
        trader.ativo = false;
        trader.status_operacao = 'LIMITE_CICLOS';
    }
    return estado;
}

async function processarResultadoVirtualAutoTraders(est, estado, tipoResultado) {
    let alterados = 0;
    for (const trader of AUTO_TRADERS_MEMORIA) {
        if (!trader.ativo) continue;
        if (!['OPERANDO', 'STANDBY'].includes(String(trader.status_operacao || ''))) continue;
        if (!autoTraderParticipouDoSinal(trader, est, estado)) continue;

        const avaliacao = processarResultadoDormindo(trader, tipoResultado);
        if (!avaliacao.mudou) continue;

        await persistirEstadoCicloAutoTrader(trader, avaliacao.estado);
        alterados++;
        if (avaliacao.acordou) {
            console.log(
                `🌊 Auto-Trader ${trader.id}: gatilho de REDs virtuais atingido; `
                + `máquina avançou para ONDA_ATIVA.`
            );
        } else if (String(tipoResultado || '').toUpperCase() === 'RED') {
            const gatilho = Math.max(0, Number(trader.config && trader.config.gatilho_reds_virtuais) || 0);
            console.log(
                `🌙 Auto-Trader ${trader.id}: RED virtual observado `
                + `(${trader.reds_virtuais_observados}/${gatilho}).`
            );
        }
    }

    if (alterados > 0) ioServer.emit('atualizar_interface');
    return alterados;
}

async function prepararEntradaCicloAutoTrader(trader) {
    const decisao = avaliarSinalOnda(trader);
    if (decisao.auto_stop) {
        await persistirEstadoCicloAutoTrader(trader, decisao.estado, { autoStop: true });
        console.log(`🔁 Auto-Trader ${trader.id}: limite de ciclos já atingido; motor desligado.`);
        ioServer.emit('atualizar_interface');
        return false;
    }

    if (decisao.persistir) {
        await persistirEstadoCicloAutoTrader(trader, decisao.estado);
    }

    if (!decisao.permitido) return false;
    return true;
}

async function concluirSinalOperadoAutoTrader(trader, tipoResultado) {
    const progresso = avancarAposSinalOperado(trader);
    if (progresso.mudou) {
        const autoStopEfetivo = progresso.auto_stop === true && trader.ativo === true;
        await persistirEstadoCicloAutoTrader(trader, progresso.estado, { autoStop: autoStopEfetivo });

        if (progresso.ciclo_concluido) {
            console.log(
                `🌊 Auto-Trader ${trader.id}: onda concluída; `
                + `ciclos=${progresso.estado.ciclos_concluidos}.`
            );
        }
        if (autoStopEfetivo) {
            console.log(
                `🔁 Auto-Trader ${trader.id}: limite de ciclos concluídos atingido. `
                + `Motor desligado até reativação manual.`
            );
            ioServer.emit('atualizar_interface');
        }
    }

    console.log(
        `Auto-Trader ${trader.id}: sinal operado encerrado como ${tipoResultado}. `
        + `Estado=${trader.estado_ciclo}, sinais_onda=${trader.sinais_operados_onda}, `
        + `ciclos=${trader.ciclos_concluidos}, pulos=${trader.pulos_restantes}.`
    );
    return progresso;
}

function avaliarStopRedsRobo(robo, tipoResultado) {
    const limite = Math.max(0, Math.trunc(Number(robo && robo.stop_reds_seguidos) || 0));
    const redsAtuais = Math.max(0, Math.trunc(Number(robo && robo.reds_consecutivos) || 0));
    const tipo = String(tipoResultado || '').toUpperCase();

    if (!['GREEN', 'TIE', 'RED'].includes(tipo)) {
        return {
            reds_consecutivos: redsAtuais,
            desligar: false,
            limite
        };
    }

    if (tipo !== 'RED') {
        return {
            reds_consecutivos: 0,
            desligar: false,
            limite
        };
    }

    if (limite <= 0) {
        return {
            reds_consecutivos: 0,
            desligar: false,
            limite
        };
    }

    const proximosReds = redsAtuais + 1;
    return {
        reds_consecutivos: proximosReds,
        desligar: proximosReds >= limite,
        limite
    };
}

function estadoProtecaoDoRobo(robo) {
    if (!estadoStandbyRobos[robo.id]) {
        let historicoReds = [];

        try {
            const bruto = robo.historico_reds_json;
            const parseado = typeof bruto === 'string' ? JSON.parse(bruto || '[]') : bruto;
            if (Array.isArray(parseado)) {
                historicoReds = parseado
                    .map(Number)
                    .filter(Number.isFinite);
            }
        } catch (e) {}

        estadoStandbyRobos[robo.id] = {
            em_standby_ate: Math.max(0, Number(robo.standby_ate) || 0),
            historico_reds: historicoReds
        };
    }

    return estadoStandbyRobos[robo.id];
}

function roboEmStandby(robo, agora = Date.now()) {
    const estado = estadoProtecaoDoRobo(robo);
    return Number(estado.em_standby_ate || 0) > agora;
}

function aplicarProtecaoRoboEmMemoria(robo, estado, greens, reds = robo.reds_consecutivos) {
    const estadoNormalizado = {
        em_standby_ate: Math.max(0, Math.trunc(Number(estado.em_standby_ate) || 0)),
        historico_reds: (Array.isArray(estado.historico_reds) ? estado.historico_reds : [])
            .map(Number)
            .filter(Number.isFinite)
    };

    robo.greens_consecutivos = Math.max(0, Number(greens) || 0);
    robo.reds_consecutivos = Math.max(0, Math.trunc(Number(reds) || 0));
    robo.standby_ate = estadoNormalizado.em_standby_ate;
    robo.historico_reds_json = JSON.stringify(estadoNormalizado.historico_reds);
    estadoStandbyRobos[robo.id] = estadoNormalizado;
}

async function persistirProtecaoRobo(robo, estado, greens, reds = robo.reds_consecutivos) {
    const greensNormalizado = Math.max(0, Number(greens) || 0);
    const redsNormalizado = Math.max(0, Math.trunc(Number(reds) || 0));
    const standbyAte = Math.max(0, Math.trunc(Number(estado.em_standby_ate) || 0));
    const historicoReds = (Array.isArray(estado.historico_reds) ? estado.historico_reds : [])
        .map(Number)
        .filter(Number.isFinite);
    const historicoJson = JSON.stringify(historicoReds);

    await dbPool.query(
        `UPDATE robos_canais
         SET greens_consecutivos=?,
             reds_consecutivos=?,
             standby_ate=?,
             historico_reds_json=?
         WHERE id=?
           AND mesa_id=?`,
        [
            greensNormalizado,
            redsNormalizado,
            standbyAte,
            historicoJson,
            robo.id,
            obterMesaRuntime().id
        ]
    );

    aplicarProtecaoRoboEmMemoria(
        robo,
        { em_standby_ate: standbyAte, historico_reds: historicoReds },
        greensNormalizado,
        redsNormalizado
    );
}

async function processarResultadoProtecaoRobos(estado, tipoResultado, timestampColeta) {
    if (!estado) return [];

    await aguardarInscricaoTelegram(estado);

    const idsInscritos = new Set(
        (Array.isArray(estado.robosInscritos) ? estado.robosInscritos : [])
            .map(robo => String(robo.id))
    );

    if (idsInscritos.size === 0) return [];

    const timestampMs = Number(timestampColeta);
    const agoraResultado = Number.isFinite(timestampMs) && timestampMs > 0
        ? Math.trunc(timestampMs)
        : Date.now();
    const avisosProtecao = [];

    for (const robo of ROBOS_MEMORIA) {
        if (!idsInscritos.has(String(robo.id))) continue;

        const estadoAtual = estadoProtecaoDoRobo(robo);
        const proximoEstado = {
            em_standby_ate: Math.max(0, Number(estadoAtual.em_standby_ate) || 0),
            historico_reds: [...(Array.isArray(estadoAtual.historico_reds) ? estadoAtual.historico_reds : [])]
        };
        const cooldown = robo.config?.cooldown || {};
        const cooldownAtivo = cooldown.ativo === true || cooldown.ativo === 1;
        const greensAtuais = Math.max(0, Number(robo.greens_consecutivos) || 0);
        const stopReds = avaliarStopRedsRobo(robo, tipoResultado);

        if (tipoResultado !== 'RED') {
            const proximosGreens = greensAtuais + 1;

            if (!cooldownAtivo) {
                proximoEstado.historico_reds = [];
            } else if (String(cooldown.tipo || 'CONSERVADOR').toUpperCase() === 'DINAMICO') {
                const intervaloMin = Math.max(1, Number(cooldown.intervalo_min) || 30);
                const limite = agoraResultado - (intervaloMin * 60 * 1000);
                proximoEstado.historico_reds = proximoEstado.historico_reds.filter(ts => Number(ts) >= limite);
            }

            try {
                await persistirProtecaoRobo(
                    robo,
                    proximoEstado,
                    proximosGreens,
                    stopReds.reds_consecutivos
                );
            } catch (e) {
                console.error(`⚠️ Robô ${robo.id}: falha ao persistir streak/proteção após ${tipoResultado}; memória preservada no estado anterior.`, e.message);
            }
            continue;
        }

        const proximosGreens = 0;

        if (stopReds.desligar) {
            const estadoStop = {
                em_standby_ate: 0,
                historico_reds: []
            };

            try {
                await dbPool.query(
                    `UPDATE robos_canais
                     SET ativo=false,
                         greens_consecutivos=0,
                         reds_consecutivos=?,
                         standby_ate=0,
                         historico_reds_json='[]'
                     WHERE id=?
                       AND mesa_id=?`,
                    [
                        stopReds.reds_consecutivos,
                        robo.id,
                        obterMesaRuntime().id
                    ]
                );

                aplicarProtecaoRoboEmMemoria(
                    robo,
                    estadoStop,
                    0,
                    stopReds.reds_consecutivos
                );
                robo.ativo = false;

                console.log(
                    `🛑 Robô ${robo.id}: Stop Reds atingido `
                    + `(${stopReds.reds_consecutivos}/${stopReds.limite}). `
                    + `Robô desligado até reativação manual.`
                );
            } catch (e) {
                aplicarProtecaoRoboEmMemoria(
                    robo,
                    estadoStop,
                    0,
                    stopReds.reds_consecutivos
                );
                robo.ativo = false;
                console.error(
                    `🚨 Robô ${robo.id}: falha ao persistir Stop Reds; `
                    + `robô mantido desligado apenas em memória por segurança.`,
                    e.message
                );
            }

            continue;
        }

        if (!cooldownAtivo) {
            proximoEstado.historico_reds = [];

            try {
                await persistirProtecaoRobo(
                    robo,
                    proximoEstado,
                    proximosGreens,
                    stopReds.reds_consecutivos
                );
            } catch (e) {
                aplicarProtecaoRoboEmMemoria(
                    robo,
                    proximoEstado,
                    proximosGreens,
                    stopReds.reds_consecutivos
                );
                console.error(`⚠️ Robô ${robo.id}: falha ao persistir RED; estado conservador mantido apenas em memória.`, e.message);
            }
            continue;
        }

        const tipoCooldown = String(cooldown.tipo || 'CONSERVADOR').toUpperCase();
        const pausaMin = Math.max(1, Number(cooldown.pausa_min) || 15);
        let devePausar = false;

        if (tipoCooldown === 'DINAMICO') {
            const intervaloMin = Math.max(1, Number(cooldown.intervalo_min) || 30);
            const qtdReds = Math.max(2, Number(cooldown.reds) || 2);
            const limite = agoraResultado - (intervaloMin * 60 * 1000);

            proximoEstado.historico_reds = proximoEstado.historico_reds
                .filter(ts => Number(ts) >= limite);
            proximoEstado.historico_reds.push(agoraResultado);
            devePausar = proximoEstado.historico_reds.length >= qtdReds;
        } else {
            proximoEstado.historico_reds = [agoraResultado];
            devePausar = true;
        }

        if (devePausar) {
            proximoEstado.em_standby_ate = Math.max(Date.now(), agoraResultado) + (pausaMin * 60 * 1000);
            proximoEstado.historico_reds = [];

            avisosProtecao.push({
                robo_id: robo.id,
                pausa_min: pausaMin,
                texto: String(cooldown.aviso_texto || '⚠️ EM PROTEÇÃO ⚠️ Retorna em {minutos} minutos.')
                    .replaceAll('{minutos}', String(pausaMin)),
                avisar_telegram: cooldown.aviso_telegram !== false
            });
        }

        try {
            await persistirProtecaoRobo(
                robo,
                proximoEstado,
                proximosGreens,
                stopReds.reds_consecutivos
            );

            if (devePausar) {
                console.log(`🛡️ Robô ${robo.id} em proteção por ${pausaMin} minuto(s).`);
            }
        } catch (e) {
            aplicarProtecaoRoboEmMemoria(
                robo,
                proximoEstado,
                proximosGreens,
                stopReds.reds_consecutivos
            );

            if (devePausar) {
                console.error(`🚨 Robô ${robo.id}: falha ao persistir standby; proteção mantida em memória por segurança.`, e.message);
            } else {
                console.error(`⚠️ Robô ${robo.id}: falha ao persistir janela de REDs; estado conservador mantido apenas em memória.`, e.message);
            }
        }
    }

    ioServer.emit('atualizar_robos');
    return avisosProtecao;
}

async function enviarAvisosProtecaoTelegram(estado, avisos) {
    if (!estado || !Array.isArray(avisos) || avisos.length === 0) return;

    await aguardarInscricaoTelegram(estado);

    const inscritosTelegram = Array.isArray(estado.robosTelegramInscritos)
        ? estado.robosTelegramInscritos
        : [];

    await Promise.all(
        avisos
            .filter(aviso => aviso.avisar_telegram)
            .map(async aviso => {
                const robo = inscritosTelegram.find(r => String(r.id) === String(aviso.robo_id));
                if (!robo) return;

                await Promise.all(
                    robo.chat_ids.map(chatId =>
                        enviarMensagemTelegram(robo.telegram_token, chatId, aviso.texto)
                    )
                );
            })
    );
}

function destinosTelegramRobo(robo) {
    const destinos = new Set();

    const principal = String(robo.telegram_chat_id || '').trim();
    if (principal) destinos.add(principal);

    for (const destinatario of (Array.isArray(robo.destinatarios) ? robo.destinatarios : [])) {
        const chatId = String(destinatario.chat_id || '').trim();
        if (chatId) destinos.add(chatId);
    }

    return [...destinos];
}

function snapshotPublicoRobo(robo) {
    return {
        id: robo.id,
        nome: robo.nome,
        tag_visual: robo.tag_visual,
        cor_hex: robo.cor_hex
    };
}

function unirRobosInscritos(...listas) {
    const unicos = new Map();

    for (const lista of listas) {
        for (const robo of (Array.isArray(lista) ? lista : [])) {
            if (robo && robo.id !== undefined && robo.id !== null) {
                unicos.set(String(robo.id), snapshotPublicoRobo(robo));
            }
        }
    }

    return [...unicos.values()];
}

function chaveLockSinalRobo(roboOuId) {
    const id = roboOuId && typeof roboOuId === 'object'
        ? roboOuId.id
        : roboOuId;

    if (id === undefined || id === null) return '';
    return String(id);
}

function robosDoEstadoSinal(estado) {
    if (!estado) return [];

    const ciclo = Array.isArray(estado.robosCiclo)
        ? estado.robosCiclo
        : [];

    const inscritos = Array.isArray(estado.robosInscritos)
        ? estado.robosInscritos
        : [];

    return unirRobosInscritos(ciclo, inscritos);
}

function adquirirLocksSinalRobos(robos, estrategiaId) {
    const participantes = unirRobosInscritos(
        Array.isArray(robos) ? robos : []
    );

    if (participantes.length === 0) return false;

    // Aquisição atômica: primeiro valida TODOS, depois grava TODOS.
    for (const robo of participantes) {
        const id = chaveLockSinalRobo(robo);
        if (!id || locksSinalPorRobo.has(id)) {
            return false;
        }
    }

    for (const robo of participantes) {
        const id = chaveLockSinalRobo(robo);

        locksSinalPorRobo.set(id, {
            estrategia_id: String(estrategiaId),
            gale_atual: 0,
            rodada_inicio: contadorRodadasSinal
        });
    }

    return true;
}

function atualizarGaleLocksSinal(estado, estrategiaId) {
    const galeAtual = Math.max(
        0,
        Math.trunc(Number(estado?.galeAtual) || 0)
    );

    for (const robo of robosDoEstadoSinal(estado)) {
        const id = chaveLockSinalRobo(robo);
        if (!id) continue;

        const lock = locksSinalPorRobo.get(id);
        if (!lock) continue;
        if (String(lock.estrategia_id) !== String(estrategiaId)) continue;

        locksSinalPorRobo.set(id, {
            ...lock,
            gale_atual: galeAtual
        });
    }
}

function liberarLocksSinalDoEstado(
    estrategiaId,
    estado,
    { rearmarCursor = true } = {}
) {
    const participantes = robosDoEstadoSinal(estado);

    for (const robo of participantes) {
        const id = chaveLockSinalRobo(robo);
        if (!id) continue;

        const lock = locksSinalPorRobo.get(id);
        const pertenceAoCiclo = lockPertenceAoCicloSinal(
            estrategiaId,
            estado,
            lock
        );

        // Nunca libera nem rearma o cursor de um lock que pertença a outro ciclo.
        if (pertenceAoCiclo) {
            locksSinalPorRobo.delete(id);
        }

        if (rearmarCursor && pertenceAoCiclo) {
            cursorRetomadaPorRobo.set(id, contadorRodadasSinal);
        }
    }
}

function roboPodeAvaliarPadraoAposCursor(roboId, tamanhoPadrao) {
    const id = chaveLockSinalRobo(roboId);
    if (!id) return false;

    if (!cursorRetomadaPorRobo.has(id)) {
        // Robô que nunca saiu de um lock continua usando o histórico normal.
        return true;
    }

    const tamanho = Math.max(
        1,
        Math.trunc(Number(tamanhoPadrao) || 1)
    );

    const rodadaRetomada = Math.max(
        0,
        Number(cursorRetomadaPorRobo.get(id)) || 0
    );

    const rodadasNovas = Math.max(
        0,
        contadorRodadasSinal - rodadaRetomada
    );

    // Nenhuma casa do padrão pode ter sido formada enquanto o robô estava surdo.
    return rodadasNovas >= tamanho;
}

// MICRO-COMMIT 4: snapshot imutável de inscritos por ciclo.
// O primeiro acesso operacional a um estado ativo congela o
// conjunto de robôs daquele ciclo. Alterações posteriores nas
// listas mutáveis não mudam retroativamente Gale, liberação
// ou finalização.
const robosDoEstadoSinalSemSnapshot = robosDoEstadoSinal;
const snapshotsInscricaoSinalPorEstado = new WeakMap();

function estrategiaIdDoEstadoSinal(estado) {
    if (!estado || typeof estado !== 'object') return null;

    for (const [estrategiaId, estadoAtual] of Object.entries(estadoApostas)) {
        if (estadoAtual === estado) {
            return String(estrategiaId);
        }
    }

    return null;
}

function criarSnapshotInscricaoSinal(estrategiaId, estado) {
    if (!estado || typeof estado !== 'object') {
        return null;
    }

    const estrategiaChave =
        estrategiaId === null || estrategiaId === undefined
            ? ''
            : String(estrategiaId);

    if (!estrategiaChave) {
        return null;
    }

    const existente =
        snapshotsInscricaoSinalPorEstado.get(estado);

    if (existente) {
        if (
            existente.estrategia_id !== estrategiaChave
        ) {
            console.error(
                `🚨 Snapshot de ciclo divergente | ` +
                `snapshot=${existente.estrategia_id} | ` +
                `estado=${estrategiaChave}.`
            );

            return null;
        }

        return existente;
    }

    const participantesAtuais =
        robosDoEstadoSinalSemSnapshot(estado);

    const porId = new Map();

    for (const robo of participantesAtuais) {
        const id = chaveLockSinalRobo(robo);

        if (!id) continue;

        if (!porId.has(id)) {
            porId.set(id, robo);
        }
    }

    if (porId.size === 0) {
        return null;
    }

    const robos = Object.freeze(
        Array.from(porId.values())
    );

    const ids = Object.freeze(
        Array.from(porId.keys())
    );

    const snapshot = Object.freeze({
        estrategia_id: estrategiaChave,
        rodada_inicio: Math.max(
            0,
            Math.trunc(Number(contadorRodadasSinal) || 0)
        ),
        robos,
        ids
    });

    snapshotsInscricaoSinalPorEstado.set(
        estado,
        snapshot
    );

    return snapshot;
}

function robosDoEstadoSinalIsolado(estrategiaId, estado) {
    const snapshot = criarSnapshotInscricaoSinal(
        estrategiaId,
        estado
    );

    return snapshot
        ? snapshot.robos
        : [];
}

function limparSnapshotInscricaoSinal(estrategiaId, estado) {
    if (!estado || typeof estado !== 'object') {
        return false;
    }

    const snapshot =
        snapshotsInscricaoSinalPorEstado.get(estado);

    if (!snapshot) {
        return false;
    }

    if (
        snapshot.estrategia_id !== String(estrategiaId)
    ) {
        console.error(
            `🚨 Tentativa de limpar snapshot de outro ciclo | ` +
            `snapshot=${snapshot.estrategia_id} | ` +
            `solicitante=${estrategiaId}.`
        );

        return false;
    }

    snapshotsInscricaoSinalPorEstado.delete(
        estado
    );

    return true;
}

// Compatibilidade com os helpers já existentes.
//
// liberarLocksSinalDoEstado,
// atualizarGaleLocksSinal e
// sincronizarLocksSinalComEstadoApostas
// continuam usando robosDoEstadoSinal normalmente.
//
// Para um estado ativo, porém, esta camada passa a devolver
// sempre o mesmo conjunto congelado de participantes.
robosDoEstadoSinal = function robosDoEstadoSinalComSnapshot(estado) {
    if (!estado || typeof estado !== 'object') {
        return robosDoEstadoSinalSemSnapshot(estado);
    }

    const existente =
        snapshotsInscricaoSinalPorEstado.get(estado);

    if (existente) {
        return existente.robos;
    }

    if (estado.aguardandoResultado !== true) {
        return robosDoEstadoSinalSemSnapshot(estado);
    }

    const estrategiaId =
        estrategiaIdDoEstadoSinal(estado);

    if (!estrategiaId) {
        return [];
    }

    const snapshot = criarSnapshotInscricaoSinal(
        estrategiaId,
        estado
    );

    return snapshot
        ? snapshot.robos
        : [];
};

// MICRO-COMMIT 5: identidade de geração por rodada_inicio.
//
// MC3 isolou lock/estado por robô e estratégia.
// MC4 congelou os participantes de cada estado.
//
// MC5 fecha o caso ABA:
// ciclos diferentes podem reutilizar a mesma estratégia.
// Portanto estrategia_id sozinho não prova ownership.
//
// rodada_inicio passa a funcionar como fencing token da geração.
function rodadaInicioSnapshotSinal(estrategiaId, estado) {
    if (!estado || typeof estado !== 'object') {
        return null;
    }

    const snapshot =
        snapshotsInscricaoSinalPorEstado.get(estado) ||
        criarSnapshotInscricaoSinal(
            estrategiaId,
            estado
        );

    if (!snapshot) {
        return null;
    }

    if (
        snapshot.estrategia_id !== String(estrategiaId)
    ) {
        return null;
    }

    const rodadaInicio =
        Number(snapshot.rodada_inicio);

    if (!Number.isFinite(rodadaInicio)) {
        return null;
    }

    return Math.max(
        0,
        Math.trunc(rodadaInicio)
    );
}

function lockPertenceAoCicloSinal(
    estrategiaId,
    estado,
    lock
) {
    if (!lock) {
        return false;
    }

    if (
        String(lock.estrategia_id) !==
        String(estrategiaId)
    ) {
        return false;
    }

    const rodadaInicioEstado =
        rodadaInicioSnapshotSinal(
            estrategiaId,
            estado
        );

    if (rodadaInicioEstado === null) {
        return false;
    }

    const rodadaInicioLock =
        Number(lock.rodada_inicio);

    // Lock incompleto, legado ou corrompido:
    // nunca é tratado como pertencente ao ciclo atual.
    if (!Number.isFinite(rodadaInicioLock)) {
        return false;
    }

    // MICRO-COMMIT 8: Tolerância de rodada_inicio para avanço de Gales (até 3 rodadas)
    const diffRodadas = Math.abs(
        Math.max(0, Math.trunc(rodadaInicioLock)) - rodadaInicioEstado
    );
    return diffRodadas <= 3;
}

// MICRO-COMMIT 7: tolerância operacional de defasagem de Gale.
// O fencing de geração continua estrito. Apenas a sincronização operacional
// de gale_atual admite uma defasagem máxima de UMA transição para trás.
//
// MICRO-COMMIT 3: isolamento de estado/transições.
// Cada estado ativo só pode avançar quando TODOS os robôs do seu ciclo ainda
// possuem o lock da mesma estratégia e do mesmo nível de Gale.
function estadoSinalComLocksConsistentes(estrategiaId, estado) {
    if (!estado || estado.aguardandoResultado !== true) return false;
    if (estadoApostas[String(estrategiaId)] !== estado) return false;

    const participantes = robosDoEstadoSinalIsolado(estrategiaId, estado);
    if (participantes.length === 0) return false;

    // Fencing de geração com tolerância de recém-nascido (MC6):
    // Se o ciclo acabou de nascer (galeAtual 0 e sem locks populados ainda por atraso assíncrono),
    // damos uma breve tolerância em vez de invalidar abruptamente em fail-closed.
    const geracaoConsistente = participantes.every(robo => {
        const id = chaveLockSinalRobo(robo);
        if (!id) return false;
        const lock = locksSinalPorRobo.get(id);
        if (!lock && Number(estado.galeAtual || 0) === 0) {
            return true; // Tolera ausência momentânea no exato milissegundo de disparo
        }
        return lockPertenceAoCicloSinal(
            estrategiaId,
            estado,
            lock
        );
    });

    if (!geracaoConsistente) return false;

    const galeAtual = Math.max(
        0,
        Math.trunc(Number(estado.galeAtual) || 0)
    );

    return participantes.every(robo => {
        const id = chaveLockSinalRobo(robo);
        if (!id) return false;

        const lock = locksSinalPorRobo.get(id);

        // MC6 já autorizava esta tolerância na barreira de geração,
        // mas a validação abaixo a anulava imediatamente.
        //
        // Em DIRETO, ausência momentânea do lock continua sendo
        // tolerada somente enquanto galeAtual === 0.
        if (!lock) {
            return galeAtual === 0;
        }

        // Segurança estrutural NÃO é negociável:
        // um lock existente precisa continuar pertencendo à mesma
        // estratégia E à mesma rodada_inicio do snapshot.
        if (
            !lockPertenceAoCicloSinal(
                estrategiaId,
                estado,
                lock
            )
        ) {
            return false;
        }

        const galeLock = Math.max(
            0,
            Math.trunc(Number(lock.gale_atual) || 0)
        );

        // Estado e lock sincronizados: situação normal.
        if (galeLock === galeAtual) {
            return true;
        }

        // Tolerância operacional estritamente limitada:
        //
        // estado G1 + lock G0 -> aceita
        // estado G2 + lock G1 -> aceita
        //
        // O lock só pode estar UMA transição ATRÁS.
        // Lock adiantado ou dois níveis atrasado continua falhando.
        return (
            galeAtual > 0 &&
            galeLock === (galeAtual - 1)
        );
    });
}

function invalidarEstadoSinalInconsistente(
    estrategiaId,
    estado,
    motivo = 'LOCK_ESTADO_DIVERGENTE'
) {
    if (!estado) return false;

    // liberarLocksSinalDoEstado só remove locks realmente pertencentes
    // a esta estratégia. Locks de outros ciclos permanecem intocados.
    liberarLocksSinalDoEstado(estrategiaId, estado);
    limparSnapshotInscricaoSinal(estrategiaId, estado);

    estado.aguardandoResultado = false;
    estado.galeAtual = 0;
    estado.robosWebInscritos = [];
    estado.robosTelegramInscritos = [];
    estado.robosInscritos = [];
    estado.telegramEntradaPromise = null;

    console.error(
        `🚨 Ciclo de sinal invalidado em modo fail-closed | estratégia=${estrategiaId} | motivo=${motivo}.`
    );

    return true;
}

function avancarGaleEstadoSinal(
    estrategiaId,
    estado,
    limiteGales
) {
    if (
        !estadoSinalComLocksConsistentes(
            estrategiaId,
            estado
        )
    ) {
        return false;
    }

    const atual = Math.max(
        0,
        Math.trunc(Number(estado.galeAtual) || 0)
    );

    const limite = Math.max(
        0,
        Math.trunc(Number(limiteGales) || 0)
    );

    if (atual >= limite) {
        return false;
    }

    estado.galeAtual = atual + 1;

    atualizarGaleLocksSinal(
        estado,
        estrategiaId
    );

    // Confirma que estado e locks avançaram juntos.
    return estadoSinalComLocksConsistentes(
        estrategiaId,
        estado
    );
}

function finalizarEstadoSinal(
    estrategiaId,
    estado
) {
    if (
        !estadoSinalComLocksConsistentes(
            estrategiaId,
            estado
        )
    ) {
        return false;
    }

    estado.aguardandoResultado = false;

    liberarLocksSinalDoEstado(
        estrategiaId,
        estado
    );
    limparSnapshotInscricaoSinal(estrategiaId, estado);

    estado.galeAtual = 0;

    return true;
}

function sincronizarLocksSinalComEstadoApostas() {
    const idsAtivos = new Set();

    for (const [estrategiaId, estado] of Object.entries(estadoApostas || {})) {
        if (!estado || estado.aguardandoResultado !== true) continue;

        const galeAtual = Math.max(
            0,
            Math.trunc(Number(estado.galeAtual) || 0)
        );

        for (const robo of robosDoEstadoSinal(estado)) {
            const id = chaveLockSinalRobo(robo);
            if (!id) continue;

            idsAtivos.add(id);

            const existente = locksSinalPorRobo.get(id);

            if (!existente) {
                locksSinalPorRobo.set(id, {
                    estrategia_id: String(estrategiaId),
                    gale_atual: galeAtual,
                    rodada_inicio: contadorRodadasSinal
                });
            } else if (
                String(existente.estrategia_id) !== String(estrategiaId)
            ) {
                console.error(
                    `🚨 Conflito de lock preservado | robô=${id} | ` +
                    `lock=${existente.estrategia_id} | estado=${estrategiaId}. ` +
                    'O lock existente não será sobrescrito.'
                );

                continue;
            } else if (
                Math.max(
                    0,
                    Math.trunc(Number(existente.gale_atual) || 0)
                ) !== galeAtual
            ) {
                // Mesma estratégia: o estado persistido em memória é
                // a fonte do nível corrente.
                locksSinalPorRobo.set(id, {
                    ...existente,
                    gale_atual: galeAtual
                });
            }
        }
    }

    // Caso uma recarga de memória elimine um estado antigo, o lock não pode
    // sobreviver órfão. A remoção também estabelece o cursor de retomada.
    for (const id of [...locksSinalPorRobo.keys()]) {
        if (idsAtivos.has(id)) continue;

        locksSinalPorRobo.delete(id);
        cursorRetomadaPorRobo.set(id, contadorRodadasSinal);
    }
}

function ciclosAtivosPorRobo() {
    sincronizarLocksSinalComEstadoApostas();
    return new Map(locksSinalPorRobo);
}

async function selecionarRobosParaEstrategia(est, historicoLiveCanonico) {
    if (est.quarentena_restante > 0) {
        return { todos: [], web: [], telegram: [], bloqueados: [], assertividade: 0 };
    }

    const assertividade = calcularAssertividadeLiveCanonica(est, historicoLiveCanonico);
    const ciclosAtivos = ciclosAtivosPorRobo();
    const bloqueados = [];
    const elegiveis = ROBOS_MEMORIA.filter(robo => {
        const ativo = robo.ativo === true || robo.ativo === 1;
        const minAssert = Math.max(0, Number(robo.min_assertividade) || 0);

        const sintoniza = ativo
            && !roboEmStandby(robo)
            && assertividade >= minAssert
            && roboSintonizaEstrategia(robo, est);
        if (!sintoniza) return false;
        const ciclo = ciclosAtivos.get(String(robo.id));
        if (ciclo) {
            bloqueados.push({ ...snapshotPublicoRobo(robo), ...ciclo });
            return false;
        }

        const tamanhoPadrao = Array.isArray(est.padrao)
            ? est.padrao.length
            : 0;

        if (!roboPodeAvaliarPadraoAposCursor(robo.id, tamanhoPadrao)) {
            return false;
        }

        return true;
    });

    const todos = elegiveis.map(snapshotPublicoRobo);
    const web = elegiveis
        .filter(robo => robo.enviar_web === true || robo.enviar_web === 1)
        .map(snapshotPublicoRobo);

    const telegram = elegiveis
        .filter(robo => {
            const enviaTelegram = robo.enviar_telegram === true || robo.enviar_telegram === 1;
            return enviaTelegram
                && String(robo.telegram_token || '').trim() !== ''
                && destinosTelegramRobo(robo).length > 0;
        })
        .map(robo => ({
            ...snapshotPublicoRobo(robo),
            telegram_token: String(robo.telegram_token || '').trim(),
            chat_ids: destinosTelegramRobo(robo),
            greens_consecutivos: Math.max(0, Number(robo.greens_consecutivos) || 0),
            config: JSON.parse(JSON.stringify(robo.config || {}))
        }));

    return {
        todos,
        web,
        telegram,
        bloqueados,
        assertividade: Number(assertividade.toFixed(1))
    };
}

function formatarPadraoTelegram(padrao) {
    return (Array.isArray(padrao) ? padrao : []).map(item => {
        if (item === 'Player') return '🔵 P';
        if (item === 'Banker') return '🔴 B';
        if (item === 'Tie') return '🟡 T';
        return String(item);
    }).join(' → ');
}

function rotuloEntradaTelegram(entrada) {
    if (entrada === 'Player') return '🔵 PLAYER';
    if (entrada === 'Banker') return '🔴 BANKER';
    return '🟡 TIE';
}

function rotuloNivelTelegram(nivel) {
    const valor = Math.max(0, Math.trunc(Number(nivel) || 0));
    return valor === 0 ? 'DIRETO' : `GALE ${valor}`;
}

function linhaSequenciaGreenTelegram(valor) {
    const sequencia = Math.max(0, Math.trunc(Number(valor) || 0));
    return `🔥 Sequência atual: ${sequencia} ${sequencia === 1 ? 'Green' : 'Greens'}`;
}

function montarMensagemTelegram(tipo, est, estado, robo, extras = {}) {
    const config = robo.config || {};
    const linhas = [];

    const titulos = {
        ENTRADA: '🎯 NOVA ENTRADA',
        GALE: `🔁 GALE ${Math.max(1, Number(extras.nivel) || 1)}`,
        GREEN: extras.resultado === 'TIE' ? '🟡 EMPATE PROTEGIDO' : '✅ GREEN CONFIRMADO',
        RED: '❌ RED CONFIRMADO'
    };

    if (config.cabecalho) linhas.push(String(config.cabecalho).trim());

    linhas.push('━━━━━━━━━━━━━━━━━━━━');
    linhas.push(titulos[tipo] || String(tipo || 'SINAL'));
    linhas.push('━━━━━━━━━━━━━━━━━━━━');

    if (robo.nome) linhas.push(`🤖 Robô: ${robo.nome}`);
    if (config.mostrar_nome !== false) linhas.push(`📊 Estratégia: ${est.nome}`);

    if (tipo === 'ENTRADA' && config.mostrar_padrao !== false) {
        const padrao = formatarPadraoTelegram(est.padrao);
        if (padrao) linhas.push(`🧩 Padrão: ${padrao}`);
    }

    if (config.mostrar_assertividade !== false && Number.isFinite(Number(estado.assertividadeSinal))) {
        linhas.push(`📈 Assertividade: ${Number(estado.assertividadeSinal).toFixed(1)}%`);
    }

    if (tipo === 'ENTRADA' || tipo === 'GALE') {
        linhas.push(`💰 Entrada: ${rotuloEntradaTelegram(est.entrada)}`);
    }

    // MC9: o multiplicador do empate sempre segue no payload bruto.
    // O presenter incorpora esse valor ao título final.
    if (tipo === 'GREEN' && extras.resultado === 'TIE' && extras.multiplicador) {
        linhas.push(`✨ Multiplicador: ${extras.multiplicador}`);
    }

    // MC9: todo GREEN carrega somente a etapa em que foi concluído.
    // A semântica visual "Entrada: Principal/Gale N" pertence ao presenter.
    if (tipo === 'GREEN') {
        linhas.push(`🏁 Resultado: ${rotuloNivelTelegram(estado.galeAtual)}`);
    }

    if (['ENTRADA', 'GREEN', 'RED'].includes(tipo)) {
        linhas.push(linhaSequenciaGreenTelegram(extras.greens_consecutivos ?? robo.greens_consecutivos));
    }

    if (tipo === 'ENTRADA') linhas.push('⏳ Aguardando resultado da mesa...');
    if (config.rodape) {
        linhas.push('━━━━━━━━━━━━━━━━━━━━');
        linhas.push(String(config.rodape).trim());
    }

    return linhas.filter(Boolean).join('\n').slice(0, 4096);
}

function mascararChatIdTelegram(chatId) {
    const valor = String(chatId || '').trim();
    if (!valor) return '(vazio)';
    const sufixo = valor.slice(-4);
    return `${'*'.repeat(Math.max(3, valor.length - sufixo.length))}${sufixo}`;
}

function descricaoErroTelegram(valor) {
    const texto = String(valor || '').replace(/[\r\n\t]+/g, ' ').trim();
    return texto.slice(0, 240) || 'Falha sem descrição retornada pelo Telegram';
}

function resultadoTelegramOk(resultado) {
    return resultado && resultado.ok === true;
}

async function enviarMensagemTelegram(token, chatId, texto, fetchImpl = fetch) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);

    try {
        const resposta = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: texto
            }),
            signal: controller.signal
        });

        let corpo = null;
        try { corpo = await resposta.json(); } catch (e) {}

        const ok = resposta.ok && corpo && corpo.ok === true;
        return {
            ok,
            http_status: Number(resposta.status) || 0,
            error_code: ok ? null : (Number(corpo?.error_code) || null),
            descricao: ok ? '' : descricaoErroTelegram(corpo?.description || `HTTP ${resposta.status || 0}`)
        };
    } catch (e) {
        const timeout = e?.name === 'AbortError';
        return {
            ok: false,
            http_status: 0,
            error_code: null,
            descricao: timeout
                ? `Tempo limite de ${TELEGRAM_TIMEOUT_MS}ms ao acessar a API do Telegram`
                : descricaoErroTelegram(e?.message || 'Falha de conexão com a API do Telegram')
        };
    } finally {
        clearTimeout(timeoutId);
    }
}

async function inscreverRobosTelegramEntrada(est, estado, candidatos) {
    const listaCandidatos = Array.isArray(candidatos) ? candidatos : [];

    const resultadosRobos = await Promise.all(
        listaCandidatos.map(async robo => {
            const texto = montarMensagemTelegram('ENTRADA', est, estado, robo);
            const resultados = await Promise.all(
                robo.chat_ids.map(chatId => enviarMensagemTelegram(robo.telegram_token, chatId, texto))
            );

            resultados.forEach((resultado, indice) => {
                if (resultadoTelegramOk(resultado)) return;
                console.warn(
                    `⚠️ Robô ${robo.id}: Telegram ENTRADA falhou para chat `
                    + `${mascararChatIdTelegram(robo.chat_ids[indice])} — ${resultado.descricao}`
                    + `${resultado.error_code ? ` (código ${resultado.error_code})` : ''}.`
                );
            });

            const chatIdsEntregues = robo.chat_ids.filter((chatId, indice) => resultadoTelegramOk(resultados[indice]));
            if (chatIdsEntregues.length === 0) {
                console.warn(`⚠️ Robô ${robo.id}: nenhuma entrega Telegram confirmada na ENTRADA.`);
                return null;
            }

            console.log(`📨 Robô ${robo.id}: Telegram confirmado em ${chatIdsEntregues.length}/${robo.chat_ids.length} destino(s).`);
            return {
                ...robo,
                chat_ids: chatIdsEntregues
            };
        })
    );

    const inscritos = resultadosRobos.filter(Boolean);
    estado.robosTelegramInscritos = inscritos;
    estado.robosInscritos = unirRobosInscritos(estado.robosCiclo, estado.robosWebInscritos, inscritos);
    return inscritos;
}

async function aguardarInscricaoTelegram(estado) {
    if (!estado || !estado.telegramEntradaPromise) return;

    try {
        await estado.telegramEntradaPromise;
    } catch (e) {
        console.error('⚠️ Falha inesperada ao aguardar inscrição Telegram:', e.message);
    }
}

async function enviarTelegramParaInscritos(tipo, est, estado, extras = {}) {
    await aguardarInscricaoTelegram(estado);

    const inscritos = Array.isArray(estado.robosTelegramInscritos) ? estado.robosTelegramInscritos : [];
    await Promise.all(
        inscritos.map(async robo => {
            const roboAtual = ROBOS_MEMORIA.find(item => String(item.id) === String(robo.id));
            const extrasRobo = {
                ...extras,
                greens_consecutivos: Math.max(0, Number(roboAtual?.greens_consecutivos ?? robo.greens_consecutivos) || 0)
            };
            const texto = montarMensagemTelegram(tipo, est, estado, robo, extrasRobo);
            const resultados = await Promise.all(
                robo.chat_ids.map(chatId => enviarMensagemTelegram(robo.telegram_token, chatId, texto))
            );

            resultados.forEach((resultado, indice) => {
                if (resultadoTelegramOk(resultado)) return;
                console.warn(
                    `⚠️ Robô ${robo.id}: Telegram ${tipo} falhou para chat `
                    + `${mascararChatIdTelegram(robo.chat_ids[indice])} — ${resultado.descricao}`
                    + `${resultado.error_code ? ` (código ${resultado.error_code})` : ''}.`
                );
            });

            const entregues = resultados.filter(resultadoTelegramOk).length;
            if (entregues !== robo.chat_ids.length) {
                console.warn(`⚠️ Robô ${robo.id}: Telegram ${tipo} confirmado em ${entregues}/${robo.chat_ids.length} destino(s).`);
            }
        })
    );
}

function emitirAlertaWebRobo(tipo, est, estado, extras = {}) {
    if (!estado) return;

    const robosWeb = Array.isArray(estado.robosWebInscritos)
        ? estado.robosWebInscritos
        : (Array.isArray(estado.robosInscritos) ? estado.robosInscritos : []);

    if (robosWeb.length === 0) return;

    ioServer.emit('alerta_painel', {
        tipo,
        nome: est.nome,
        entrada: est.entrada,
        padrao: est.padrao,
        assertividade: estado.assertividadeSinal,
        robosNotificados: robosWeb,
        ...extras
    });
}

async function registrarHistoricoRobosInscritos(est, estado, tipoResultado, galeAtual, multiplicador, timestampColeta) {
    if (!estado || !Array.isArray(estado.robosInscritos) || estado.robosInscritos.length === 0) return;

    const mesaRuntime = obterMesaRuntime();
    const timestampMs = Number(timestampColeta);
    const timestampSegundos = Number.isFinite(timestampMs) && timestampMs > 0
        ? timestampMs / 1000
        : Date.now() / 1000;

    const placeholders = estado.robosInscritos.map(() => '(?,?,?,?,?,?,?,FROM_UNIXTIME(?))').join(',');
    const params = [];

    for (const robo of estado.robosInscritos) {
        params.push(
            mesaRuntime.id,
            robo.id,
            est.id,
            tipoResultado,
            nivelHistoricoResultado(galeAtual),
            multiplicador || '',
            est.origem || '',
            timestampSegundos
        );
    }

    await dbPool.query(
        `INSERT INTO historico_disparos_robos
            (mesa_id, robo_id, estrategia_id, tipo_resultado, nivel, multiplicador, estrategia_origem, data_hora)
         VALUES ${placeholders}`,
        params
    );
}

function avaliarStopRedsAutoTrader(trader, tipoResultado, agora = Date.now()) {
    const cf = (trader && trader.config) || {};
    const limite = Math.max(0, Math.trunc(Number(cf.stop_reds_seguidos) || 0));
    const redsAtuais = Math.max(0, Math.trunc(Number(trader && trader.reds_consecutivos) || 0));
    const tipo = String(tipoResultado || '').toUpperCase();

    if (!['GREEN', 'TIE', 'RED'].includes(tipo)) {
        return {
            reds_consecutivos: redsAtuais,
            acao: null,
            status_operacao: null,
            stop_reds_pausado_ate: Math.max(0, Number(trader && trader.stop_reds_pausado_ate) || 0),
            pausa_min: 0
        };
    }

    if (tipo !== 'RED') {
        return {
            reds_consecutivos: 0,
            acao: null,
            status_operacao: null,
            stop_reds_pausado_ate: 0,
            pausa_min: 0
        };
    }

    if (limite <= 0) {
        return {
            reds_consecutivos: 0,
            acao: null,
            status_operacao: null,
            stop_reds_pausado_ate: 0,
            pausa_min: 0
        };
    }

    const proximosReds = redsAtuais + 1;
    if (proximosReds < limite) {
        return {
            reds_consecutivos: proximosReds,
            acao: null,
            status_operacao: null,
            stop_reds_pausado_ate: 0,
            pausa_min: 0
        };
    }

    const acaoConfigurada = String(cf.stop_reds_acao || 'PAUSAR').toUpperCase();
    if (acaoConfigurada === 'DESLIGAR') {
        return {
            reds_consecutivos: proximosReds,
            acao: 'DESLIGAR',
            status_operacao: 'STOP_REDS',
            stop_reds_pausado_ate: 0,
            pausa_min: 0
        };
    }

    const pausaMin = Math.max(1, Math.trunc(Number(cf.stop_reds_pausa_min) || 60));
    const agoraNumerico = Number(agora);
    const agoraMs = Number.isFinite(agoraNumerico) && agoraNumerico > 0
        ? Math.trunc(agoraNumerico)
        : Date.now();

    return {
        reds_consecutivos: 0,
        acao: 'PAUSAR',
        status_operacao: 'STOP_REDS_PAUSA',
        stop_reds_pausado_ate: agoraMs + (pausaMin * 60 * 1000),
        pausa_min: pausaMin
    };
}

function aplicarEstadoStopRedsTraderEmMemoria(trader, avaliacao) {
    trader.reds_consecutivos = Math.max(0, Number(avaliacao.reds_consecutivos) || 0);
    trader.stop_reds_pausado_ate = Math.max(0, Number(avaliacao.stop_reds_pausado_ate) || 0);

    if (avaliacao.acao === 'PAUSAR') {
        trader.status_operacao = 'STOP_REDS_PAUSA';
    } else if (avaliacao.acao === 'DESLIGAR') {
        trader.ativo = false;
        trader.status_operacao = 'STOP_REDS';
    }
}

async function processarResultadoStopRedsAutoTrader(trader, tipoResultado, timestampResultado) {
    const mesaId = mesaIdFinanceiroTrader(
        trader,
        'processar Stop Reds'
    );

    const avaliacao = avaliarStopRedsAutoTrader(trader, tipoResultado, timestampResultado);
    const redsAnteriores = Math.max(0, Number(trader.reds_consecutivos) || 0);
    const pausaAnterior = Math.max(0, Number(trader.stop_reds_pausado_ate) || 0);
    const mudouContador = redsAnteriores !== avaliacao.reds_consecutivos;
    const mudouPausa = pausaAnterior !== avaliacao.stop_reds_pausado_ate;

    if (!avaliacao.acao && !mudouContador && !mudouPausa) {
        return avaliacao;
    }

    try {
        if (avaliacao.acao === 'DESLIGAR') {
            await dbPool.query(
                `UPDATE auto_traders
                 SET ativo=false, status_operacao='STOP_REDS', reds_consecutivos=?, stop_reds_pausado_ate=0
                 WHERE id=? AND mesa_id=?`,
                [avaliacao.reds_consecutivos, trader.id, mesaId]
            );
        } else if (avaliacao.acao === 'PAUSAR') {
            await dbPool.query(
                `UPDATE auto_traders
                 SET status_operacao='STOP_REDS_PAUSA', reds_consecutivos=0, stop_reds_pausado_ate=?
                 WHERE id=? AND mesa_id=?`,
                [avaliacao.stop_reds_pausado_ate, trader.id, mesaId]
            );
        } else {
            await dbPool.query(
                `UPDATE auto_traders
                 SET reds_consecutivos=?, stop_reds_pausado_ate=0
                 WHERE id=? AND mesa_id=?`,
                [avaliacao.reds_consecutivos, trader.id, mesaId]
            );
        }

        aplicarEstadoStopRedsTraderEmMemoria(trader, avaliacao);
    } catch (e) {
        aplicarEstadoStopRedsTraderEmMemoria(trader, avaliacao);
        console.error(
            `Falha ao persistir Stop Reds do Auto-Trader ${trader.id}; estado conservador mantido em memoria:`,
            e.message
        );
    }

    if (avaliacao.acao === 'PAUSAR') {
        console.log(
            `Auto-Trader ${trader.id}: Stop Reds atingido. Pausado por ${avaliacao.pausa_min} minuto(s).`
        );
    } else if (avaliacao.acao === 'DESLIGAR') {
        console.log(
            `Auto-Trader ${trader.id}: Stop Reds atingido. Motor desligado ate reativacao manual.`
        );
    }

    ioServer.emit('atualizar_interface');
    return avaliacao;
}

async function rearmarAutoTradersStopRedsPausados(agora = Date.now()) {
    const mesaId = Number(
        obterMesaRuntime().id
    );

    const agoraMs = Number(agora);
    const referencia = Number.isFinite(agoraMs) && agoraMs > 0 ? Math.trunc(agoraMs) : Date.now();
    const prontos = AUTO_TRADERS_MEMORIA.filter(trader => {
        const pausaAte = Math.max(0, Number(trader.stop_reds_pausado_ate) || 0);
        return trader.ativo
            && trader.status_operacao === 'STOP_REDS_PAUSA'
            && pausaAte > 0
            && pausaAte <= referencia;
    });

    if (prontos.length === 0) return 0;

    const ids = prontos.map(trader => trader.id);
    const placeholders = ids.map(() => '?').join(',');

    const [resultadoRearme] = await dbPool.query(
        `UPDATE auto_traders
         SET status_operacao='STANDBY',
             reds_consecutivos=0,
             stop_reds_pausado_ate=0
         WHERE mesa_id=?
           AND ativo=true
           AND status_operacao='STOP_REDS_PAUSA'
           AND id IN (${placeholders})`,
        [mesaId, ...ids]
    );

    if (
        Number(resultadoRearme.affectedRows)
        !== ids.length
    ) {
        throw new Error(
            'MC22-X: rearmamento Stop Reds incompleto na mesa runtime'
        );
    }

    for (const trader of prontos) {
        trader.status_operacao = 'STANDBY';
        trader.reds_consecutivos = 0;
        trader.stop_reds_pausado_ate = 0;
    }

    console.log(`${prontos.length} Auto-Trader(s) rearmado(s) apos pausa de Stop Reds.`);
    ioServer.emit('atualizar_interface');
    return prontos.length;
}

function avaliarTrailingStopTrader(trader, variacao) {
    const cf = (trader && trader.config) || {};
    const trailingAtivo = cf.trailing_stop === true;
    const recuoBruto = Number(cf.trailing_recuo);
    const lucroBruto = Number(variacao);
    const picoAnteriorBruto = Math.max(0, Number(trader && trader.trailing_pico_lucro) || 0);
    const picoAnterior = Math.round(picoAnteriorBruto * 100) / 100;

    if (
        !trailingAtivo
        || !Number.isFinite(recuoBruto)
        || recuoBruto <= 0
        || !Number.isFinite(lucroBruto)
    ) {
        return {
            acionado: false,
            pico_lucro: picoAnterior,
            limite_disparo: null,
            recuo: Number.isFinite(recuoBruto) && recuoBruto > 0
                ? Math.round(recuoBruto * 100) / 100
                : 0
        };
    }

    const recuo = Math.round(recuoBruto * 100) / 100;
    const lucroAtual = Math.round(lucroBruto * 100) / 100;
    const picoLido = lucroAtual > 0 ? lucroAtual : 0;
    const picoLucro = Math.max(picoAnterior, picoLido);

    if (picoLucro <= 0) {
        return {
            acionado: false,
            pico_lucro: 0,
            limite_disparo: null,
            recuo
        };
    }

    const limiteDisparo = Math.round((picoLucro - recuo) * 100) / 100;
    return {
        acionado: lucroAtual <= limiteDisparo,
        pico_lucro: picoLucro,
        limite_disparo: limiteDisparo,
        recuo
    };
}

function avaliarLimitesFinanceirosTrader(trader, snapshotSaldo) {
    const snapshot = snapshotSaldo || {};
    const saldoInicial = Number(trader && trader.saldo_inicial);
    const saldoAtual = Number(snapshot.saldo_atual);
    const picoAnterior = Math.max(0, Number(trader && trader.trailing_pico_lucro) || 0);

    if (
        snapshot.fresco !== true
        || !Number.isFinite(saldoInicial)
        || saldoInicial < 0
        || !Number.isFinite(saldoAtual)
        || saldoAtual < 0
    ) {
        return {
            permitido: false,
            motivo: 'SALDO_INDISPONIVEL',
            variacao: null,
            saldo_atual: Number.isFinite(saldoAtual) ? saldoAtual : null,
            trailing_pico_lucro: picoAnterior,
            trailing_limite_disparo: null,
            trailing_recuo: 0
        };
    }

    const cf = (trader && trader.config) || {};
    const stopWin = Number(cf.stop_win ?? 100);
    const stopLoss = Number(cf.stop_loss ?? 250);
    const variacao = Math.round((saldoAtual - saldoInicial) * 100) / 100;
    const trailing = avaliarTrailingStopTrader(trader, variacao);

    const baseResultado = {
        variacao,
        saldo_atual: saldoAtual,
        trailing_pico_lucro: trailing.pico_lucro,
        trailing_limite_disparo: trailing.limite_disparo,
        trailing_recuo: trailing.recuo
    };

    if (Number.isFinite(stopWin) && stopWin > 0 && variacao >= stopWin) {
        return { permitido: false, motivo: 'STOP_WIN', ...baseResultado };
    }

    if (Number.isFinite(stopLoss) && stopLoss > 0 && variacao <= -stopLoss) {
        return { permitido: false, motivo: 'STOP_LOSS', ...baseResultado };
    }

    if (trailing.acionado) {
        return { permitido: false, motivo: 'TRAILING_STOP', ...baseResultado };
    }

    return { permitido: true, motivo: null, ...baseResultado };
}

async function traderPossuiLiquidacaoPendente(traderId) {
    const mesaRuntime = obterMesaRuntime();
    const [linhas] = await dbPool.query(
        `SELECT id
         FROM auditoria_ordens
         WHERE trader_id=?
           AND mesa_id=?
           AND status_ordem IN ('WIN','LOSS','TIE')
           AND resultado_confirmado_em IS NOT NULL
           AND saldo_pos_confirmado_em IS NULL
         ORDER BY id DESC
         LIMIT 1`,
        [traderId, mesaRuntime.id]
    );
    return linhas.length > 0;
}

async function confirmarSaldosPosLiquidacao(saldo, sincronizadoEm = Date.now()) {
    const mesaRuntime = obterMesaRuntime();
    const saldoNumero = Number(saldo);
    const syncMs = Number(sincronizadoEm);
    if (
        !Number.isFinite(saldoNumero)
        || saldoNumero < 0
        || !Number.isFinite(syncMs)
        || syncMs <= 0
    ) {
        return 0;
    }

    const syncConfirmadoEm = Math.trunc(syncMs);
    const [linhas] = await dbPool.query(
        `SELECT id
         FROM auditoria_ordens
         WHERE mesa_id=?
           AND status_ordem IN ('WIN','LOSS','TIE')
           AND resultado_confirmado_em IS NOT NULL
           AND resultado_confirmado_em < ?
           AND saldo_pos_confirmado_em IS NULL
         ORDER BY id ASC`,
        [mesaRuntime.id, syncConfirmadoEm]
    );

    const ids = linhas
        .map(row => Number(row.id))
        .filter(Number.isInteger);
    if (ids.length === 0) return 0;

    const placeholders = ids.map(() => '?').join(',');
    const [resultado] = await dbPool.query(
        `UPDATE auditoria_ordens
         SET saldo_pos=?, saldo_pos_confirmado_em=?
         WHERE id IN (${placeholders})
           AND mesa_id=?
           AND saldo_pos_confirmado_em IS NULL
           AND resultado_confirmado_em < ?`,
        [saldoNumero, syncConfirmadoEm, ...ids, mesaRuntime.id, syncConfirmadoEm]
    );

    const confirmadas = Math.max(0, Number(resultado.affectedRows) || 0);
    if (confirmadas > 0) {
        console.log(
            `✅ BUG-051A: ${confirmadas} liquidação(ões) confirmada(s) `
            + `com saldo sincronizado posterior ao resultado.`
        );
    }
    return confirmadas;
}

async function autorizarNovaEntradaFinanceiraTrader(trader) {
    const mesaId = mesaIdFinanceiroTrader(
        trader,
        'autorizar nova entrada'
    );

    if (!(await integracaoContadorDiario.garantirAntesDaEntrada(trader))) {
        return false;
    }

    if (arbitroFinanceiroAutoTrader) {
        const abertas = await arbitroFinanceiroAutoTrader.listarOrdensFinanceirasEmAbertoTrader(trader.id);
        if (abertas.length > 0) {
            console.warn(`⛔ MC21 SINGLE-FLIGHT | Trader ${trader.id}: nova entrada bloqueada por ordem/intenção financeira aberta.`);
            return false;
        }
    }

    if (await traderPossuiLiquidacaoPendente(trader.id)) {
        console.warn(
            `⛔ BUG-051A Trader ${trader.id}: nova entrada bloqueada; `
            + `saldo real após liquidação ainda NÃO CONFIRMADO.`
        );
        return false;
    }

    const avaliacao = avaliarLimitesFinanceirosTrader(trader, snapshotSaldoGlobal());

    if (avaliacao.motivo === 'SALDO_INDISPONIVEL') {
        console.warn(`⚠️ Trader ${trader.id}: nova entrada bloqueada porque o saldo global está ausente ou desatualizado.`);
        return false;
    }

    const picoAnterior = Math.max(0, Number(trader.trailing_pico_lucro) || 0);
    const picoAvaliado = Math.max(0, Number(avaliacao.trailing_pico_lucro) || 0);

    if (picoAvaliado > picoAnterior) {
        try {
            await dbPool.query(
                'UPDATE auto_traders SET trailing_pico_lucro=? WHERE id=? AND mesa_id=?',
                [picoAvaliado, trader.id, mesaId]
            );
            trader.trailing_pico_lucro = picoAvaliado;
        } catch (e) {
            console.error(
                `⚠️ Trader ${trader.id}: falha ao persistir novo pico do Trailing Stop; nova entrada bloqueada:`,
                e.message
            );
            return false;
        }
    }

    if (avaliacao.permitido) return true;

    trader.ativo = false;
    trader.status_operacao = avaliacao.motivo;
    if (Number.isFinite(avaliacao.saldo_atual)) {
        trader.saldo_atual = avaliacao.saldo_atual;
    }

    try {
        await dbPool.query(
            'UPDATE auto_traders SET ativo=false, status_operacao=?, saldo_atual=? WHERE id=? AND mesa_id=?',
            [avaliacao.motivo, trader.saldo_atual, trader.id, mesaId]
        );
    } catch (e) {
        console.error(`❌ Falha ao persistir ${avaliacao.motivo} do trader ${trader.id}:`, e.message);
    }

    if (avaliacao.motivo === 'STOP_WIN') {
        const valor = Math.abs(Number(avaliacao.variacao) || 0).toFixed(2);
        console.log(
            `🏁 Trader ${trader.id}: Stop Win atingido (+R$ ${valor}). Motor desligado até reativação manual.`
        );
    } else if (avaliacao.motivo === 'STOP_LOSS') {
        const valor = Math.abs(Number(avaliacao.variacao) || 0).toFixed(2);
        console.log(
            `🛑 Trader ${trader.id}: Stop Loss atingido (-R$ ${valor}). Motor desligado até reativação manual.`
        );
    } else {
        const lucroAtual = Number(avaliacao.variacao) || 0;
        const pico = Math.max(0, Number(avaliacao.trailing_pico_lucro) || 0);
        const recuo = Math.max(0, Number(avaliacao.trailing_recuo) || 0);
        console.log(
            `🛡️ Trader ${trader.id}: Trailing Stop acionado em R$ ${lucroAtual.toFixed(2)} `
            + `após pico de R$ ${pico.toFixed(2)} e recuo configurado de R$ ${recuo.toFixed(2)}. `
            + `Motor desligado até reativação manual.`
        );
    }

    ioServer.emit('atualizar_interface');
    return false;
}

arbitroFinanceiroAutoTrader = criarArbitroFinanceiroAutoTrader({
    dbPool,
    crypto,
    log: console,
    listarTraders: () => AUTO_TRADERS_MEMORIA,
    autoTraderParticipouDoSinal,
    traderDentroHorarioExecucao,
    formatarFaixasHorario,
    prepararEntradaCicloAutoTrader,
    autorizarNovaEntradaFinanceiraTrader,
    calcularPlanoAposta,
    criarIntencaoOrdem,
    enviarOrdemAoExecutor,
    marcarIntencaoAposFalhaEnvio,
    bloquearTraderAposExecucaoAmbigua
});

async function carregarSistemasParaMemoria() {
    try {
        const mesaRuntime = obterMesaRuntime();
        const mesaId = Number(mesaRuntime.id);

        if (!Number.isInteger(mesaId) || mesaId <= 0) {
            throw new Error(
                'MC22-W-A: mesa runtime invalida ao carregar memoria'
            );
        }

        const [linhasEst] = await dbPool.query(
            'SELECT * FROM estrategias WHERE mesa_id=? AND ativo=true',
            [mesaId]
        );
        ESTRATEGIAS_MEMORIA = []; let novoEstado = {};

        linhasEst.forEach(db => {
            let padraoParsed = []; try { padraoParsed = JSON.parse(db.padrao); } catch(e) {}
            let tiesParsed = { direto:{}, gale1:{}, gale2:{} }; if (db.ties_json) { try { tiesParsed = JSON.parse(db.ties_json); } catch(e) {} }

            let est = {
                id: db.id, mesa_id: Number(db.mesa_id), nome: db.nome, origem: db.origem, padrao: padraoParsed, entrada: db.entrada,
                gales: db.gales, protegerEmpate: db.proteger_empate === 1, ativo: true, is_dinamico: db.is_dinamico === 1,
                robo_dono_id: db.robo_dono_id, quarentena_restante: db.quarentena_restante || 0,
                stats: { greenDireto: db.green_direto, gale1: db.gale1, gale2: db.gale2, red: db.red, ties: tiesParsed }
            };
            ESTRATEGIAS_MEMORIA.push(est);
            novoEstado[est.id] = estadoApostas[est.id] || { aguardandoResultado: false, galeAtual: 0, robosCiclo: [], robosInscritos: [], mensagensEntrada: [], mensagensGale: [] };
        });
        estadoApostas = novoEstado;
        sincronizarLocksSinalComEstadoApostas();

        const [linhasRobos] = await dbPool.query(
            'SELECT * FROM robos_canais WHERE mesa_id=? AND ativo=true',
            [mesaId]
        );

        const [destinatariosRobos] = await dbPool.query(
            `SELECT
                d.robo_id,
                d.nome_cliente,
                d.chat_id
             FROM destinatarios_robo d
             JOIN robos_canais r
               ON r.id=d.robo_id
             WHERE r.mesa_id=?
               AND r.ativo=true`,
            [mesaId]
        );

        ROBOS_MEMORIA = linhasRobos.map(r => {
            let confObj = { origens: [], avulsos: [], excecoes: [], auto_tuning: { ativo: false }, cooldown: { ativo: false } };
            try { if (r.config_json) confObj = { ...confObj, ...JSON.parse(r.config_json) }; } catch(err){}

            if (!estadoStandbyRobos[r.id]) {
                let historicoReds = [];
                try {
                    const parseado = JSON.parse(r.historico_reds_json || '[]');
                    if (Array.isArray(parseado)) historicoReds = parseado.map(Number).filter(Number.isFinite);
                } catch (e) {}

                estadoStandbyRobos[r.id] = {
                    em_standby_ate: Math.max(0, Number(r.standby_ate) || 0),
                    historico_reds: historicoReds
                };
            }

            const destinatarios = destinatariosRobos.filter(d => Number(d.robo_id) === Number(r.id));
            return { ...r, config: confObj, destinatarios };
        });

        const [linhasAT] = await dbPool.query(
            'SELECT * FROM auto_traders WHERE mesa_id=?',
            [mesaId]
        );
        AUTO_TRADERS_MEMORIA = linhasAT.map(at => {
            let cfg = {}; try { cfg = JSON.parse(at.config_json); } catch(e) {}
            cfg = normalizarConfigAutoTrader(cfg);
            const estadoCiclo = normalizarEstadoCiclo(at);
            return {
                id: at.id, mesa_id: Number(at.mesa_id), nome: at.nome, ativo: at.ativo === 1, config: cfg,
                saldo_inicial: parseFloat(at.saldo_inicial), saldo_atual: parseFloat(at.saldo_atual),
                status_operacao: at.status_operacao, entradas_feitas: at.entradas_feitas, pulos_restantes: estadoCiclo.pulos_restantes,
                estado_ciclo: estadoCiclo.estado_ciclo,
                reds_virtuais_observados: estadoCiclo.reds_virtuais_observados,
                sinais_operados_onda: estadoCiclo.sinais_operados_onda,
                ciclos_concluidos: estadoCiclo.ciclos_concluidos,
                data_contador_entradas: String(at.data_contador_entradas || ''),
                reds_consecutivos: Math.max(0, Number(at.reds_consecutivos) || 0),
                stop_reds_pausado_ate: Math.max(0, Number(at.stop_reds_pausado_ate) || 0),
                trailing_pico_lucro: Math.max(0, Number(at.trailing_pico_lucro) || 0)
            };
        });

        // 🌟 LOGS DETALHADOS RESTAURADOS NA INICIALIZAÇÃO
        console.log(`\n📂 MEMÓRIA ALOCADA COM SUCESSO:`);
        console.log(`   - Estratégias Ativas: ${ESTRATEGIAS_MEMORIA.length}`);
        console.log(`   - Robôs de Canal: ${ROBOS_MEMORIA.length}`);
        console.log(`   - Motores Auto-Trader: ${AUTO_TRADERS_MEMORIA.length}\n`);
    } catch (e) {
        console.error("❌ Erro ao carregar memória:", e.message);
        throw e;
    }
}

app.post("/executor-status", (req, res) => {
    if (!requisicaoInternaAutorizada(req)) {
        return res.status(401).json({ erro: "Nao autorizado" });
    }

    const dados = req.body || {};
    const orderId = String(dados.order_id || '').trim().toLowerCase();
    const statusRecebido = String(dados.status || '').trim().toUpperCase();

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(orderId)) {
        return res.status(400).json({ erro: 'order_id invalido' });
    }
    if (!STATUS_EXECUTOR_VALIDOS.has(statusRecebido)) {
        return res.status(400).json({ erro: 'status_executor_invalido' });
    }

    const validacao = normalizarConfirmacaoExecucao(statusRecebido, dados.confirmacao);
    const status = validacao.status;
    const motivo = validacao.motivo || dados.motivo;
    if (statusRecebido === 'EXECUTADA' && status !== 'EXECUTADA') {
        console.error(`🚨 Callback EXECUTADA de ${orderId} rebaixado para AMBIGUA: ${validacao.motivo}.`);
    }

    const entregue = registrarResultadoExecucaoExecutor({
        order_id: orderId,
        status,
        motivo,
        confirmacao: validacao.confirmacao
    });

    if (!entregue) {
        console.warn(`⚠️ Callback órfão do executor para ${orderId} (${status}); auditoria não foi promovida automaticamente.`);
    }

    return res.json({ recebido: true, orfa: !entregue });
});

app.post("/collector-health", async (req, res) => {
    let liberarTurnoResultado = null;
    try {
        if (!requisicaoInternaAutorizada(req)) {
            return res.status(401).json({ erro: "Nao autorizado" });
        }

        const dados = req.body || {};
        const mesaRuntimeSaude = obterMesaRuntime();
        const mesaCodigoSaude =
            String(dados.mesa_codigo || '')
                .trim()
                .toUpperCase();

        if (
            !mesaCodigoSaude
            || mesaCodigoSaude !== mesaRuntimeSaude.codigo
        ) {
            return res.status(409).json({
                erro: 'collector-health pertence a outra mesa'
            });
        }

        if (String(dados.evento || '').trim().toUpperCase() !== 'INTERRUPCAO') {
            return res.status(400).json({ erro: "evento de saude invalido" });
        }

        const motivo = String(dados.motivo || 'INTERRUPCAO_COLETOR').trim().slice(0, 120) || 'INTERRUPCAO_COLETOR';
        const reservaInterrupcao = reservarInterrupcaoColetor(dados);
        if (reservaInterrupcao.repetida) {
            if (reservaInterrupcao.estado === 'PROCESSANDO') {
                return res.status(503).json({
                    recebido: false,
                    continuidade: 'INVALIDACAO_EM_ANDAMENTO',
                    idempotente: true,
                    interrupcao_id: reservaInterrupcao.id
                });
            }
            return res.json({
                recebido: true,
                continuidade: 'INVALIDADA_ANTERIORMENTE',
                idempotente: true,
                interrupcao_id: reservaInterrupcao.id,
                sinais_invalidados: 0,
                traders_bloqueados: 0
            });
        }
        liberarTurnoResultado = await aguardarTurnoProcessamentoResultado();
        try {
            const resumo = await invalidarSequenciasAposBuracoDados(motivo);
            concluirInterrupcaoColetor(reservaInterrupcao.id, true);
            return res.json({
                recebido: true,
                continuidade: 'INVALIDADA',
                idempotente: false,
                interrupcao_id: reservaInterrupcao.id || null,
                ...resumo
            });
        } catch (e) {
            concluirInterrupcaoColetor(reservaInterrupcao.id, false);
            throw e;
        }
    } catch (e) {
        console.error("❌ Falha ao tratar interrupção imediata do coletor:", e.message);
        if (!res.headersSent) return res.status(500).json({ erro: "falha ao invalidar continuidade" });
    } finally {
        if (liberarTurnoResultado) liberarTurnoResultado();
    }
});

app.post("/receber-sinal", async (req, res) => {
    let liberarTurnoResultado = null;
    try {
        if (!requisicaoInternaAutorizada(req)) {
            return res.status(401).json({ erro: "Nao autorizado" });
        }

        const dados = req.body || {};

        let rawVenc = String(dados.vencedor || dados.resultado || dados.winner || "").toUpperCase().trim();
        let vencedor = "";
        if (rawVenc.includes("PLAYER") || rawVenc === "P" || rawVenc === "AZUL") vencedor = "Player";
        else if (rawVenc.includes("BANKER") || rawVenc === "B" || rawVenc === "VERMELHO") vencedor = "Banker";
        else if (rawVenc.includes("TIE") || rawVenc === "T" || rawVenc === "EMPATE") vencedor = "Tie";

        // Reserva a continuidade antes de qualquer await (inclusive persistência de saldo).
        // O processamento financeiro continua abaixo, serializado após o ACK.
        const continuidade = vencedor ? reservarContinuidadeResultado(dados) : null;

        const temSaldo = dados.saldo_atual !== undefined && dados.saldo_atual !== null;

        if (temSaldo) {
            const saldoRecebido = Number(dados.saldo_atual);

            if (!Number.isFinite(saldoRecebido) || saldoRecebido < 0) {
                console.warn("⚠️ saldo_atual inválido recebido do executor; atualização ignorada.");
                if (!vencedor) return res.status(400).json({ erro: "saldo_atual invalido" });
            } else {
                try {
                    const mesaSaldoRecebido =
                        afirmarMesaFinanceiraAutorizada(
                            'balance_update_http'
                        );

                    await dbPool.query(
                        'UPDATE auto_traders SET saldo_atual=? WHERE ativo=true AND mesa_id=?',
                        [
                            saldoRecebido,
                            mesaSaldoRecebido.id
                        ]
                    );

                    saldoGlobalCorretora = saldoRecebido;
                    saldoGlobalAtualizadoEm = Date.now();
                    await confirmarSaldosPosLiquidacao(
                        saldoRecebido,
                        saldoGlobalAtualizadoEm
                    );
                    for (let trader of AUTO_TRADERS_MEMORIA) {
                        if (trader.ativo) trader.saldo_atual = saldoRecebido;
                    }
                } catch (e) {
                    console.error("⚠️ Falha ao persistir saldo sincronizado dos Auto-Traders:", e.message);
                    if (!vencedor) return res.status(500).json({ erro: "falha ao persistir saldo" });
                }
            }
        }

        if (!vencedor) return res.json({ recebido: true, saldo_atual: saldoGlobalCorretora });

        if (!continuidade || !continuidade.aceitar) {
            console.warn(`⚠️ Resultado ${continuidade.motivo === 'DUPLICADO' ? 'duplicado' : 'fora de ordem'} ignorado pelo Node (sessão=${dados.coletor_sessao || 'n/a'}, seq=${dados.coletor_seq || 'n/a'}).`);
            return res.json({ recebido: true, ignorado: true, motivo: continuidade.motivo });
        }

        res.json({ recebido: true });

        // ACK continua rápido; somente o trabalho pós-ACK espera sua vez FIFO.
        liberarTurnoResultado = await aguardarTurnoProcessamentoResultado();

        if (continuidade.interrupcao) {
            const motivoInterrupcao = String(
                dados.motivo_interrupcao || continuidade.motivo || 'INTERRUPCAO_PYTHON'
            ).trim().slice(0, 120) || 'INTERRUPCAO_PYTHON';
            const dadosInterrupcao = { ...dados, interrupcao_fluxo: true, motivo_interrupcao: motivoInterrupcao };
            rotacionarSessaoAposInterrupcao(dadosInterrupcao);
            if (interrupcaoColetorJaAplicada(dados)) {
                console.log(
                    `♻️ Interrupção ${normalizarInterrupcaoColetorId(dados)} já aplicada via collector-health; `
                    + 'o primeiro resultado apenas estabelece a nova fronteira estatística.'
                );
            } else {
                const reservaInterrupcao = reservarInterrupcaoColetor(dados);
                try {
                    await invalidarSequenciasAposBuracoDados(motivoInterrupcao);
                    concluirInterrupcaoColetor(reservaInterrupcao.id, true);
                } catch (e) {
                    concluirInterrupcaoColetor(reservaInterrupcao.id, false);
                    throw e;
                }
            }
        }

        // Só avança a continuidade depois que qualquer interrupção foi tratada em modo fail-closed.
        estadoContinuidadeColetor = continuidade.estado;

        try {
            await rearmarAutoTradersStopRedsPausados();
        } catch (e) {
            console.error("Falha ao rearmar Auto-Trader apos pausa de Stop Reds:", e.message);
        }

        try {
            await integracaoContadorDiario.processarViradaDiaria();
        } catch (e) {
            console.error("BUG-051B: falha ao processar a virada diaria dos Auto-Traders:", e.message);
        }

        try {
            await ativarAutoTradersAguardandoMesa();
        } catch (e) {
            console.error("⚠️ Falha ao promover Auto-Trader de STANDBY para OPERANDO:", e.message);
        }

        let p1 = (dados.dados_jogador && dados.dados_jogador.length > 0) ? parseInt(dados.dados_jogador[0]) : 0;
        let p2 = (dados.dados_jogador && dados.dados_jogador.length > 1) ? parseInt(dados.dados_jogador[1]) : 0;
        let b1 = (dados.dados_banca && dados.dados_banca.length > 0) ? parseInt(dados.dados_banca[0]) : 0;
        let b2 = (dados.dados_banca && dados.dados_banca.length > 1) ? parseInt(dados.dados_banca[1]) : 0;
        let nEmp = 0; let mult = "";

        if (vencedor === "Tie") {
            nEmp = parseInt(dados.pontos_jogador); if (isNaN(nEmp) || nEmp === 0) nEmp = p1 + p2;
            if (nEmp === 2 || nEmp === 12) mult = "88x"; else if (nEmp === 3 || nEmp === 11) mult = "25x"; else if (nEmp === 4 || nEmp === 10) mult = "10x"; else if (nEmp === 5 || nEmp === 9) mult = "6x"; else mult = "4x";
        }

        // 🌟 LOG DETALHADO DO VENCEDOR RESTAURADO NO TERMINAL
        let logNomeVencedor = vencedor === "Player" ? "🔵 JOGADOR" : (vencedor === "Banker" ? "🔴 BANCA" : `🟡 EMPATE (${mult})`);
        let totalP = (p1 + p2).toString().padStart(2, '0'); let totalB = (b1 + b2).toString().padStart(2, '0');
        console.log(`\n====================================\n🔥 Vencedor: ${logNomeVencedor}\n🔵 Jogador : ${totalP} | 🔴 Banca: ${totalB}\n====================================\n`);

        // Cursor live independente do banco: toda rodada aceita pelo pipeline
        // avança exatamente uma posição.
        contadorRodadasSinal++;

        let giroPersistidoParaIA = false;
        let giroIdPersistidoParaIA = 0;
        try {
            const timestampColetaNumero = Number(dados.timestamp_coleta);
            const timestampGiroAnalitico = Number.isFinite(timestampColetaNumero) && timestampColetaNumero > 0
                ? timestampColetaNumero
                : Date.now();
            const mesaRuntimeGiro = obterMesaRuntime();
            const [resultadoInsertGiro] = await dbPool.query(
                `INSERT INTO giros_recentes
                    (mesa_id, resultado, p_d1, p_d2, b_d1, b_d2, numero_empate, multiplicador, id_sessao, data_hora)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?))`,
                [
                    mesaRuntimeGiro.id,
                    vencedor,
                    p1,
                    p2,
                    b1,
                    b2,
                    nEmp,
                    mult,
                    idSessaoContinua,
                    timestampGiroAnalitico / 1000
                ]
            );
            giroIdPersistidoParaIA = Number(resultadoInsertGiro.insertId) || 0;
            historicoGirosAnalitico.push({
                id: giroIdPersistidoParaIA,
                resultado: vencedor,
                multiplicador: mult || '',
                id_sessao: idSessaoContinua,
                timestamp_ms: timestampGiroAnalitico
            });
            giroPersistidoParaIA = true;
        } catch(e) {
            console.error('❌ Falha ao persistir giro recente:', e.message);
        }

        if (giroPersistidoParaIA && giroIdPersistidoParaIA > 0) {
            try {
                await autoPilotIA.registrarNovoGiro({ giro_id: giroIdPersistidoParaIA });
            } catch (e) {
                console.error('⚠️ Auto Pilot IA: mineração periódica falhou sem interromper a rodada:', e.message);
            }
        }

        for (let est of ESTRATEGIAS_MEMORIA) {
            let st = estadoApostas[est.id];
            if (st && st.aguardandoResultado) {
                if (
                    !estadoSinalComLocksConsistentes(
                        est.id,
                        st
                    )
                ) {
                    invalidarEstadoSinalInconsistente(
                        est.id,
                        st
                    );

                    continue;
                }

                let finalizar = false;
                let isTie = (vencedor==='Tie');

                if (vencedor === est.entrada || (isTie && est.protegerEmpate)) {
                    if (!isTie) {
                        if (st.galeAtual===0) est.stats.greenDireto++; else if (st.galeAtual===1) est.stats.gale1++; else est.stats.gale2++;
                    } else {
                        let tL = st.galeAtual===0?'direto':(st.galeAtual===1?'gale1':'gale2');
                        if (!est.stats.ties[tL][mult]) est.stats.ties[tL][mult]=0; est.stats.ties[tL][mult]++;
                    }

                    try {
                        await registrarHistoricoResultadoEstrategia(est, isTie ? 'TIE' : 'GREEN', st.galeAtual, isTie ? mult : '', dados.timestamp_coleta);
                    } catch (e) {
                        console.error(`Falha ao persistir historico da estrategia ${est.id}:`, e.message);
                    }

                    await aguardarInscricaoTelegram(st);

                    try {
                        await registrarHistoricoRobosInscritos(est, st, isTie ? 'TIE' : 'GREEN', st.galeAtual, isTie ? mult : '', dados.timestamp_coleta);
                    } catch (e) {
                        console.error(`Falha ao persistir historico dos robos para estrategia ${est.id}:`, e.message);
                    }

                    try {
                        await processarResultadoProtecaoRobos(st, isTie ? 'TIE' : 'GREEN', dados.timestamp_coleta);
                    } catch (e) {
                        console.error(`Falha ao atualizar proteção dos robôs da estratégia ${est.id}:`, e.message);
                    }

                    const extrasFinal = {
                        resultado: isTie ? 'TIE' : 'GREEN',
                        multiplicador: isTie ? mult : ''
                    };
                    emitirAlertaWebRobo('GREEN', est, st, extrasFinal);
                    void enviarTelegramParaInscritos('GREEN', est, st, extrasFinal).catch(e => {
                        console.error(`⚠️ Falha inesperada no envio Telegram GREEN da estratégia ${est.id}:`, e.message);
                    });

                    try {
                        await processarResultadoVirtualAutoTraders(est, st, isTie ? 'TIE' : 'GREEN');
                    } catch (e) {
                        console.error(`⚠️ Auto-Trader: falha ao processar resultado virtual ${isTie ? 'TIE' : 'GREEN'} de ${est.id}:`, e.message);
                    }

                    if (est.quarentena_restante <= 0) {
                        for (let trader of AUTO_TRADERS_MEMORIA) {
                            let cf = trader.config;
                            if (trader.ativo && (trader.status_operacao === 'OPERANDO' || trader.status_operacao === 'STANDBY') && autoTraderAutorizaEstrategia(cf, est, ROBOS_MEMORIA)) {
                                const [pendentes] = await dbPool.query(`SELECT id, valor_entrada, valor_empate FROM auditoria_ordens WHERE trader_id = ? AND estrategia_id = ? AND mesa_id = ? AND status_ordem = 'PENDENTE' LIMIT 1`, [trader.id, est.id, Number(dados.mesa_id)]);
                                if (pendentes.length > 0) {
                                    let vEntrada = parseFloat(pendentes[0].valor_entrada);
                                    let vEmpate = Math.max(0, Number(pendentes[0].valor_empate) || 0);
                                    let vLucro = calcularPnLEtapa({
                                        resultado: vencedor,
                                        alvoPrincipal: est.entrada,
                                        valorPrincipal: vEntrada,
                                        valorEmpate: vEmpate,
                                        multiplicadorEmpate: mult
                                    });
                                    try {
                                        const resultadoConfirmadoEm = Date.now();
                                        const [resultadoFechamentoFinal] = await dbPool.query(
                                            `UPDATE auditoria_ordens
                                             SET status_ordem = ?, lucro_prejuizo = ?, saldo_pos = NULL,
                                                 resultado_confirmado_em = ?, saldo_pos_confirmado_em = NULL,
                                                 placar_mesa = ?
                                             WHERE id = ? AND mesa_id = ? AND status_ordem = 'PENDENTE'`,
                                            [
                                                isTie ? 'TIE' : 'WIN',
                                                vLucro,
                                                resultadoConfirmadoEm,
                                                `[P:${p1+p2} B:${b1+b2}]`,
                                                pendentes[0].id,
                                                Number(dados.mesa_id)
                                            ]
                                        );
                                        if (Number(resultadoFechamentoFinal.affectedRows) !== 1) {
                                            throw new Error(
                                                `MC22-P: ordem ${pendentes[0].id} nao pode ser fechada ` +
                                                `como ${isTie ? 'TIE' : 'WIN'} na mesa ${dados.mesa_id}`
                                            );
                                        }
                                        await processarResultadoStopRedsAutoTrader(
                                            trader,
                                            isTie ? 'TIE' : 'GREEN',
                                            dados.timestamp_coleta
                                        );
                                        await concluirSinalOperadoAutoTrader(
                                            trader,
                                            isTie ? 'TIE' : 'GREEN'
                                        );
                                    } catch(e) {
                                        console.error(`❌ Falha ao fechar ordem ${pendentes[0].id} como ${isTie ? 'TIE' : 'WIN'} do trader ${trader.id}:`, e.message);
                                    }
                                }
                            }
                        }
                    }
                    finalizar = true;
                } else {
                    if (st.galeAtual < est.gales) {
                        if (
                            !avancarGaleEstadoSinal(
                                est.id,
                                st,
                                est.gales
                            )
                        ) {
                            invalidarEstadoSinalInconsistente(
                                est.id,
                                st,
                                'FALHA_TRANSICAO_GALE'
                            );

                            continue;
                        }

                        const extrasGale = { nivel: st.galeAtual };
                        emitirAlertaWebRobo('GALE', est, st, extrasGale);
                        void enviarTelegramParaInscritos('GALE', est, st, extrasGale).catch(e => {
                            console.error(`⚠️ Falha inesperada no envio Telegram GALE da estratégia ${est.id}:`, e.message);
                        });
                        if (est.quarentena_restante <= 0) {
                            for (let trader of AUTO_TRADERS_MEMORIA) {
                                let cf = trader.config;
                                if (trader.ativo && trader.status_operacao === 'OPERANDO' && autoTraderAutorizaEstrategia(cf, est, ROBOS_MEMORIA)) {
                                    const [pendentes] = await dbPool.query(`SELECT id, risco_total, valor_entrada, valor_empate FROM auditoria_ordens WHERE trader_id = ? AND estrategia_id = ? AND mesa_id = ? AND status_ordem = 'PENDENTE' LIMIT 1`, [trader.id, est.id, Number(dados.mesa_id)]);
                                    if (pendentes.length > 0) {
                                        let riscoAntigo = parseFloat(pendentes[0].risco_total);
                                        const pnlEtapaAnterior = calcularPnLEtapa({
                                            resultado: vencedor,
                                            alvoPrincipal: est.entrada,
                                            valorPrincipal: Number(pendentes[0].valor_entrada) || 0,
                                            valorEmpate: Number(pendentes[0].valor_empate) || 0,
                                            multiplicadorEmpate: mult
                                        });
                                        const planoGale = calcularPlanoAposta(cf, est, st.galeAtual);
                                        if (!planoGale.ok) {
                                            console.error(`❌ GALE ${st.galeAtual} do trader ${trader.id} bloqueado: ${planoGale.motivo}`);
                                            continue;
                                        }
                                        let valorGale = planoGale.valor_principal;
                                        let valorEmpateGale = planoGale.valor_empate;
                                        let alvoPython = planoGale.apostas[0].alvo;

                                        const ordemExecutorIdGale = crypto.randomUUID();
                                        let intencaoGale = null;
                                        let conexaoGale = null;
                                        try {
                                            conexaoGale = await dbPool.getConnection();
                                            await conexaoGale.beginTransaction();
                                            const [etapaAnteriorFechada] = await conexaoGale.query(
                                                `UPDATE auditoria_ordens
                                                 SET status_ordem='LOSS', lucro_prejuizo=?, saldo_pos=?, placar_mesa=?
                                                 WHERE id=? AND mesa_id=? AND status_ordem='PENDENTE'`,
                                                [
                                                    pnlEtapaAnterior,
                                                    trader.saldo_atual,
                                                    `[P:${p1+p2} B:${b1+b2}]`,
                                                    pendentes[0].id,
                                                    Number(dados.mesa_id)
                                                ]
                                            );
                                            if (Number(etapaAnteriorFechada.affectedRows) !== 1) {
                                                throw new Error(
                                                    `MC22-Q: etapa anterior ${pendentes[0].id} nao pode ser fechada ` +
                                                    `para GALE na mesa ${dados.mesa_id}`
                                                );
                                            }

                                            intencaoGale = await criarIntencaoOrdem(conexaoGale, {
                                                trader_id: trader.id,
                                                estrategia_id: est.id,
                                                estrategia_nome: est.nome,
                                                fonte_sinal: est.origem,
                                                alvo: alvoPython,
                                                nivel: `GALE ${st.galeAtual}`,
                                                risco_total: riscoAntigo + planoGale.exposicao_etapa,
                                                valor_entrada: valorGale,
                                                valor_empate: valorEmpateGale,
                                                order_id: ordemExecutorIdGale
                                            });

                                            if (
                                                Number(intencaoGale.mesa_id)
                                                !== Number(dados.mesa_id)
                                            ) {
                                                throw new Error(
                                                    'MC22-X: intencao GALE nasceu fora da mesa da rodada'
                                                );
                                            }

                                            await conexaoGale.commit();
                                        } catch(e) {
                                            if (conexaoGale) {
                                                try { await conexaoGale.rollback(); } catch(rollbackError) {
                                                    console.error(`❌ Rollback falhou ao preparar GALE ${st.galeAtual} do trader ${trader.id}:`, rollbackError.message);
                                                }
                                            }
                                            console.error(
                                                `❌ GALE ${st.galeAtual} do trader ${trader.id} bloqueado: `
                                                + `falha ao persistir LOSS anterior + intenção PREPARANDO antes do executor:`,
                                                e.message
                                            );
                                            continue;
                                        } finally {
                                            if (conexaoGale) conexaoGale.release();
                                        }

                                        let executorConfirmouGale = false;
                                        try {
                                            const confirmacaoExecutorGale = await enviarOrdemAoExecutor(
                                                alvoPython,
                                                valorGale,
                                                ordemExecutorIdGale,
                                                planoGale.apostas
                                            );
                                            executorConfirmouGale = true;
                                            const evidenciaGale = confirmacaoExecutorGale.execucao.confirmacao;
                                            const [auditoriaAtualizada] = await dbPool.query(
                                                `UPDATE auditoria_ordens
                                                 SET status_ordem='PENDENTE', executor_confirmacao_metodo=?,
                                                     executor_saldo_antes=?, executor_saldo_depois=?,
                                                     executor_debito_observado=?, execucao_confirmada_em=?
                                                 WHERE id=? AND executor_order_id=? AND status_ordem='PREPARANDO'
                                                   AND mesa_id=?`,
                                                [
                                                    evidenciaGale.metodo,
                                                    evidenciaGale.saldo_antes,
                                                    evidenciaGale.saldo_depois,
                                                    evidenciaGale.debito_observado,
                                                    evidenciaGale.confirmada_em,
                                                    intencaoGale.auditoria_id,
                                                    ordemExecutorIdGale,
                                                    Number(dados.mesa_id)
                                                ]
                                            );
                                            if (Number(auditoriaAtualizada.affectedRows) !== 1) {
                                                throw new Error('Intenção PREPARANDO do GALE não encontrada após ACK do executor');
                                            }
                                        } catch(e) {
                                            if (executorConfirmouGale) {
                                                console.error(
                                                    `⚠️ GALE ${st.galeAtual} confirmado pelo executor (${ordemExecutorIdGale}), `
                                                    + `mas a intenção ${intencaoGale.auditoria_id} não avançou para PENDENTE; `
                                                    + `PREPARANDO foi preservado para reconciliação:`,
                                                    e.message
                                                );
                                            } else {
                                                const statusFalha = await marcarIntencaoAposFalhaEnvio(
                                                    intencaoGale.auditoria_id,
                                                    e,
                                                    `GALE ${st.galeAtual} do trader ${trader.id}`
                                                );
                                                await bloquearTraderAposExecucaoAmbigua(
                                                    trader,
                                                    statusFalha,
                                                    `GALE ${st.galeAtual}`
                                                );
                                                console.error(
                                                    `❌ GALE ${st.galeAtual} não confirmado para o trader ${trader.id}; `
                                                    + `intenção ${intencaoGale.auditoria_id} marcada ${statusFalha}:`,
                                                    e.message
                                                );
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    } else {
                        est.stats.red++;

                        try {
                            await registrarHistoricoResultadoEstrategia(est, 'RED', st.galeAtual, '', dados.timestamp_coleta);
                        } catch (e) {
                            console.error(`Falha ao persistir historico da estrategia ${est.id}:`, e.message);
                        }

                        await aguardarInscricaoTelegram(st);

                        try {
                            await registrarHistoricoRobosInscritos(est, st, 'RED', st.galeAtual, '', dados.timestamp_coleta);
                        } catch (e) {
                            console.error(`Falha ao persistir historico dos robos para estrategia ${est.id}:`, e.message);
                        }

                        let avisosProtecao = [];
                        try {
                            avisosProtecao = await processarResultadoProtecaoRobos(st, 'RED', dados.timestamp_coleta);
                        } catch (e) {
                            console.error(`Falha ao atualizar proteção dos robôs da estratégia ${est.id}:`, e.message);
                        }

                        emitirAlertaWebRobo('RED', est, st);
                        void (async () => {
                            await enviarTelegramParaInscritos('RED', est, st);
                            await enviarAvisosProtecaoTelegram(st, avisosProtecao);
                        })().catch(e => {
                            console.error(`⚠️ Falha inesperada no envio Telegram RED/proteção da estratégia ${est.id}:`, e.message);
                        });

                        try {
                            await processarResultadoVirtualAutoTraders(est, st, 'RED');
                        } catch (e) {
                            console.error(`⚠️ Auto-Trader: falha ao processar resultado virtual RED de ${est.id}:`, e.message);
                        }

                        if (est.quarentena_restante <= 0) {
                            for (let trader of AUTO_TRADERS_MEMORIA) {
                                let cf = trader.config;
                                if (trader.ativo && (trader.status_operacao === 'OPERANDO' || trader.status_operacao === 'STANDBY') && autoTraderAutorizaEstrategia(cf, est, ROBOS_MEMORIA)) {
                                    const [pendentes] = await dbPool.query(`SELECT id, valor_entrada, valor_empate FROM auditoria_ordens WHERE trader_id = ? AND estrategia_id = ? AND mesa_id = ? AND status_ordem = 'PENDENTE' LIMIT 1`, [trader.id, est.id, Number(dados.mesa_id)]);
                                    if (pendentes.length > 0) {
                                        let prejuizo = calcularPnLEtapa({
                                            resultado: vencedor,
                                            alvoPrincipal: est.entrada,
                                            valorPrincipal: Number(pendentes[0].valor_entrada) || 0,
                                            valorEmpate: Number(pendentes[0].valor_empate) || 0,
                                            multiplicadorEmpate: mult
                                        });
                                        try {
                                            const resultadoConfirmadoEm = Date.now();
                                            const [resultadoFechamentoRedFinal] = await dbPool.query(
                                                `UPDATE auditoria_ordens
                                                 SET status_ordem = 'LOSS', lucro_prejuizo = ?, saldo_pos = NULL,
                                                     resultado_confirmado_em = ?, saldo_pos_confirmado_em = NULL,
                                                     placar_mesa = ?
                                                 WHERE id = ? AND mesa_id = ? AND status_ordem = 'PENDENTE'`,
                                                [
                                                    prejuizo,
                                                    resultadoConfirmadoEm,
                                                    `[P:${p1+p2} B:${b1+b2}]`,
                                                    pendentes[0].id,
                                                    Number(dados.mesa_id)
                                                ]
                                            );
                                            if (Number(resultadoFechamentoRedFinal.affectedRows) !== 1) {
                                                throw new Error(
                                                    `MC22-P: ordem ${pendentes[0].id} nao pode ser fechada ` +
                                                    `como LOSS na mesa ${dados.mesa_id}`
                                                );
                                            }
                                            await processarResultadoStopRedsAutoTrader(
                                                trader,
                                                'RED',
                                                dados.timestamp_coleta
                                            );
                                            await concluirSinalOperadoAutoTrader(trader, 'RED');
                                        } catch(e) {
                                            console.error(`❌ Falha ao fechar ordem LOSS ${pendentes[0].id} do trader ${trader.id}:`, e.message);
                                        }
                                    }
                                }
                            }
                        }
                        finalizar = true;
                    }
                }
                if (finalizar) {
                    // GREEN, TIE protegido ou RED final encerram somente ESTE ciclo.
                    // O cursor do(s) robô(s) liberado(s) nasce nesta rodada; outros
                    // robôs permanecem livres para avaliar seus próprios padrões.
                    if (
                        !finalizarEstadoSinal(
                            est.id,
                            st
                        )
                    ) {
                        invalidarEstadoSinalInconsistente(
                            est.id,
                            st,
                            'FALHA_FINALIZACAO_ESTADO'
                        );

                        continue;
                    }

                    if (est.is_dinamico) {
                        try {
                            await autoPilotIA.reavaliarDescarteEstrategia(est.id);
                        } catch (e) {
                            console.error(`⚠️ Auto Pilot IA: falha ao reavaliar descarte live de ${est.id}:`, e.message);
                        }
                    }

                    ioServer.emit('atualizar_interface');
                }
            }
        }

        const maiorPadraoLive = ESTRATEGIAS_MEMORIA.reduce((maior, est) => {
            const tamanho = Array.isArray(est?.padrao) ? est.padrao.length : 0;
            return Math.max(maior, tamanho);
        }, 0);
        const estadoLiveCanonico = integracaoContadorDiario.obterHistoricoCanonicoLive(
            Math.max(1, maiorPadraoLive)
        );
        if (estadoLiveCanonico.pronto !== true) {
            return;
        }
        const historicoLiveCanonico = estadoLiveCanonico.history;
        const oportunidadesFinanceirasAutoTraderRodada =
            arbitroFinanceiroAutoTrader.criarMapaRodada(contadorRodadasSinal);

        {
            // Não existe mais lock global. Estratégias diferentes podem abrir
            // ciclos simultâneos desde que os robôs envolvidos estejam livres.
            for (let est of ESTRATEGIAS_MEMORIA) {
                if (!est.ativo) continue;

                // estadoApostas continua indexado por estratégia; uma estratégia
                // já ativa nunca pode ser sobrescrita por um segundo ciclo.
                if (estadoApostas[est.id]?.aguardandoResultado) continue;
                if (historicoLiveCanonico.length >= est.padrao.length) {
                    let ult = historicoLiveCanonico.slice(-est.padrao.length);
                    let matchCores = ult.every((val, i) => val.resultado === est.padrao[i]);

                    if (matchCores) {
                        let selecaoRobos = { web: [], telegram: [], assertividade: 0 };
                        try {
                            selecaoRobos = await selecionarRobosParaEstrategia(est, historicoLiveCanonico);
                        } catch (e) {
                            console.error(`Falha ao selecionar robos para estrategia ${est.id}:`, e.message);
                        }

                        if (!Array.isArray(selecaoRobos.todos) || selecaoRobos.todos.length === 0) {
                            const bloqueios = (Array.isArray(selecaoRobos.bloqueados) ? selecaoRobos.bloqueados : [])
                                .map(item => `${item.id}:${item.nome} em ${item.estrategia_id} (${item.gale_atual > 0 ? `GALE ${item.gale_atual}` : 'DIRETO'})`)
                                .join(', ');
                            console.log(
                                `🔒 Sinal ${est.id} suprimido: nenhum robô livre para novo ciclo.`
                                + `${bloqueios ? ` Ocupados: ${bloqueios}.` : ''}`
                            );
                            continue;
                        }

                        const robosCiclo = unirRobosInscritos(selecaoRobos.todos);

                        // Última barreira antes da publicação. Como o pipeline de
                        // resultados é FIFO, esta aquisição é determinística.
                        if (!adquirirLocksSinalRobos(robosCiclo, est.id)) {
                            console.log(
                                `🔒 Sinal ${est.id} suprimido: lock de robô mudou antes da aquisição.`
                            );
                            continue;
                        }

                        estadoApostas[est.id] = {
                            aguardandoResultado: true,
                            galeAtual: 0,
                            robosCiclo,
                            robosWebInscritos: selecaoRobos.web,
                            robosTelegramInscritos: [],
                            robosInscritos: unirRobosInscritos(selecaoRobos.todos),
                            assertividadeSinal: selecaoRobos.assertividade,
                            mensagensEntrada: [],
                            mensagensGale: []
                        };

                        const estadoSinal = estadoApostas[est.id];
                        emitirAlertaWebRobo('ENTRADA', est, estadoSinal);
                        estadoSinal.telegramEntradaPromise = inscreverRobosTelegramEntrada(est, estadoSinal, selecaoRobos.telegram);

                        if (est.quarentena_restante <= 0) {
                            for (const trader of AUTO_TRADERS_MEMORIA) {
                                if (
                                    trader.ativo
                                    && trader.status_operacao === 'OPERANDO'
                                    && autoTraderParticipouDoSinal(trader, est, estadoSinal)
                                ) {
                                    arbitroFinanceiroAutoTrader.registrarCandidato(
                                        oportunidadesFinanceirasAutoTraderRodada,
                                        trader,
                                        est,
                                        estadoSinal
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }

        // MC21: somente sinais realmente admitidos pelos locks MC1-MC8
        // chegam à decisão financeira. Aleatoriedade é consumida uma vez
        // por oportunidade agregada, nunca por sinal bruto concorrente.
        await arbitroFinanceiroAutoTrader.processarRodada(
            oportunidadesFinanceirasAutoTraderRodada
        );
    } catch(erroGeral) {
        console.error('🔥 Falha no processamento de /receber-sinal após o ACK:', erroGeral);
    } finally {
        if (liberarTurnoResultado) {
            liberarTurnoResultado();
        }
    }
});

async function iniciarApp() {
    await prepararBancoDeDados();
    await carregarHistoricoGirosAnalitico();
    await carregarSistemasParaMemoria();
    try {
        await autoPilotIA.executarTodos({ forcar: true, motivo: 'startup' });
    } catch (e) {
        console.error('⚠️ Auto Pilot IA não conseguiu revalidar no startup; backend continuará com o estado persistido:', e.message);
    }
    backendPronto = true;
    console.log("✅ Backend inicializado e pronto para atender APIs.");
}

async function encerrarAposFalhaInicializacao(erro) {
    backendPronto = false;
    console.error("🔥 Inicialização do backend falhou; encerrando processo em modo seguro:", erro);

    try {
        ioServer.close();
    } catch (e) {
        console.error("⚠️ Falha ao fechar Socket.IO após erro de inicialização:", e.message);
    }

    try {
        await new Promise(resolve => server.close(resolve));
    } catch (e) {
        console.error("⚠️ Falha ao fechar servidor HTTP após erro de inicialização:", e.message);
    }

    try {
        await dbPool.end();
    } catch (e) {
        console.error("⚠️ Falha ao encerrar pool MySQL após erro de inicialização:", e.message);
    }

    process.exitCode = 1;
}

iniciarApp().catch(encerrarAposFalhaInicializacao);
