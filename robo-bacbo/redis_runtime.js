'use strict';

let instalado = false;
let publisher = null;
let responseSubscriber = null;
let bacboSubscriber = null;
let inicializacaoRedis = null;
let fetchOriginal = null;
let timerReconexao = null;
let filaBacbo = Promise.resolve();
let sequenciaLocal = 0;

const REDIS_COMMAND_CHANNEL = 'auto_trader_commands';
const REDIS_RESPONSE_CHANNEL = 'auto_trader_responses';
const BACBO_EVENTS_CHANNEL = 'bacbo_events';
const STATUS_VALIDOS = new Set(['EXECUTADA', 'FALHOU', 'EXPIRADA', 'AMBIGUA']);
const SESSION_LOCAL = `tipminer-bacbo-${process.pid}-${Date.now()}`;
const DEDUP_MAX = 3000;
const fingerprints = new Map();
const SNAPSHOT_KEY = 'robo_bacbo:last_road_snapshot';
const RECENT_ROUNDS_KEY = 'robo_bacbo:recent_rounds';

function objeto(valor) {
    return valor && typeof valor === 'object' && !Array.isArray(valor) ? valor : null;
}

function valorJson(valor) {
    if (typeof valor !== 'string') return valor;
    const texto = valor.trim();
    if (!texto || (!texto.startsWith('{') && !texto.startsWith('['))) return valor;
    try { return JSON.parse(texto); } catch (_) { return valor; }
}

