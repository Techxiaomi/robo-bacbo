const mysql = require("mysql2/promise"); 
const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");
require("./env_loader").loadEnvFile(path.join(__dirname, "..", ".env"));

// Monitoramento Global para impedir que erros silenciosos travem o servidor Node.js
process.on('uncaughtException', (err) => {
    console.error('🔥 ERRO CRÍTICO NÃO TRATADO:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 REJEIÇÃO DE PROMISE NÃO TRATADA:', reason);
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

async function prepararBancoDeDados() {
    try {
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS historico_resultados (
                id INT AUTO_INCREMENT PRIMARY KEY, 
                estrategia_id VARCHAR(100), 
                tipo_resultado VARCHAR(20), 
                nivel VARCHAR(20), 
                multiplicador VARCHAR(10), 
                data_hora DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS giros_recentes (
                id INT AUTO_INCREMENT PRIMARY KEY, 
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
                nome VARCHAR(100),
                ativo BOOLEAN DEFAULT false,
                config_json TEXT,
                saldo_inicial DECIMAL(12,2) DEFAULT 0,
                saldo_atual DECIMAL(12,2) DEFAULT 0,
                status_operacao VARCHAR(50) DEFAULT 'STANDBY',
                entradas_feitas INT DEFAULT 0,
                pulos_restantes INT DEFAULT 0,
                data_atualizacao DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);

        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS auditoria_ordens (
                id INT AUTO_INCREMENT PRIMARY KEY,
                trader_id INT,
                estrategia_nome VARCHAR(100),
                fonte_sinal VARCHAR(100),
                alvo VARCHAR(20),
                nivel VARCHAR(20),
                risco_total DECIMAL(12,2),
                valor_entrada DECIMAL(12,2),
                status_ordem VARCHAR(20) DEFAULT 'PENDENTE',
                placar_mesa VARCHAR(50) DEFAULT '',
                lucro_prejuizo DECIMAL(12,2) DEFAULT 0,
                saldo_pos DECIMAL(12,2) DEFAULT 0,
                data_hora DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (trader_id) REFERENCES auto_traders(id) ON DELETE CASCADE
            )
        `);

        const adicionarColuna = async (query) => { 
            try { await dbPool.query(query); } catch(e) {} 
        };

        await adicionarColuna("ALTER TABLE robos_canais ADD COLUMN config_json TEXT");
        await adicionarColuna("ALTER TABLE robos_canais ADD COLUMN enviar_web BOOLEAN DEFAULT true");
        await adicionarColuna("ALTER TABLE robos_canais ADD COLUMN enviar_telegram BOOLEAN DEFAULT true");
        await adicionarColuna("ALTER TABLE robos_canais ADD COLUMN stop_reds_seguidos INT DEFAULT 0");
        await adicionarColuna("ALTER TABLE robos_canais ADD COLUMN min_assertividade INT DEFAULT 0");
        await adicionarColuna("ALTER TABLE robos_canais ADD COLUMN greens_consecutivos INT DEFAULT 0");

        await adicionarColuna("ALTER TABLE estrategias ADD COLUMN is_dinamico BOOLEAN DEFAULT false");
        await adicionarColuna("ALTER TABLE estrategias ADD COLUMN robo_dono_id INT DEFAULT NULL");
        await adicionarColuna("ALTER TABLE estrategias ADD COLUMN criado_em BIGINT DEFAULT 0");
        await adicionarColuna("ALTER TABLE estrategias ADD COLUMN quarentena_restante INT DEFAULT 0");
        await adicionarColuna("ALTER TABLE historico_disparos_robos ADD COLUMN estrategia_origem VARCHAR(100) DEFAULT ''");

        console.log("\n========================================================");
        console.log("🚀 MÓDULO BACKEND V12.0 PRO - MOTOR DE EXECUÇÃO INTEGRADO");
        console.log("========================================================\n");
    } catch (e) { 
        console.log("❌ Erro Crítico ao preparar banco de dados:", e.message); 
    }
}

// ==========================================
// 2. VARIÁVEIS GLOBAIS DE ESTADO EM MEMÓRIA
// ==========================================
let ESTRATEGIAS_MEMORIA = []; 
let ROBOS_MEMORIA = [];
let AUTO_TRADERS_MEMORIA = []; 
let historicoRecente = []; 
let estadoApostas = {}; 
let estadoStandbyRobos = {}; 
let idSessaoContinua = Date.now(); 
let contadorGirosParaLimpeza = 0;
let contadorGirosGlobalPiloto = 0; 
let saldoGlobalCorretora = 0.00;

// ==========================================
// 3. SERVIDOR WEB E SOCKET
// ==========================================
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORTA = Number(process.env.NODE_PORT || 3000);
const EXECUTOR_URL = process.env.EXECUTOR_URL || "http://127.0.0.1:5000/apostar";
const INTERNAL_API_TOKEN = (process.env.INTERNAL_API_TOKEN || "").trim();

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

async function enviarOrdemAoExecutor(alvo, valor) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), EXECUTOR_TIMEOUT_MS);

    try {
        const resposta = await fetch(EXECUTOR_URL, {
            method: 'POST',
            headers: headersInternos(),
            body: JSON.stringify({ alvo, valor }),
            signal: controller.signal
        });

        let corpo = null;
        try { corpo = await resposta.json(); } catch(e) {}

        if (!resposta.ok) {
            const detalhe = corpo && (corpo.erro || corpo.status) ? (corpo.erro || corpo.status) : `HTTP ${resposta.status}`;
            throw new Error(`Executor recusou a ordem: ${detalhe}`);
        }

        if (!corpo || !corpo.dados || corpo.dados.alvo !== alvo || Number(corpo.dados.valor) !== Number(valor)) {
            throw new Error("Executor respondeu sem confirmar os dados da ordem");
        }

        return corpo;
    } catch (e) {
        if (e && e.name === 'AbortError') {
            throw new Error(`Timeout de ${EXECUTOR_TIMEOUT_MS}ms aguardando confirmacao do executor`);
        }
        throw e;
    } finally {
        clearTimeout(timeoutId);
    }
}
const server = app.listen(PORTA, () => { 
    console.log(`🌐 Painel Web rodando na porta ${PORTA}`); 
    console.log(`📡 Webhook aguardando sinais em: http://127.0.0.1:${PORTA}/receber-sinal`);
});

const ioServer = new Server(server);

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

// ==========================================
// 5. ROTAS DE API
// ==========================================
app.get("/api/saldo-global", (req, res) => {
    res.json({ saldo_atual: saldoGlobalCorretora });
});

app.get("/api/estrategias", async (req, res) => {
    try {
        const [linhas] = await dbPool.query('SELECT * FROM estrategias ORDER BY id DESC');
        let historyMap = {};
        
        const createEmptyStats = () => ({
            '24h': { green_direto: 0, gale1: 0, gale2: 0, red: 0, ties: { direto:{}, gale1:{}, gale2:{} } },
            hoje: { green_direto: 0, gale1: 0, gale2: 0, red: 0, ties: { direto:{}, gale1:{}, gale2:{} } },
            semana: { green_direto: 0, gale1: 0, gale2: 0, red: 0, ties: { direto:{}, gale1:{}, gale2:{} } },
            mes: { green_direto: 0, gale1: 0, gale2: 0, red: 0, ties: { direto:{}, gale1:{}, gale2:{} } },
            geral: { green_direto: 0, gale1: 0, gale2: 0, red: 0, ties: { direto:{}, gale1:{}, gale2:{} } }
        });

        linhas.forEach(est => {
            historyMap[est.id] = createEmptyStats();
            historyMap[est.id].geral.green_direto = est.green_direto; 
            historyMap[est.id].geral.gale1 = est.gale1; 
            historyMap[est.id].geral.gale2 = est.gale2; 
            historyMap[est.id].geral.red = est.red;
            
            if (est.ties_json) {
                try { historyMap[est.id].geral.ties = JSON.parse(est.ties_json); } catch(e) {}
            }
        });

        const [historico] = await dbPool.query(`
            SELECT 
                estrategia_id, tipo_resultado, nivel, multiplicador, 
                data_hora >= DATE_SUB(NOW(), INTERVAL 24 HOUR) AS is_24h, 
                DATE(data_hora) = CURDATE() AS is_hoje, 
                YEARWEEK(data_hora, 0) = YEARWEEK(CURDATE(), 0) AS is_semana, 
                YEAR(data_hora) = YEAR(CURDATE()) AND MONTH(data_hora) = MONTH(CURDATE()) AS is_mes 
            FROM historico_resultados
        `);

        historico.forEach(row => {
            let sid = row.estrategia_id; 
            if (!historyMap[sid]) return;

            let levelKey = 'green_direto'; 
            let tieLevelKey = 'direto';

            if (row.nivel === 'GALE1') { levelKey = 'gale1'; tieLevelKey = 'gale1'; } 
            if (row.nivel === 'GALE2') { levelKey = 'gale2'; tieLevelKey = 'gale2'; }

            const addStat = (period) => {
                if (row.tipo_resultado === 'GREEN') {
                    historyMap[sid][period][levelKey]++;
                } else if (row.tipo_resultado === 'RED') {
                    historyMap[sid][period].red++;
                } else if (row.tipo_resultado === 'TIE') { 
                    let m = row.multiplicador || '4x'; 
                    if (!historyMap[sid][period].ties[tieLevelKey][m]) historyMap[sid][period].ties[tieLevelKey][m] = 0; 
                    historyMap[sid][period].ties[tieLevelKey][m]++; 
                }
            };

            if (row.is_24h) addStat('24h'); 
            if (row.is_hoje) addStat('hoje'); 
            if (row.is_semana) addStat('semana'); 
            if (row.is_mes) addStat('mes'); 
            addStat('geral');
        });

        res.json(linhas.map(est => ({ ...est, detalhes: historyMap[est.id] })));
    } catch (erro) { 
        res.status(500).json({ erro: "Erro ao buscar estratégias" }); 
    }
});

app.get("/api/dashboard-stats", async (req, res) => {
    try {
        const { robo_id, periodo = '24h', origem = 'TODAS' } = req.query;
        let queryWhere = "WHERE 1=1";
        let queryParams = [];

        if (periodo === '24h') queryWhere += " AND h.data_hora >= DATE_SUB(NOW(), INTERVAL 24 HOUR)";
        else if (periodo === 'hoje') queryWhere += " AND DATE(h.data_hora) = CURDATE()";
        else if (periodo === 'semana') queryWhere += " AND YEARWEEK(h.data_hora, 0) = YEARWEEK(CURDATE(), 0)";
        else if (periodo === 'mes') queryWhere += " AND YEAR(h.data_hora) = YEAR(CURDATE()) AND MONTH(h.data_hora) = MONTH(CURDATE())";

        if (robo_id && robo_id !== 'TODOS') { queryWhere += " AND h.robo_id = ?"; queryParams.push(robo_id); }
        if (origem && origem !== 'TODAS') { queryWhere += " AND h.estrategia_origem = ?"; queryParams.push(origem); }

        const [linhas] = await dbPool.query(`
            SELECT h.tipo_resultado, h.nivel, h.multiplicador 
            FROM historico_disparos_robos h 
            LEFT JOIN estrategias e ON h.estrategia_id = e.id 
            ${queryWhere}
        `, queryParams);

        let sinais = linhas.length; let greens = 0; let reds = 0;
        linhas.forEach(row => {
            if (row.tipo_resultado === 'GREEN' || row.tipo_resultado === 'TIE') greens++;
            else if (row.tipo_resultado === 'RED') reds++;
        });

        let assertividade = (sinais > 0) ? ((greens / sinais) * 100).toFixed(1) : 0;
        res.json({ sinais, greens, reds, assertividade: assertividade + '%' });
    } catch (e) {
        res.status(500).json({ sinais: 0, greens: 0, reds: 0, assertividade: '0%' });
    }
});

app.get("/api/historico-giros", async (req, res) => {
    try {
        let limit = parseInt(req.query.limit) || 1000;
        if (limit > 10000) limit = 10000;
        const [linhas] = await dbPool.query(`SELECT resultado, multiplicador, data_hora, id_sessao FROM giros_recentes ORDER BY id DESC LIMIT ${limit}`);
        res.json(linhas.reverse());
    } catch (e) {
        res.status(500).json([]);
    }
});

app.post("/api/simular-banca", async (req, res) => {
    try {
        const { tipo_alvo, alvo_id, banca_inicial, stake_principal, cobrir_empate, pct_empate, mult_gale, periodo, filtro_horario, hora_inicio, hora_fim } = req.body;
        let query = ""; let params = [];

        if (tipo_alvo === 'ESTRATEGIA') { query = "SELECT tipo_resultado, nivel, multiplicador, data_hora, estrategia_id FROM historico_resultados WHERE estrategia_id = ?"; params.push(alvo_id); } 
        else if (tipo_alvo === 'ORIGEM') { query = "SELECT h.tipo_resultado, h.nivel, h.multiplicador, h.data_hora, h.estrategia_id FROM historico_resultados h JOIN estrategias e ON h.estrategia_id = e.id WHERE e.origem = ?"; params.push(alvo_id); } 
        else if (tipo_alvo === 'ROBO') { query = "SELECT tipo_resultado, nivel, multiplicador, data_hora, estrategia_id FROM historico_disparos_robos WHERE robo_id = ?"; params.push(alvo_id); }

        if (periodo === '24h') query += " AND data_hora >= DATE_SUB(NOW(), INTERVAL 24 HOUR)";
        else if (periodo === 'hoje') query += " AND DATE(data_hora) = CURDATE()";
        else if (periodo === 'semana') query += " AND YEARWEEK(data_hora, 0) = YEARWEEK(CURDATE(), 0)";
        else if (periodo === 'mes') query += " AND YEAR(data_hora) = YEAR(CURDATE()) AND MONTH(data_hora) = MONTH(CURDATE())";

        query += " ORDER BY data_hora ASC";
        const [linhas] = await dbPool.query(query, params);

        const [estrategias] = await dbPool.query('SELECT id, gales FROM estrategias');
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
    } catch (e) { res.status(500).json({ sucesso: false, erro: e.message }); }
});

app.post("/api/novo-padrao", async (req, res) => {
    try {
        const { nome, origem, padrao, entrada, gales, protegerEmpate, ativo } = req.body;
        const padraoJson = JSON.stringify(padrao.split(',').map(s => s.trim()));
        const id = "padrao_" + Date.now(); 
        const tiesZerado = JSON.stringify({ direto: { '88x': 0, '25x': 0, '10x': 0, '6x': 0, '4x': 0 }, gale1: { '88x': 0, '25x': 0, '10x': 0, '6x': 0, '4x': 0 }, gale2: { '88x': 0, '25x': 0, '10x': 0, '6x': 0, '4x': 0 } });
        await dbPool.query('INSERT INTO estrategias (id, nome, origem, padrao, entrada, gales, proteger_empate, ativo, green_direto, gale1, gale2, red, ties_json, is_dinamico) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, false)', [id, nome, origem, padraoJson, entrada, parseInt(gales), protegerEmpate ? 1 : 0, ativo ? 1 : 0, tiesZerado]);
        await carregarSistemasParaMemoria(); ioServer.emit('atualizar_interface'); res.json({ sucesso: true });
    } catch (erro) { res.status(500).json({ sucesso: false }); }
});

app.put("/api/estrategia/:id", async (req, res) => {
    try {
        const { nome, origem, padrao, entrada, gales, protegerEmpate, ativo } = req.body;
        const padraoJson = JSON.stringify(padrao.split(',').map(s => s.trim()));
        await dbPool.query('UPDATE estrategias SET nome = ?, origem = ?, padrao = ?, entrada = ?, gales = ?, proteger_empate = ?, ativo = ? WHERE id = ? AND is_dinamico = false', [nome, origem, padraoJson, entrada, parseInt(gales), protegerEmpate ? 1 : 0, ativo ? 1 : 0, req.params.id]);
        await carregarSistemasParaMemoria(); ioServer.emit('atualizar_interface'); res.json({ sucesso: true });
    } catch (erro) { res.status(500).json({ sucesso: false }); }
});

app.delete("/api/estrategia/:id", async (req, res) => {
    try {
        await apagarEstrategiaEDados(req.params.id);
        await carregarSistemasParaMemoria(); ioServer.emit('atualizar_interface'); res.json({ sucesso: true });
    } catch (erro) { res.status(500).json({ sucesso: false }); }
});

async function apagarEstrategiaEDados(id) {
    try {
        await dbPool.query('DELETE FROM estrategias WHERE id = ?', [id]);
        await dbPool.query('DELETE FROM historico_resultados WHERE estrategia_id = ?', [id]);
    } catch (e) {}
}

app.get("/api/origens", async (req, res) => { try { const [linhas] = await dbPool.query('SELECT * FROM origens ORDER BY nome ASC'); res.json(linhas); } catch(e) { res.status(500).json([]); } });
app.post("/api/nova-origem", async (req, res) => { try { await dbPool.query('INSERT INTO origens (nome) VALUES (?)', [req.body.nome]); ioServer.emit('atualizar_interface'); res.json({ sucesso: true }); } catch(e) { res.status(500).json({sucesso: false}); } });
app.put("/api/origem/:id", async (req, res) => { try { await dbPool.query('UPDATE origens SET nome = ? WHERE id = ?', [req.body.novoNome, req.params.id]); await dbPool.query('UPDATE estrategias SET origem = ? WHERE origem = ? AND is_dinamico = false', [req.body.novoNome, req.body.nomeAntigo]); await carregarSistemasParaMemoria(); ioServer.emit('atualizar_interface'); res.json({ sucesso: true }); } catch(e) { res.status(500).json({sucesso:false}); } });
app.delete("/api/origem/:id", async (req, res) => { try { await dbPool.query('DELETE FROM origens WHERE id = ?', [req.params.id]); ioServer.emit('atualizar_interface'); res.json({ sucesso: true }); } catch(e) { res.status(500).json({sucesso:false}); } });

// ==========================================
// 6. API: GESTÃO DE ROBÔS E AUTO-TRADERS
// ==========================================
app.get("/api/robos", async (req, res) => {
    try { 
        const [linhas] = await dbPool.query('SELECT * FROM robos_canais ORDER BY id DESC'); 
        const [destinatarios] = await dbPool.query('SELECT * FROM destinatarios_robo');
        const [countDinamicos] = await dbPool.query('SELECT robo_dono_id, COUNT(id) as qtd FROM estrategias WHERE is_dinamico = true GROUP BY robo_dono_id');

        const [historicoRobos] = await dbPool.query(`
            SELECT 
                robo_id, tipo_resultado, nivel, multiplicador, 
                data_hora >= DATE_SUB(NOW(), INTERVAL 24 HOUR) AS is_24h, 
                DATE(data_hora) = CURDATE() AS is_hoje, 
                YEARWEEK(data_hora, 0) = YEARWEEK(CURDATE(), 0) AS is_semana, 
                YEAR(data_hora) = YEAR(CURDATE()) AND MONTH(data_hora) = MONTH(CURDATE()) AS is_mes 
            FROM historico_disparos_robos
        `);

        let mapRobos = {};
        const createEmptyStats = () => ({
            '24h': { green_direto: 0, gale1: 0, gale2: 0, red: 0, ties: { direto:{}, gale1:{}, gale2:{} } },
            hoje: { green_direto: 0, gale1: 0, gale2: 0, red: 0, ties: { direto:{}, gale1:{}, gale2:{} } },
            semana: { green_direto: 0, gale1: 0, gale2: 0, red: 0, ties: { direto:{}, gale1:{}, gale2:{} } },
            mes: { green_direto: 0, gale1: 0, gale2: 0, red: 0, ties: { direto:{}, gale1:{}, gale2:{} } },
            geral: { green_direto: 0, gale1: 0, gale2: 0, red: 0, ties: { direto:{}, gale1:{}, gale2:{} } }
        });

        linhas.forEach(r => mapRobos[r.id] = createEmptyStats());

        historicoRobos.forEach(row => {
            let rid = row.robo_id; if (!mapRobos[rid]) return;
            let levelKey = 'green_direto'; let tieLevelKey = 'direto';
            if (row.nivel === 'GALE1') { levelKey = 'gale1'; tieLevelKey = 'gale1'; } 
            if (row.nivel === 'GALE2') { levelKey = 'gale2'; tieLevelKey = 'gale2'; }
            
            const addStat = (period) => {
                if (row.tipo_resultado === 'GREEN') mapRobos[rid][period][levelKey]++;
                else if (row.tipo_resultado === 'RED') mapRobos[rid][period].red++;
                else if (row.tipo_resultado === 'TIE') { 
                    let m = row.multiplicador || '4x'; 
                    if (!mapRobos[rid][period].ties[tieLevelKey][m]) mapRobos[rid][period].ties[tieLevelKey][m] = 0; 
                    mapRobos[rid][period].ties[tieLevelKey][m]++; 
                }
            };
            if (row.is_24h) addStat('24h'); if (row.is_hoje) addStat('hoje'); if (row.is_semana) addStat('semana'); if (row.is_mes) addStat('mes'); addStat('geral');
        });

        let robosSanitizados = linhas.map(r => {
            let confObj = { origens: [], avulsos: [], excecoes: [], mostrar_nome: true, mostrar_padrao: true, mostrar_assertividade: true, detalhar_empates: true, cabecalho: '', rodape: '', auto_tuning: { ativo: false }, cooldown: { ativo: false } };
            try { if (r.config_json) confObj = { ...confObj, ...JSON.parse(r.config_json) }; } catch(err){}
            let meusDestinatarios = destinatarios.filter(d => d.robo_id === r.id);
            let contagemIA = countDinamicos.find(d => d.robo_dono_id === r.id);
            let cState = estadoStandbyRobos[r.id];
            return { ...r, config: confObj, destinatarios: meusDestinatarios, qtd_padroes_ia: contagemIA ? contagemIA.qtd : 0, detalhes: mapRobos[r.id], em_standby_ate: cState ? cState.em_standby_ate : 0 };
        });

        res.json(robosSanitizados);
    } catch(e) { res.status(500).json([]); }
});

app.post("/api/robo", async (req, res) => {
    try {
        const { nome, tag, cor, telegram_token, telegram_chat_id, enviar_telegram, enviar_web, min_assert, stop_reds, ativo, config, destinatarios } = req.body;
        const configJson = JSON.stringify(config || {});
        const [result] = await dbPool.query(`INSERT INTO robos_canais (nome, tag_visual, cor_hex, telegram_token, telegram_chat_id, enviar_telegram, enviar_web, min_assertividade, stop_reds_seguidos, greens_consecutivos, ativo, config_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`, [nome, tag, cor, telegram_token, telegram_chat_id || '', enviar_telegram ? 1 : 0, enviar_web ? 1 : 0, min_assert, stop_reds, ativo ? 1 : 0, configJson]);
        let roboId = result.insertId;
        if (destinatarios && Array.isArray(destinatarios)) { for (let d of destinatarios) { if (d.chat_id && d.chat_id.trim() !== '') await dbPool.query('INSERT INTO destinatarios_robo (robo_id, nome_cliente, chat_id) VALUES (?, ?, ?)', [roboId, d.nome_cliente || 'Cliente', d.chat_id.trim()]); } }
        await carregarSistemasParaMemoria(); ioServer.emit('atualizar_robos'); res.json({ sucesso: true });
    } catch(e) { res.status(500).json({ sucesso: false }); }
});

app.put("/api/robo/:id", async (req, res) => {
    try {
        const { id } = req.params; const { nome, tag, cor, telegram_token, telegram_chat_id, enviar_telegram, enviar_web, min_assert, stop_reds, ativo, config, destinatarios } = req.body;
        const configJson = JSON.stringify(config || {});
        await dbPool.query(`UPDATE robos_canais SET nome=?, tag_visual=?, cor_hex=?, telegram_token=?, telegram_chat_id=?, enviar_telegram=?, enviar_web=?, min_assertividade=?, stop_reds_seguidos=?, ativo=?, config_json=? WHERE id=?`, [nome, tag, cor, telegram_token, telegram_chat_id || '', enviar_telegram ? 1 : 0, enviar_web ? 1 : 0, min_assert, stop_reds, ativo ? 1 : 0, configJson, id]);
        await dbPool.query('DELETE FROM destinatarios_robo WHERE robo_id = ?', [id]);
        if (destinatarios && Array.isArray(destinatarios)) { for (let d of destinatarios) { if (d.chat_id && d.chat_id.trim() !== '') await dbPool.query('INSERT INTO destinatarios_robo (robo_id, nome_cliente, chat_id) VALUES (?, ?, ?)', [id, d.nome_cliente || 'Cliente', d.chat_id.trim()]); } }
        await carregarSistemasParaMemoria(); ioServer.emit('atualizar_robos'); res.json({ sucesso: true });
    } catch(e) { res.status(500).json({ sucesso: false }); }
});

app.delete("/api/robo/:id", async (req, res) => {
    try { 
        const roboId = req.params.id;
        await dbPool.query('DELETE FROM destinatarios_robo WHERE robo_id=?', [roboId]); 
        await dbPool.query('DELETE FROM robos_canais WHERE id=?', [roboId]); 
        await carregarSistemasParaMemoria(); ioServer.emit('atualizar_robos'); ioServer.emit('atualizar_interface'); res.json({ sucesso: true }); 
    } catch(e) { res.status(500).json({ sucesso: false }); }
});

app.get("/api/auto-traders", async (req, res) => {
    try {
        const [linhas] = await dbPool.query('SELECT * FROM auto_traders ORDER BY id DESC');
        let sanitizados = linhas.map(at => {
            let confObj = {}; try { confObj = JSON.parse(at.config_json); } catch(e) {}
            return { id: at.id, nome: at.nome, ativo: at.ativo === 1, config: confObj, saldo_inicial: parseFloat(at.saldo_inicial), saldo_atual: parseFloat(at.saldo_atual), status_operacao: at.status_operacao, entradas_feitas: at.entradas_feitas, pulos_restantes: at.pulos_restantes };
        });
        res.json(sanitizados);
    } catch (e) { res.status(500).json([]); }
});

app.post("/api/auto-trader", async (req, res) => {
    try {
        const { nome, ativo, config, saldo_inicial } = req.body;
        const configJson = JSON.stringify(config || {});
        const sInicial = parseFloat(saldo_inicial) || 0.00;
        await dbPool.query(`INSERT INTO auto_traders (nome, ativo, config_json, saldo_inicial, saldo_atual, status_operacao) VALUES (?, ?, ?, ?, ?, 'STANDBY')`, [nome, ativo ? 1 : 0, configJson, sInicial, sInicial]);
        await carregarSistemasParaMemoria(); res.json({ sucesso: true });
    } catch (e) { res.status(500).json({ sucesso: false }); }
});

app.put("/api/auto-trader/:id", async (req, res) => {
    try {
        const { id } = req.params; const { nome, ativo, config } = req.body;
        const configJson = JSON.stringify(config || {});
        await dbPool.query(`UPDATE auto_traders SET nome=?, ativo=?, config_json=? WHERE id=?`, [nome, ativo ? 1 : 0, configJson, id]);
        await carregarSistemasParaMemoria(); res.json({ sucesso: true });
    } catch (e) { res.status(500).json({ sucesso: false }); }
});

app.delete("/api/auto-trader/:id", async (req, res) => { 
    try { await dbPool.query('DELETE FROM auto_traders WHERE id=?', [req.params.id]); await carregarSistemasParaMemoria(); res.json({ sucesso: true }); } catch (e) { res.status(500).json({ sucesso: false }); } 
});

app.get("/api/auditoria-ordens/:trader_id", async (req, res) => { 
    try { const [ordens] = await dbPool.query(`SELECT * FROM auditoria_ordens WHERE trader_id = ? ORDER BY id DESC LIMIT 500`, [req.params.trader_id]); res.json(ordens); } catch (e) { res.status(500).json([]); } 
});

// ==========================================
// 7. MEMÓRIA E WEBHOOK TITÃ (COM LOGS COMPLETOS)
// ==========================================

async function ativarAutoTradersAguardandoMesa() {
    const aguardandoMesa = AUTO_TRADERS_MEMORIA.filter(
        trader => trader.ativo && trader.status_operacao === 'STANDBY'
    );

    if (aguardandoMesa.length === 0) return;

    const ids = aguardandoMesa.map(trader => trader.id);
    const placeholders = ids.map(() => '?').join(',');

    await dbPool.query(
        `UPDATE auto_traders SET status_operacao = 'OPERANDO' WHERE ativo = true AND status_operacao = 'STANDBY' AND id IN (${placeholders})`,
        ids
    );

    aguardandoMesa.forEach(trader => {
        trader.status_operacao = 'OPERANDO';
    });

    console.log(`🟢 ${aguardandoMesa.length} Auto-Trader(s) sincronizado(s) com a mesa e liberado(s) para OPERANDO.`);
}

function rotacionarSessaoAposInterrupcao(dados) {
    if (!dados || dados.interrupcao_fluxo !== true) return false;

    const sessaoAnterior = idSessaoContinua;
    const timestampColeta = Number(dados.timestamp_coleta);
    let novaSessao = Number.isFinite(timestampColeta) && timestampColeta > 0
        ? Math.trunc(timestampColeta)
        : Date.now();

    if (novaSessao === sessaoAnterior) novaSessao++;
    idSessaoContinua = novaSessao;

    console.log(`🧭 Interrupção de fluxo detectada. Nova sessão contínua: ${sessaoAnterior} -> ${idSessaoContinua}`);
    return true;
}

async function carregarSistemasParaMemoria() {
    try {
        const [linhasEst] = await dbPool.query('SELECT * FROM estrategias WHERE ativo = true');
        ESTRATEGIAS_MEMORIA = []; let novoEstado = {};

        linhasEst.forEach(db => {
            let padraoParsed = []; try { padraoParsed = JSON.parse(db.padrao); } catch(e) {}
            let tiesParsed = { direto:{}, gale1:{}, gale2:{} }; if (db.ties_json) { try { tiesParsed = JSON.parse(db.ties_json); } catch(e) {} }

            let est = { 
                id: db.id, nome: db.nome, origem: db.origem, padrao: padraoParsed, entrada: db.entrada, 
                gales: db.gales, protegerEmpate: db.proteger_empate === 1, ativo: true, is_dinamico: db.is_dinamico === 1, 
                robo_dono_id: db.robo_dono_id, quarentena_restante: db.quarentena_restante || 0,
                stats: { greenDireto: db.green_direto, gale1: db.gale1, gale2: db.gale2, red: db.red, ties: tiesParsed } 
            };
            ESTRATEGIAS_MEMORIA.push(est);
            novoEstado[est.id] = estadoApostas[est.id] || { aguardandoResultado: false, galeAtual: 0, robosInscritos: [], mensagensEntrada: [], mensagensGale: [] };
        });
        estadoApostas = novoEstado;

        const [linhasRobos] = await dbPool.query('SELECT * FROM robos_canais WHERE ativo = true');
        ROBOS_MEMORIA = linhasRobos.map(r => {
            let confObj = { origens: [], avulsos: [], excecoes: [], auto_tuning: { ativo: false }, cooldown: { ativo: false } };
            try { if (r.config_json) confObj = { ...confObj, ...JSON.parse(r.config_json) }; } catch(err){}
            if (!estadoStandbyRobos[r.id]) estadoStandbyRobos[r.id] = { em_standby_ate: 0, historico_reds: [] };
            return { ...r, config: confObj };
        });

        const [linhasAT] = await dbPool.query('SELECT * FROM auto_traders');
        AUTO_TRADERS_MEMORIA = linhasAT.map(at => { 
            let cfg = {}; try { cfg = JSON.parse(at.config_json); } catch(e){} 
            return { 
                id: at.id, nome: at.nome, ativo: at.ativo === 1, config: cfg, 
                saldo_inicial: parseFloat(at.saldo_inicial), saldo_atual: parseFloat(at.saldo_atual), 
                status_operacao: at.status_operacao, entradas_feitas: at.entradas_feitas, pulos_restantes: at.pulos_restantes 
            }; 
        });

        // 🌟 LOGS DETALHADOS RESTAURADOS NA INICIALIZAÇÃO
        console.log(`\n📂 MEMÓRIA ALOCADA COM SUCESSO:`);
        console.log(`   - Estratégias Ativas: ${ESTRATEGIAS_MEMORIA.length}`);
        console.log(`   - Robôs de Canal: ${ROBOS_MEMORIA.length}`);
        console.log(`   - Motores Auto-Trader: ${AUTO_TRADERS_MEMORIA.length}\n`);
    } catch (e) { 
        console.log("❌ Erro ao carregar memória:", e.message); 
    }
}

app.post("/receber-sinal", async (req, res) => {
    try {
        if (!requisicaoInternaAutorizada(req)) {
            return res.status(401).json({ erro: "Nao autorizado" });
        }

        res.json({ recebido: true });
        const dados = req.body || {};

        if (dados.saldo_atual !== undefined && dados.saldo_atual !== null) {
            saldoGlobalCorretora = parseFloat(dados.saldo_atual);
            for (let trader of AUTO_TRADERS_MEMORIA) {
                if (trader.ativo) {
                    trader.saldo_atual = saldoGlobalCorretora;
                    try { await dbPool.query('UPDATE auto_traders SET saldo_atual=? WHERE id=?', [saldoGlobalCorretora, trader.id]); } catch(e) {}
                }
            }
        }

        let rawVenc = String(dados.vencedor || dados.resultado || dados.winner || "").toUpperCase().trim();
        let vencedor = "";
        if (rawVenc.includes("PLAYER") || rawVenc === "P" || rawVenc === "AZUL") vencedor = "Player";
        else if (rawVenc.includes("BANKER") || rawVenc === "B" || rawVenc === "VERMELHO") vencedor = "Banker";
        else if (rawVenc.includes("TIE") || rawVenc === "T" || rawVenc === "EMPATE") vencedor = "Tie";

        if (!vencedor) return;

        rotacionarSessaoAposInterrupcao(dados);

        try {
            await ativarAutoTradersAguardandoMesa();
        } catch (e) {
            console.error("⚠️ Falha ao promover Auto-Trader de STANDBY para OPERANDO:", e.message);
        }

        let p1 = (dados.dados_jogador && dados.dados_jogador.length > 0) ? parseInt(dados.dados_jogador[0]) : 0; 
        let p2 = (dados.dados_jogador && dados.dados_jogador.length > 1) ? parseInt(dados.dados_jogador[1]) : 0; 
        let b1 = (dados.dados_banca && dados.dados_banca.length > 0) ? parseInt(dados.dados_banca[0]) : 0; 
        let b2 = (dados.dados_banca && dados.dados_banca.length > 1) ? parseInt(dados.dados_banca[1]) : 0;
        let nEmp = 0; let mult = "4x"; 
        
        if (vencedor === "Tie") { 
            nEmp = parseInt(dados.pontos_jogador); if (isNaN(nEmp) || nEmp === 0) nEmp = p1 + p2; 
            if (nEmp === 2 || nEmp === 12) mult = "88x"; else if (nEmp === 3 || nEmp === 11) mult = "25x"; else if (nEmp === 4 || nEmp === 10) mult = "10x"; else if (nEmp === 5 || nEmp === 9) mult = "6x"; else mult = "4x"; 
        }

        // 🌟 LOG DETALHADO DO VENCEDOR RESTAURADO NO TERMINAL
        let logNomeVencedor = vencedor === "Player" ? "🔵 JOGADOR" : (vencedor === "Banker" ? "🔴 BANCA" : `🟡 EMPATE (${mult})`);
        let totalP = (p1 + p2).toString().padStart(2, '0'); let totalB = (b1 + b2).toString().padStart(2, '0');
        console.log(`\n====================================\n🔥 Vencedor: ${logNomeVencedor}\n🔵 Jogador : ${totalP} | 🔴 Banca: ${totalB}\n====================================\n`);

        try { 
            await dbPool.query('INSERT INTO giros_recentes (resultado, p_d1, p_d2, b_d1, b_d2, numero_empate, multiplicador, id_sessao, data_hora) VALUES (?,?,?,?,?,?,?,?,FROM_UNIXTIME(?))', [vencedor, p1, p2, b1, b2, nEmp, mult, idSessaoContinua, (dados.timestamp_coleta || Date.now()) / 1000]); 
        } catch(e){}

        historicoRecente.push({ resultado: vencedor, placarStr: `[P:${p1+p2} B:${b1+b2}]`, id_sessao: idSessaoContinua }); 
        if (historicoRecente.length > 30) historicoRecente.shift(); 
        let sinalFinalizadoAgora = false;

        for (let est of ESTRATEGIAS_MEMORIA) {
            let st = estadoApostas[est.id];
            if (st && st.aguardandoResultado) {
                let finalizar = false; 
                let isTie = (vencedor==='Tie');

                if (vencedor === est.entrada || (isTie && est.protegerEmpate)) {
                    if (!isTie) { 
                        if (st.galeAtual===0) est.stats.greenDireto++; else if (st.galeAtual===1) est.stats.gale1++; else est.stats.gale2++; 
                    } else { 
                        let tL = st.galeAtual===0?'direto':(st.galeAtual===1?'gale1':'gale2'); 
                        if (!est.stats.ties[tL][mult]) est.stats.ties[tL][mult]=0; est.stats.ties[tL][mult]++; 
                    }
                    
                    if (est.quarentena_restante <= 0) {
                        for (let trader of AUTO_TRADERS_MEMORIA) {
                            let cf = trader.config;
                            if (trader.ativo && (trader.status_operacao === 'OPERANDO' || trader.status_operacao === 'STANDBY') && cf.fontes_sinal && cf.fontes_sinal.includes(est.origem)) {
                                const [pendentes] = await dbPool.query(`SELECT id, valor_entrada FROM auditoria_ordens WHERE trader_id = ? AND status_ordem = 'PENDENTE' LIMIT 1`, [trader.id]);
                                if (pendentes.length > 0) {
                                    let vEntrada = parseFloat(pendentes[0].valor_entrada);
                                    let vLucro = isTie ? (vEntrada * parseInt(mult.replace('x', ''))) - vEntrada : vEntrada;
                                    try { await dbPool.query(`UPDATE auditoria_ordens SET status_ordem = ?, lucro_prejuizo = ?, saldo_pos = ?, placar_mesa = ? WHERE id = ?`, [isTie ? 'TIE' : 'WIN', vLucro, trader.saldo_atual, `[P:${p1+p2} B:${b1+b2}]`, pendentes[0].id]); } catch(e){}
                                }
                            }
                        }
                    }
                    finalizar = true;
                } else {
                    if (st.galeAtual < est.gales) {
                        st.galeAtual++;
                        if (est.quarentena_restante <= 0) {
                            for (let trader of AUTO_TRADERS_MEMORIA) {
                                let cf = trader.config;
                                if (trader.ativo && trader.status_operacao === 'OPERANDO' && cf.fontes_sinal && cf.fontes_sinal.includes(est.origem)) {
                                    const [pendentes] = await dbPool.query(`SELECT id, risco_total FROM auditoria_ordens WHERE trader_id = ? AND status_ordem = 'PENDENTE' LIMIT 1`, [trader.id]);
                                    if (pendentes.length > 0) {
                                        let riscoAntigo = parseFloat(pendentes[0].risco_total);
                                        let multGale = st.galeAtual === 1 ? (cf.gale_1_mult || 2.0) : (cf.gale_2_mult || 4.0);
                                        let valorGale = calcularFichaSegura((cf.stake_inicial || 10.00) * multGale);
                                        let alvoPython = est.entrada === 'Player' ? 'PlayerWon' : (est.entrada === 'Banker' ? 'BankerWon' : 'Tie');
                                        
                                        try {
                                            await dbPool.query(`UPDATE auditoria_ordens SET status_ordem = 'LOSS', lucro_prejuizo = ?, saldo_pos = ?, placar_mesa = ? WHERE id = ?`, [-riscoAntigo, trader.saldo_atual, `[P:${p1+p2} B:${b1+b2}]`, pendentes[0].id]);
                                        } catch(e) {
                                            console.error(`⚠️ Falha ao encerrar ordem anterior antes do GALE ${st.galeAtual} do trader ${trader.id}:`, e.message);
                                        }

                                        let executorConfirmouGale = false;
                                        try {
                                            await enviarOrdemAoExecutor(alvoPython, valorGale);
                                            executorConfirmouGale = true;
                                            await dbPool.query(`INSERT INTO auditoria_ordens (trader_id, estrategia_nome, fonte_sinal, alvo, nivel, risco_total, valor_entrada, status_ordem) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDENTE')`, [trader.id, est.nome, est.origem, alvoPython, `GALE ${st.galeAtual}`, riscoAntigo + valorGale, valorGale]);
                                        } catch(e) {
                                            if (executorConfirmouGale) {
                                                console.error(`⚠️ GALE ${st.galeAtual} confirmado pelo executor, mas nao registrado na auditoria do trader ${trader.id}:`, e.message);
                                            } else {
                                                console.error(`❌ GALE ${st.galeAtual} nao enviado para o trader ${trader.id}:`, e.message);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    } else {
                        est.stats.red++;
                        if (est.quarentena_restante <= 0) {
                            for (let trader of AUTO_TRADERS_MEMORIA) {
                                let cf = trader.config;
                                if (trader.ativo && (trader.status_operacao === 'OPERANDO' || trader.status_operacao === 'STANDBY') && cf.fontes_sinal && cf.fontes_sinal.includes(est.origem)) {
                                    const [pendentes] = await dbPool.query(`SELECT id, risco_total FROM auditoria_ordens WHERE trader_id = ? AND status_ordem = 'PENDENTE' LIMIT 1`, [trader.id]);
                                    if (pendentes.length > 0) {
                                        let prejuizo = -Math.abs(parseFloat(pendentes[0].risco_total));
                                        try { await dbPool.query(`UPDATE auditoria_ordens SET status_ordem = 'LOSS', lucro_prejuizo = ?, saldo_pos = ?, placar_mesa = ? WHERE id = ?`, [prejuizo, trader.saldo_atual, `[P:${p1+p2} B:${b1+b2}]`, pendentes[0].id]); } catch(e){}
                                    }
                                }
                            }
                        }
                        finalizar = true;
                    }
                }
                if (finalizar) { st.aguardandoResultado = false; st.galeAtual = 0; sinalFinalizadoAgora = true; ioServer.emit('atualizar_interface'); }
            }
        }

        if (sinalFinalizadoAgora) return;

        let ocupado = Object.values(estadoApostas).some(e => e.aguardandoResultado);
        if (!ocupado) {
            for (let est of ESTRATEGIAS_MEMORIA) {
                if (!est.ativo) continue;
                if (historicoRecente.length >= est.padrao.length) {
                    let ult = historicoRecente.slice(-est.padrao.length);
                    let mesmaSessao = ult.every(val => val.id_sessao === ult[0].id_sessao);
                    let matchCores = ult.every((val, i) => val.resultado === est.padrao[i]);

                    if (mesmaSessao && matchCores) {
                        estadoApostas[est.id] = { aguardandoResultado: true, galeAtual: 0, robosInscritos: [], mensagensEntrada: [], mensagensGale: [] };

                        if (est.quarentena_restante <= 0) {
                            for (let trader of AUTO_TRADERS_MEMORIA) {
                                let cf = trader.config;
                                if (trader.ativo && trader.status_operacao === 'OPERANDO' && cf.fontes_sinal && cf.fontes_sinal.includes(est.origem)) {
                                    
                                    if (cf.limite_entradas && trader.entradas_feitas >= cf.limite_entradas) {
                                        trader.status_operacao = 'META_ATINGIDA';
                                        try { await dbPool.query('UPDATE auto_traders SET status_operacao=? WHERE id=?', ['META_ATINGIDA', trader.id]); } catch(e){}
                                        continue;
                                    }

                                    if (cf.modo_camuflagem === 'PULOS') {
                                        if (trader.pulos_restantes > 0) {
                                            trader.pulos_restantes--;
                                            try { await dbPool.query('UPDATE auto_traders SET pulos_restantes=? WHERE id=?', [trader.pulos_restantes, trader.id]); } catch(e){}
                                            continue; 
                                        } else {
                                            let pMin = cf.camuflagem_pulos_min || 1; 
                                            let pMax = cf.camuflagem_pulos_max || 3;
                                            trader.pulos_restantes = Math.floor(Math.random() * (pMax - pMin + 1)) + pMin;
                                            try { await dbPool.query('UPDATE auto_traders SET pulos_restantes=? WHERE id=?', [trader.pulos_restantes, trader.id]); } catch(e){}
                                        }
                                    }

                                    let valorArredondado = calcularFichaSegura(cf.stake_inicial || 10.00);
                                    let alvoPython = est.entrada === 'Player' ? 'PlayerWon' : (est.entrada === 'Banker' ? 'BankerWon' : 'Tie');

                                    let executorConfirmouDireto = false;
                                    try {
                                        await enviarOrdemAoExecutor(alvoPython, valorArredondado);
                                        executorConfirmouDireto = true;

                                        const conexao = await dbPool.getConnection();
                                        try {
                                            await conexao.beginTransaction();
                                            const novasEntradas = trader.entradas_feitas + 1;
                                            await conexao.query('UPDATE auto_traders SET entradas_feitas=? WHERE id=?', [novasEntradas, trader.id]);
                                            await conexao.query(`INSERT INTO auditoria_ordens (trader_id, estrategia_nome, fonte_sinal, alvo, nivel, risco_total, valor_entrada, status_ordem) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDENTE')`, [trader.id, est.nome, est.origem, alvoPython, 'DIRETO', valorArredondado, valorArredondado]);
                                            await conexao.commit();
                                            trader.entradas_feitas = novasEntradas;
                                        } catch(e) {
                                            try { await conexao.rollback(); } catch(rollbackError) {}
                                            throw e;
                                        } finally {
                                            conexao.release();
                                        }
                                    } catch(e) {
                                        if (executorConfirmouDireto) {
                                            console.error(`⚠️ Ordem DIRETO confirmada pelo executor, mas nao registrada para o trader ${trader.id}:`, e.message);
                                        } else {
                                            console.error(`❌ Ordem DIRETO nao enviada para o trader ${trader.id}:`, e.message);
                                        }
                                    }
                                }
                            }
                        }
                        break; 
                    }
                }
            }
        }
    } catch(erroGeral) {}
});

async function iniciarApp() {
    await prepararBancoDeDados();
    await carregarSistemasParaMemoria();
}

iniciarApp();