function chaveNormalizada(valor) {
    return String(valor || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function nosDoPayload(raiz, maxDepth = 7) {
    const saida = [];
    const pendentes = [{ valor: valorJson(raiz), chave: '$', path: '$', depth: 0 }];
    const vistos = new Set();

    while (pendentes.length > 0 && saida.length < 800) {
        const atual = pendentes.shift();
        const valor = valorJson(atual.valor);
        saida.push({ ...atual, valor });
        if (atual.depth >= maxDepth || valor === null || valor === undefined) continue;
        if (typeof valor !== 'object') continue;
        if (vistos.has(valor)) continue;
        vistos.add(valor);

        if (Array.isArray(valor)) {
            for (let i = 0; i < Math.min(valor.length, 1000); i++) {
                pendentes.push({ valor: valor[i], chave: String(i), path: `${atual.path}[${i}]`, depth: atual.depth + 1 });
            }
            continue;
        }

        for (const [chave, filho] of Object.entries(valor)) {
            pendentes.push({ valor: filho, chave, path: `${atual.path}.${chave}`, depth: atual.depth + 1 });
        }
    }
    return saida;
}

function normalizarVencedor(valor) {
    if (valor === null || valor === undefined) return '';
    if (typeof valor === 'object') return '';
    const texto = String(valor).trim();
    if (!texto) return '';
    const token = texto.replace(/[^a-z0-9]/gi, '').toUpperCase();

    if (['P', 'PLAYER', 'PLAYERWON', 'JOGADOR', 'JOGADORGANHOU', 'AZUL'].includes(token)) return 'Player';
    if (['B', 'BANKER', 'BANKERWON', 'BANCA', 'BANCAGANHOU', 'VERMELHO'].includes(token)) return 'Banker';
    if (['T', 'TIE', 'TIEWON', 'DRAW', 'EMPATE'].includes(token)) return 'Tie';

    if (/\bPLAYER\b/i.test(texto)) return 'Player';
    if (/\bBANKER\b/i.test(texto)) return 'Banker';
    if (/\bTIE\b/i.test(texto) || /\bEMPATE\b/i.test(texto)) return 'Tie';
    return '';
}

const CHAVES_VENCEDOR = new Set([
    'winner', 'winnername', 'winnerside', 'winningside', 'vencedor', 'resultado',
    'result', 'resultname', 'resulttype', 'outcome', 'outcometype', 'side', 'status',
    'type', 'name', 'value'
]);

function extrairVencedor(raiz) {
    const nos = nosDoPayload(raiz);

    for (const no of nos) {
        const chave = chaveNormalizada(no.chave);
        if (no.valor === true) {
            if (['playerwon', 'isplayerwinner', 'playerwinner'].includes(chave)) return 'Player';
            if (['bankerwon', 'isbankerwinner', 'bankerwinner'].includes(chave)) return 'Banker';
            if (['tiewon', 'istie', 'tie'].includes(chave)) return 'Tie';
        }
        if (!CHAVES_VENCEDOR.has(chave)) continue;
        const vencedor = normalizarVencedor(no.valor);
        if (vencedor) return vencedor;
    }

    const root = objeto(raiz);
    if (root && root.data !== undefined) {
        const vencedor = normalizarVencedor(valorJson(root.data));
        if (vencedor) return vencedor;
    }
    return '';
}

function numeroScore(valor) {
    if (valor === null || valor === undefined || valor === '' || typeof valor === 'boolean') return null;
    const numero = Number(valor);
    return Number.isFinite(numero) && numero >= 0 && numero <= 12 ? numero : null;
}

const CHAVES_PLAYER_SCORE = new Set([
    'playerscore', 'playerpoints', 'playerpoint', 'playersum', 'playertotal',
    'pontosjogador', 'pontojogador', 'jogadorscore', 'jogadorpontos'
]);
const CHAVES_BANKER_SCORE = new Set([
    'bankerscore', 'bankerpoints', 'bankerpoint', 'bankersum', 'bankertotal',
    'pontosbanca', 'pontobanca', 'bancascore', 'bancapontos', 'bankscore'
]);

function arrayDados(valor) {
    const parsed = valorJson(valor);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const numeros = parsed.map(item => Number(objeto(item) ? (item.value ?? item.face ?? item.number) : item));
    if (numeros.some(item => !Number.isInteger(item) || item < 1 || item > 6)) return null;
    return numeros;
}

function extrairPlacar(raiz) {
    const nos = nosDoPayload(raiz);
    let playerScore = null;
    let bankerScore = null;
    let dadosJogador = null;
    let dadosBanca = null;
    let diceGenerico = null;

    for (const no of nos) {
        const chave = chaveNormalizada(no.chave);
        if (playerScore === null && CHAVES_PLAYER_SCORE.has(chave)) playerScore = numeroScore(no.valor);
        if (bankerScore === null && CHAVES_BANKER_SCORE.has(chave)) bankerScore = numeroScore(no.valor);

        if (!dadosJogador && ['dadosjogador', 'playerdice', 'diceplayer', 'jogadordados'].includes(chave)) {
            dadosJogador = arrayDados(no.valor);
        }
        if (!dadosBanca && ['dadosbanca', 'bankerdice', 'dicebanker', 'bancadados'].includes(chave)) {
            dadosBanca = arrayDados(no.valor);
        }
        if (!diceGenerico && ['dice', 'dices', 'dados'].includes(chave) && Array.isArray(valorJson(no.valor))) {
            diceGenerico = valorJson(no.valor);
        }
    }

    if ((!dadosJogador || !dadosBanca) && Array.isArray(diceGenerico)) {
        const porId = new Map();
        for (const bruto of diceGenerico) {
            const item = objeto(bruto);
            if (!item) continue;
            const id = Number(item.id ?? item.diceId ?? item.index);
            const value = Number(item.value ?? item.face ?? item.number);
            if (Number.isInteger(id) && id >= 1 && id <= 4 && Number.isInteger(value) && value >= 1 && value <= 6) {
                porId.set(id, value);
            }
        }
        if (!dadosJogador && porId.has(1) && porId.has(3)) dadosJogador = [porId.get(1), porId.get(3)];
        if (!dadosBanca && porId.has(2) && porId.has(4)) dadosBanca = [porId.get(2), porId.get(4)];
    }

    if (playerScore === null && dadosJogador) playerScore = dadosJogador.reduce((a, b) => a + b, 0);
    if (bankerScore === null && dadosBanca) bankerScore = dadosBanca.reduce((a, b) => a + b, 0);
    return { playerScore, bankerScore, dadosJogador, dadosBanca };
}

function primeiroValorPorChaves(raiz, chaves) {
    const alvo = new Set(chaves.map(chaveNormalizada));
    for (const no of nosDoPayload(raiz)) {
        if (!alvo.has(chaveNormalizada(no.chave))) continue;
        if (no.valor !== undefined && no.valor !== null && no.valor !== '') return no.valor;
    }
    return undefined;
}

function timestampMs(valor) {
    if (valor === undefined || valor === null || valor === '') return Date.now();
    const numero = Number(valor);
    if (Number.isFinite(numero) && numero > 0) {
        if (numero >= 1e12) return Math.trunc(numero);
        if (numero >= 1e9) return Math.trunc(numero * 1000);
    }
    const parsed = Date.parse(String(valor));
    return Number.isFinite(parsed) ? parsed : Date.now();
}

function timestampEvento(raiz) {
    return timestampMs(primeiroValorPorChaves(raiz, [
        'timestamp_coleta', 'timestamp', 'instant', 'created_at', 'createdAt', 'ts', 'time'
    ]));
}

function sessaoEvento(raiz) {
    const valor = primeiroValorPorChaves(raiz, ['coletor_sessao', 'session_id', 'sessionId', 'session']);
    return String(valor || SESSION_LOCAL).trim().slice(0, 128) || SESSION_LOCAL;
}

function sequenciaEvento(raiz) {
    const valor = Number(primeiroValorPorChaves(raiz, ['coletor_seq', 'sequence', 'seq', 'roundNumber', 'round_number']));
    if (Number.isSafeInteger(valor) && valor > 0) {
        sequenciaLocal = Math.max(sequenciaLocal, valor);
        return valor;
    }
    return ++sequenciaLocal;
}

function chaveRodada(raiz) {
    const valor = primeiroValorPorChaves(raiz, [
        'uuid', 'round_uuid', 'roundUuid', 'round_id', 'roundId', 'game_round_id', 'gameRoundId'
    ]);
    return String(valor || '').trim();
}

function rodadaDuplicada(chave) {
    if (!chave) return false;
    if (fingerprints.has(chave)) return true;
    fingerprints.set(chave, Date.now());
    while (fingerprints.size > DEDUP_MAX) fingerprints.delete(fingerprints.keys().next().value);
    return false;
}

function vencedorLegado(vencedor) {
    if (vencedor === 'Player') return 'PlayerWon';
    if (vencedor === 'Banker') return 'BankerWon';
    return 'Tie';
}

function normalizarLive(raiz) {
    const vencedor = extrairVencedor(raiz);
    if (!vencedor) return { erro: 'vencedor_nao_encontrado' };

    const chave = chaveRodada(raiz);
    if (rodadaDuplicada(chave)) return { erro: 'duplicado', chave };

    const placar = extrairPlacar(raiz);
    const root = objeto(raiz) || {};
    const data = valorJson(root.data);
    const payloadBase = objeto(data) || objeto(valorJson(root.payload)) || objeto(valorJson(root.event)) || {};
    const payload = { ...root, ...payloadBase };
    const legado = vencedorLegado(vencedor);

    payload.vencedor = legado;
    payload.resultado = legado;
    payload.resultado_bruto = legado;
    payload.winner = vencedor;
    payload.result = vencedor;
    payload.coletor_sessao = sessaoEvento(raiz);
    payload.coletor_seq = sequenciaEvento(raiz);
    payload.timestamp_coleta = timestampEvento(raiz);
    payload.fonte = 'TipMiner';
    payload.redis_channel = BACBO_EVENTS_CHANNEL;
    payload.tipminer_uuid = chave || null;

    if (placar.playerScore !== null) {
        payload.playerScore = placar.playerScore;
        payload.pontos_jogador = placar.playerScore;
    }
    if (placar.bankerScore !== null) {
        payload.bankerScore = placar.bankerScore;
        payload.pontos_banca = placar.bankerScore;
    }
    if (placar.dadosJogador) payload.dados_jogador = placar.dadosJogador;
    if (placar.dadosBanca) payload.dados_banca = placar.dadosBanca;

    return { payload, vencedor, placar };
}

const CHAVES_HISTORY = new Set(['history', 'historico', 'roadhistory', 'road', 'rounds', 'results']);

function extrairHistory(raiz) {
    const root = objeto(raiz);
    if (root && Array.isArray(root.data) && root.data.length > 0) return root.data;

    for (const no of nosDoPayload(raiz)) {
        const valor = valorJson(no.valor);
        if (!Array.isArray(valor) || valor.length === 0 || valor.length > 1000) continue;
        if (CHAVES_HISTORY.has(chaveNormalizada(no.chave))) return valor;
    }
    return null;
}

function normalizarItemHistory(item) {
    const vencedor = extrairVencedor(item);
    const placar = extrairPlacar(item);
    if (!vencedor || placar.playerScore === null || placar.bankerScore === null) return null;
    return { winner: vencedor, playerScore: placar.playerScore, bankerScore: placar.bankerScore };
}

function normalizarSnapshot(raiz) {
    const history = Array.isArray(raiz) ? raiz : extrairHistory(raiz);
    if (!history || history.length === 0 || history.length > 1000) return null;
    const normalizado = history.map(normalizarItemHistory);
    if (normalizado.some(item => item === null)) return null;
    return {
        evento: 'ROAD_SNAPSHOT',
        coletor_sessao: sessaoEvento(raiz),
        timestamp_coleta: timestampEvento(raiz),
        history: normalizado
    };
}

function parseMensagem(mensagem) {
    const valor = valorJson(Buffer.isBuffer(mensagem) ? mensagem.toString('utf8') : mensagem);
    return valor && typeof valor === 'object' ? valor : null;
}

function acaoEvento(raiz) {
    const root = objeto(raiz);
    const direta = root && root.action;
    const aninhada = direta === undefined ? primeiroValorPorChaves(raiz, ['action', 'eventAction']) : direta;
    return String(aninhada || '').trim().toLowerCase();
}

function diagnosticoFormato(raiz) {
    const root = objeto(raiz) || {};
    const data = valorJson(root.data);
    const pistas = [];
    for (const no of nosDoPayload(raiz)) {
        const chave = chaveNormalizada(no.chave);
        if (!CHAVES_VENCEDOR.has(chave) && !chave.includes('winner') && !chave.includes('result')) continue;
        if (typeof no.valor === 'object') continue;
        pistas.push(`${no.path}=${String(no.valor).slice(0, 80)}`);
        if (pistas.length >= 10) break;
    }
    return {
        rootKeys: Object.keys(root).slice(0, 20),
        dataType: Array.isArray(data) ? 'array' : typeof data,
        dataKeys: objeto(data) ? Object.keys(data).slice(0, 20) : [],
        pistas
    };
}

function hostNode() {
    let host = String(process.env.NODE_HOST || '127.0.0.1').trim() || '127.0.0.1';
    if (host === '0.0.0.0' || host === '::' || host === '[::]') host = '127.0.0.1';
    return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function portaNode() {
    const porta = Number(process.env.NODE_PORT || 3000);
    return Number.isFinite(porta) && porta > 0 ? porta : 3000;
}

function urlNode(path) {
    return `http://${hostNode()}:${portaNode()}${path}`;
}

function normalizarUrl(valor) {
    try { return new URL(String(valor)).href; } catch (_) { return String(valor || ''); }
}

function urlExecutor() {
    return String(process.env.EXECUTOR_URL || 'http://127.0.0.1:5000/apostar').trim();
}

async function postNode(path, payload, descricao, tentativas = 60) {
    const token = String(process.env.INTERNAL_API_TOKEN || '').trim();
    if (!token) {
        console.error(`⚠️ ${descricao}: INTERNAL_API_TOKEN ausente.`);
        return false;
    }

    let ultimoErro = null;
    for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
        try {
            const resposta = await fetchOriginal(urlNode(path), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Internal-Token': token },
                body: JSON.stringify(payload)
            });
            if (resposta.ok) return true;
            ultimoErro = new Error(`HTTP ${resposta.status}`);
            if (resposta.status !== 503) break;
        } catch (erro) {
            ultimoErro = erro;
        }
        if (tentativa < tentativas) await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.error(`⚠️ ${descricao}: falha ao entregar ao Node:`, ultimoErro?.message || ultimoErro);
    return false;
}

async function persistirSnapshot(snapshot) {
    if (!publisher || !snapshot) return;
    try { await publisher.set(SNAPSHOT_KEY, JSON.stringify(snapshot)); } catch (_) { }
}

async function persistirLive(vencedor, placar) {
    if (!publisher || !vencedor || placar.playerScore === null || placar.bankerScore === null) return;
    const item = JSON.stringify({ winner: vencedor, playerScore: placar.playerScore, bankerScore: placar.bankerScore });
    try {
        await publisher.lPush(RECENT_ROUNDS_KEY, item);
        await publisher.lTrim(RECENT_ROUNDS_KEY, 0, 999);
    } catch (_) { }
}

async function entregarSnapshot(snapshot, origem) {
    const entregue = await postNode('/collector-road', snapshot, `ROAD ${origem}`);
    if (entregue) {
        await persistirSnapshot(snapshot);
        console.log(`🧠 TipMiner ROAD -> Node | ${snapshot.history.length} resultado(s) históricos | origem=${origem}.`);
    }
    return entregue;
}

async function processarBacbo(mensagem) {
    const raiz = parseMensagem(mensagem);
    if (!raiz) {
        console.warn('⚠️ bacbo_events ignorado: JSON/payload inválido.');
        return false;
    }

    if (acaoEvento(raiz) === 'live_round') {
        const live = normalizarLive(raiz);
        if (live.erro === 'duplicado') {
            console.log(`↩️ bacbo_events live_round duplicado ignorado | round=${live.chave}.`);
            return false;
        }
        if (live.erro) {
            console.warn(`⚠️ bacbo_events live_round sem vencedor reconhecível | diagnóstico=${JSON.stringify(diagnosticoFormato(raiz))}`);
            return false;
        }

        const entregue = await postNode('/receber-sinal', live.payload, `LIVE ${live.payload.tipminer_uuid || live.payload.coletor_seq}`);
        if (entregue) {
            await persistirLive(live.vencedor, live.placar);
            console.log(`📡 TipMiner LIVE -> Node | seq=${live.payload.coletor_seq} | vencedor=${live.vencedor}`);
        }
        return entregue;
    }

    const historyBruto = extrairHistory(raiz);
    if (!historyBruto) return false;
    const snapshot = normalizarSnapshot(raiz);
    if (!snapshot) {
        const validos = historyBruto.map(normalizarItemHistory).filter(Boolean).length;
        console.warn(`⚠️ bacbo_events histórico inválido: ${validos}/${historyBruto.length} item(ns) com winner+scores válidos.`);
        return false;
    }
    return entregarSnapshot(snapshot, 'pubsub');
}

function enfileirarBacbo(mensagem) {
    const executar = () => processarBacbo(mensagem);
    filaBacbo = filaBacbo.then(executar, executar).catch(erro => {
        console.error('⚠️ fila bacbo_events:', erro.message);
    });
}

async function recuperarHistoricoProprio() {
    try {
        const recentes = await publisher.lRange(RECENT_ROUNDS_KEY, 0, 999);
        if (Array.isArray(recentes) && recentes.length >= 10) {
            const history = recentes.map(item => {
                try { return JSON.parse(item); } catch (_) { return null; }
            }).filter(Boolean).reverse();
            const snapshot = normalizarSnapshot(history);
            if (snapshot) return entregarSnapshot(snapshot, 'redis-retido-live');
        }

        const bruto = await publisher.get(SNAPSHOT_KEY);
        if (bruto) {
            const parsed = parseMensagem(bruto);
            const snapshot = parsed && normalizarSnapshot(parsed.history || parsed);
            if (snapshot) return entregarSnapshot(snapshot, 'redis-retido-snapshot');
        }
    } catch (erro) {
        console.warn('⚠️ Recuperação de histórico Redis próprio falhou:', erro.message);
    }
    return false;
}

async function recuperarHistoricoExterno() {
    const vistos = new Set([SNAPSHOT_KEY, RECENT_ROUNDS_KEY]);
    for (const pattern of ['*bacbo*', '*tipminer*']) {
        try {
            let inspecionadas = 0;
            for await (const chaveBruta of publisher.scanIterator({ MATCH: pattern, COUNT: 100 })) {
                const chave = String(chaveBruta);
                if (vistos.has(chave) || ++inspecionadas > 80) continue;
                vistos.add(chave);
                let tipo;
                try { tipo = await publisher.type(chave); } catch (_) { continue; }
                if (tipo !== 'string') continue;
                let bruto;
                try { bruto = await publisher.get(chave); } catch (_) { continue; }
                if (!bruto || bruto.length > 2_000_000) continue;
                const parsed = parseMensagem(bruto);
                const snapshot = parsed && normalizarSnapshot(parsed);
                if (!snapshot || snapshot.history.length < 10) continue;
                console.log(`♻️ Histórico BacBo retido encontrado no Redis | key=${chave}.`);
                return entregarSnapshot(snapshot, `redis:${chave}`);
            }
        } catch (_) { }
    }
    return false;
}

async function recuperarHistoricoStartup() {
    if (await recuperarHistoricoProprio()) return;
    if (await recuperarHistoricoExterno()) return;
    console.log('ℹ️ Nenhum snapshot BacBo retido encontrado no Redis; aguardando ROAD do produtor enquanto LIVE segue ativo.');
}

function clientePronto(cliente) {
    return Boolean(cliente && (cliente.isReady === true || cliente.ready === true || cliente.connected === true));
}

async function conectar(cliente) {
    if (!cliente || typeof cliente.connect !== 'function') return;
    if (cliente.isOpen === true || clientePronto(cliente)) return;
    await cliente.connect();
}

function agendarReconexao() {
    if (!instalado || timerReconexao) return;
    timerReconexao = setTimeout(() => {
        timerReconexao = null;
        void garantirRedis().catch(erro => {
            console.error('⚠️ Redis runtime indisponível; nova tentativa:', erro.message);
            agendarReconexao();
        });
    }, 2000);
    timerReconexao.unref?.();
}

function registrarEventos(cliente, nome, aoFechar) {
    cliente.on('error', erro => console.error(`⚠️ Redis ${nome}:`, erro.message));
    const fechado = () => {
        aoFechar?.();
        agendarReconexao();
    };
    cliente.on('end', fechado);
    cliente.on('close', fechado);
}

function criarClientes() {
    const { createClient } = require('redis');
    const redisUrl = String(process.env.REDIS_URL || 'redis://127.0.0.1:6379').trim() || 'redis://127.0.0.1:6379';
    const timeout = Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 3000);
    const connectTimeout = Number.isFinite(timeout) ? Math.max(500, Math.min(15000, timeout)) : 3000;
    const opcoes = { url: redisUrl, socket: { connectTimeout, reconnectStrategy: () => false } };

    if (!publisher) {
        publisher = createClient(opcoes);
        registrarEventos(publisher, 'publisher');
    }
    if (!responseSubscriber) {
        responseSubscriber = publisher.duplicate();
        registrarEventos(responseSubscriber, 'responses', () => { responseSubscriber.__subscribed = false; });
    }
    if (!bacboSubscriber) {
        bacboSubscriber = publisher.duplicate();
        registrarEventos(bacboSubscriber, 'bacbo_events', () => { bacboSubscriber.__subscribed = false; });
    }
}

async function encaminharBetResult(dados) {
    const orderId = String(dados?.order_id || '').trim().toLowerCase();
    const status = String(dados?.status || '').trim().toUpperCase();
    if (!orderId || !STATUS_VALIDOS.has(status)) return false;
    return postNode('/executor-status', {
        order_id: orderId,
        status,
        motivo: String(dados?.motivo || '').slice(0, 300),
        confirmacao: dados?.confirmacao || null
    }, `bet_result ${orderId}`, 3);
}

async function garantirRedis() {
    if (clientePronto(publisher) && clientePronto(responseSubscriber) && clientePronto(bacboSubscriber)
        && responseSubscriber.__subscribed && bacboSubscriber.__subscribed) return true;
    if (inicializacaoRedis) return inicializacaoRedis;

    inicializacaoRedis = (async () => {
        criarClientes();
        await conectar(publisher);
        await conectar(responseSubscriber);
        await conectar(bacboSubscriber);

        if (!responseSubscriber.__subscribed) {
            await responseSubscriber.subscribe(REDIS_RESPONSE_CHANNEL, mensagem => {
                let dados;
                try { dados = JSON.parse(String(mensagem || '')); } catch (_) { return; }
                if (dados?.action === 'bet_result') void encaminharBetResult(dados);
            });
            responseSubscriber.__subscribed = true;
        }

        if (!bacboSubscriber.__subscribed) {
            await bacboSubscriber.subscribe(BACBO_EVENTS_CHANNEL, mensagem => enfileirarBacbo(mensagem));
            bacboSubscriber.__subscribed = true;
            console.log(`🎧 TipMiner Redis V2 ativo em ${BACBO_EVENTS_CHANNEL}: parser recursivo + retenção.`);
            setTimeout(() => void recuperarHistoricoStartup(), 250).unref?.();
        }
        return true;
    })();

    try { return await inicializacaoRedis; } finally { inicializacaoRedis = null; }
}

function respostaJson(status, corpo) {
    return new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
}

function corpoJson(init) {
    const body = init?.body;
    if (typeof body !== 'string') return null;
    try { return objeto(JSON.parse(body)); } catch (_) { return null; }
}

async function fetchRedis(input, init = {}) {
    const alvo = typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url || '');
    const metodo = String(init.method || input?.method || 'GET').toUpperCase();
    if (metodo !== 'POST' || normalizarUrl(alvo) !== normalizarUrl(urlExecutor())) return fetchOriginal(input, init);

    const dados = corpoJson(init);
    const orderId = String(dados?.order_id || '').trim().toLowerCase();
    if (!dados || !orderId) return respostaJson(400, { erro: 'order_id ausente no transporte Redis', aceita: false });

    try {
        await garantirRedis();
        const comando = { action: 'place_bet', order_id: orderId, alvo: dados.alvo, valor: dados.valor };
        if (Array.isArray(dados.apostas) && dados.apostas.length > 0) comando.apostas = dados.apostas;
        const receptores = await publisher.publish(REDIS_COMMAND_CHANNEL, JSON.stringify(comando));
        if (!Number.isFinite(Number(receptores)) || Number(receptores) < 1) {
            return respostaJson(503, { erro: 'executor Redis sem assinante ativo', aceita: false });
        }
        return respostaJson(200, {
            status: 'Ordem Redis aceita pelo transporte local',
            duplicada: false,
            dados: { order_id: orderId, alvo: dados.alvo, valor: dados.valor }
        });
    } catch (erro) {
        console.error(`⚠️ Redis place_bet ${orderId}:`, erro.message);
        return respostaJson(503, { erro: 'transporte Redis do executor indisponível', aceita: false });
    }
}

function instalarRedisRuntime() {
    if (instalado) return;
    const atual = Number(process.env.BALANCE_SYNC_RESPONSE_TIMEOUT_MS);
    if (!Number.isFinite(atual) || atual < 20000) process.env.BALANCE_SYNC_RESPONSE_TIMEOUT_MS = '20000';
    if (typeof globalThis.fetch !== 'function' || typeof globalThis.Response !== 'function') {
        throw new Error('Runtime Node sem fetch/Response nativos');
    }
    fetchOriginal = globalThis.fetch.bind(globalThis);
    globalThis.fetch = fetchRedis;
    instalado = true;
    void garantirRedis().catch(erro => {
        console.error('⚠️ Redis runtime não conectou no bootstrap:', erro.message);
        agendarReconexao();
    });
    console.log(`🔌 Redis Runtime V2: ${BACBO_EVENTS_CHANNEL} -> ROAD/LIVE -> Node; ${REDIS_COMMAND_CHANNEL} -> executor.`);
}

module.exports = {
    instalarRedisRuntime,
    normalizarLive,
    normalizarSnapshot,
    extrairVencedor,
    extrairPlacar
};
