'use strict';

const path = require('path');

let instalado = false;
let publisher = null;
let responseSubscriber = null;
let bacboSubscriber = null;
let inicializacaoRedis = null;
let fetchOriginal = null;
let timerReconexaoRedis = null;
let caudaBacbo = Promise.resolve();
let sequenciaBacboLocal = 0;

const REDIS_COMMAND_CHANNEL = 'auto_trader_commands';
const REDIS_RESPONSE_CHANNEL = 'auto_trader_responses';
const BACBO_EVENTS_CHANNEL = 'bacbo_events';
const STATUS_VALIDOS = new Set(['EXECUTADA', 'FALHOU', 'EXPIRADA', 'AMBIGUA']);
const BACBO_SESSION = `tipminer-bacbo-events-${process.pid}-${Date.now()}`;
const BACBO_DEDUP_MAX = 2000;
const fingerprintsBacbo = new Map();

function configurarTimeoutMinimoSaldo() {
    const atual = Number(process.env.BALANCE_SYNC_RESPONSE_TIMEOUT_MS);
    if (!Number.isFinite(atual) || atual < 20000) process.env.BALANCE_SYNC_RESPONSE_TIMEOUT_MS = '20000';
}

function carregarAmbiente() {
    require('./env_loader').loadEnvFile(path.join(__dirname, '..', '.env'));
}

function urlExecutorConfigurada() {
    return String(process.env.EXECUTOR_URL || 'http://127.0.0.1:5000/apostar').trim();
}

function hostNodeLocal() {
    let host = String(process.env.NODE_HOST || '127.0.0.1').trim() || '127.0.0.1';
    if (host === '0.0.0.0' || host === '::' || host === '[::]') host = '127.0.0.1';
    return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function portaNode() {
    return Number(process.env.NODE_PORT || 3000);
}

function urlExecutorStatusNode() {
    return `http://${hostNodeLocal()}:${portaNode()}/executor-status`;
}

function urlReceberSinalNode() {
    return `http://${hostNodeLocal()}:${portaNode()}/receber-sinal`;
}

function urlCollectorRoadNode() {
    return `http://${hostNodeLocal()}:${portaNode()}/collector-road`;
}

function normalizarUrl(valor) {
    try {
        return new URL(String(valor)).href;
    } catch (e) {
        return String(valor || '');
    }
}

function objeto(valor) {
    return valor && typeof valor === 'object' && !Array.isArray(valor) ? valor : null;
}

function primeiroDefinido(...valores) {
    for (const valor of valores) {
        if (valor !== undefined && valor !== null && valor !== '') return valor;
    }
    return undefined;
}

function corpoJsonDaRequisicao(init) {
    const body = init && init.body;
    if (typeof body !== 'string') return null;
    try {
        return objeto(JSON.parse(body));
    } catch (e) {
        return null;
    }
}

function normalizarVencedor(valor, profundidade = 0) {
    if (profundidade > 4 || valor === undefined || valor === null) return '';
    if (typeof valor === 'object') {
        const item = objeto(valor);
        if (!item) return '';
        return normalizarVencedor(primeiroDefinido(
            item.winner,
            item.vencedor,
            item.result,
            item.resultado,
            item.outcome,
            item.value,
            item.name,
            item.type
        ), profundidade + 1);
    }

    const texto = String(valor).trim().toUpperCase();
    if (!texto) return '';
    if (['P', 'PLAYER', 'PLAYERWON', 'PLAYER_WON', 'JOGADOR', 'AZUL'].includes(texto)) return 'Player';
    if (['B', 'BANKER', 'BANKERWON', 'BANKER_WON', 'BANCA', 'VERMELHO'].includes(texto)) return 'Banker';
    if (['T', 'TIE', 'TIEWON', 'TIE_WON', 'DRAW', 'EMPATE'].includes(texto)) return 'Tie';
    if (texto.includes('PLAYER')) return 'Player';
    if (texto.includes('BANKER')) return 'Banker';
    if (texto.includes('TIE')) return 'Tie';
    return '';
}

function timestampMs(valor) {
    if (valor === undefined || valor === null || valor === '') return Date.now();
    const numero = Number(valor);
    if (Number.isFinite(numero) && numero > 0) {
        if (numero >= 1e12) return Math.trunc(numero);
        if (numero >= 1e9) return Math.trunc(numero * 1000);
    }
    const data = Date.parse(String(valor));
    return Number.isFinite(data) ? data : Date.now();
}

function numeroScore(...valores) {
    for (const valor of valores) {
        if (valor === undefined || valor === null || valor === '' || typeof valor === 'boolean') continue;
        const numero = Number(valor);
        if (Number.isFinite(numero) && numero >= 0 && numero <= 12) return numero;
    }
    return null;
}

function arrayDadosValido(valor) {
    if (!Array.isArray(valor) || valor.length === 0) return null;
    const dados = valor.map(Number);
    if (dados.some(item => !Number.isInteger(item) || item < 1 || item > 6)) return null;
    return dados;
}

function placarBacbo(dados) {
    const origem = objeto(dados) || {};
    const scores = objeto(origem.scores) || {};
    let dadosJogador = arrayDadosValido(origem.dados_jogador);
    let dadosBanca = arrayDadosValido(origem.dados_banca);

    const dice = Array.isArray(origem.dice) ? origem.dice : [];
    if ((!dadosJogador || !dadosBanca) && dice.length > 0) {
        const porId = new Map();
        for (const item of dice) {
            if (!objeto(item)) continue;
            const id = Number(item.id);
            const value = Number(item.value);
            if (Number.isInteger(id) && id >= 1 && id <= 4 && Number.isInteger(value) && value >= 1 && value <= 6) {
                porId.set(id, value);
            }
        }
        if (!dadosJogador && porId.has(1) && porId.has(3)) dadosJogador = [porId.get(1), porId.get(3)];
        if (!dadosBanca && porId.has(2) && porId.has(4)) dadosBanca = [porId.get(2), porId.get(4)];
    }

    let playerScore = numeroScore(
        origem.playerScore,
        origem.player_score,
        scores.playerScore,
        scores.player,
        origem.pontos_jogador
    );
    let bankerScore = numeroScore(
        origem.bankerScore,
        origem.banker_score,
        scores.bankerScore,
        scores.banker,
        origem.pontos_banca
    );
    if (playerScore === null && dadosJogador) playerScore = dadosJogador.reduce((total, item) => total + item, 0);
    if (bankerScore === null && dadosBanca) bankerScore = dadosBanca.reduce((total, item) => total + item, 0);
    return { playerScore, bankerScore, dadosJogador, dadosBanca };
}

function dadosEventoBacbo(raiz) {
    const root = objeto(raiz) || {};
    const data = objeto(root.data) || objeto(root.payload) || objeto(root.event) || {};
    const args = objeto(data.args) || objeto(root.args) || {};
    const game = objeto(data.game) || objeto(args.game) || objeto(root.game) || {};
    return { ...root, ...game, ...data };
}

function sessaoBacbo(raiz, dados) {
    return String(primeiroDefinido(
        dados.coletor_sessao,
        raiz.coletor_sessao,
        dados.session_id,
        dados.sessionId,
        raiz.session_id,
        raiz.sessionId,
        BACBO_SESSION
    )).trim().slice(0, 128) || BACBO_SESSION;
}

function sequenciaBacbo(raiz, dados) {
    const recebida = Number(primeiroDefinido(
        dados.coletor_seq,
        raiz.coletor_seq,
        dados.seq,
        dados.sequence,
        raiz.seq,
        raiz.sequence
    ));
    if (Number.isSafeInteger(recebida) && recebida > 0) {
        sequenciaBacboLocal = Math.max(sequenciaBacboLocal, recebida);
        return recebida;
    }
    return ++sequenciaBacboLocal;
}

function timestampEventoBacbo(raiz, dados) {
    return timestampMs(primeiroDefinido(
        dados.timestamp_coleta,
        dados.instant,
        dados.timestamp,
        dados.ts,
        dados.created_at,
        dados.createdAt,
        raiz.timestamp_coleta,
        raiz.instant,
        raiz.timestamp,
        raiz.ts,
        raiz.created_at,
        raiz.createdAt
    ));
}

function uuidBacbo(raiz, dados) {
    return String(primeiroDefinido(
        dados.uuid,
        dados.id,
        dados.round_id,
        dados.roundId,
        raiz.uuid,
        raiz.id,
        raiz.round_id,
        raiz.roundId
    ) || '').trim();
}

function eventoBacboDuplicado(chave) {
    const uuid = String(chave || '').trim();
    if (!uuid) return false;
    if (fingerprintsBacbo.has(uuid)) return true;
    fingerprintsBacbo.set(uuid, Date.now());
    while (fingerprintsBacbo.size > BACBO_DEDUP_MAX) fingerprintsBacbo.delete(fingerprintsBacbo.keys().next().value);
    return false;
}

function normalizarLiveBacbo(raiz) {
    if (!objeto(raiz) || String(raiz.action || '').trim().toLowerCase() !== 'live_round') return null;
    const dados = dadosEventoBacbo(raiz);
    const vencedor = normalizarVencedor(primeiroDefinido(
        dados.vencedor,
        dados.resultado,
        dados.winner,
        dados.result,
        dados.outcome,
        dados.type
    ));
    if (!vencedor) return null;

    const uuid = uuidBacbo(raiz, dados);
    if (eventoBacboDuplicado(uuid)) return null;

    const placar = placarBacbo(dados);
    const payload = { ...dados };
    payload.vencedor = vencedor;
    payload.resultado = vencedor;
    payload.winner = vencedor;
    payload.coletor_sessao = sessaoBacbo(raiz, dados);
    payload.coletor_seq = sequenciaBacbo(raiz, dados);
    payload.timestamp_coleta = timestampEventoBacbo(raiz, dados);
    payload.fonte = 'TipMiner';
    payload.redis_channel = BACBO_EVENTS_CHANNEL;
    payload.tipminer_uuid = uuid || null;

    if (placar.playerScore !== null) {
        payload.playerScore = placar.playerScore;
        if (payload.pontos_jogador === undefined || payload.pontos_jogador === null) payload.pontos_jogador = placar.playerScore;
    }
    if (placar.bankerScore !== null) {
        payload.bankerScore = placar.bankerScore;
        if (payload.pontos_banca === undefined || payload.pontos_banca === null) payload.pontos_banca = placar.bankerScore;
    }
    if (placar.dadosJogador) payload.dados_jogador = placar.dadosJogador;
    if (placar.dadosBanca) payload.dados_banca = placar.dadosBanca;
    return payload;
}

function extrairHistoryBacbo(raiz) {
    const data = raiz && raiz.data;
    const payload = raiz && raiz.payload;
    const event = raiz && raiz.event;
    const candidatos = [
        Array.isArray(data) ? data : null,
        objeto(data)?.history,
        objeto(data)?.args?.history,
        Array.isArray(payload) ? payload : null,
        objeto(payload)?.history,
        objeto(payload)?.args?.history,
        Array.isArray(event) ? event : null,
        objeto(event)?.history,
        objeto(event)?.args?.history,
        raiz && raiz.history,
        objeto(raiz && raiz.args)?.history
    ];
    return candidatos.find(item => Array.isArray(item) && item.length > 0) || null;
}

function normalizarItemHistoryBacbo(item) {
    if (!objeto(item)) return null;
    const dados = dadosEventoBacbo(item);
    const vencedor = normalizarVencedor(primeiroDefinido(
        dados.winner,
        dados.vencedor,
        dados.result,
        dados.resultado,
        dados.outcome,
        dados.type
    ));
    const placar = placarBacbo(dados);
    if (!vencedor || placar.playerScore === null || placar.bankerScore === null) return null;
    return { winner: vencedor, playerScore: placar.playerScore, bankerScore: placar.bankerScore };
}

function normalizarSnapshotBacbo(raiz) {
    if (!objeto(raiz)) return null;
    const history = extrairHistoryBacbo(raiz);
    if (!history || history.length === 0 || history.length > 1000) return null;
    const normalizado = history.map(normalizarItemHistoryBacbo);
    if (normalizado.some(item => item === null)) return null;
    const dados = dadosEventoBacbo(raiz);
    return {
        evento: 'ROAD_SNAPSHOT',
        coletor_sessao: sessaoBacbo(raiz, dados),
        timestamp_coleta: timestampEventoBacbo(raiz, dados),
        history: normalizado
    };
}

function parseMensagemBacbo(mensagem) {
    try {
        const raiz = typeof mensagem === 'string' || Buffer.isBuffer(mensagem)
            ? JSON.parse(Buffer.isBuffer(mensagem) ? mensagem.toString('utf8') : mensagem)
            : mensagem;
        return objeto(raiz);
    } catch (e) {
        return null;
    }
}

function normalizarPayloadTipMiner(mensagem, canal = BACBO_EVENTS_CHANNEL) {
    if (canal !== BACBO_EVENTS_CHANNEL) return null;
    const raiz = parseMensagemBacbo(mensagem);
    return raiz ? normalizarLiveBacbo(raiz) : null;
}

async function postInternoNode(url, payload, descricao, maxTentativas = 60) {
    const token = String(process.env.INTERNAL_API_TOKEN || '').trim();
    if (!token) {
        console.error(`⚠️ ${descricao}: INTERNAL_API_TOKEN ausente.`);
        return false;
    }

    let ultimoErro = null;
    for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
        try {
            const resposta = await fetchOriginal(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Internal-Token': token
                },
                body: JSON.stringify(payload)
            });
            if (resposta.ok) return true;
            ultimoErro = new Error(`HTTP ${resposta.status}`);
            if (resposta.status !== 503) break;
        } catch (e) {
            ultimoErro = e;
        }
        if (tentativa < maxTentativas) await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.error(
        `⚠️ ${descricao}: falha ao entregar evento ao Node:`,
        ultimoErro && ultimoErro.message ? ultimoErro.message : ultimoErro
    );
    return false;
}

async function encaminharBetResultAoNode(dados) {
    const orderId = String(dados && dados.order_id || '').trim().toLowerCase();
    const status = String(dados && dados.status || '').trim().toUpperCase();
    if (!orderId || !STATUS_VALIDOS.has(status)) return false;
    return postInternoNode(
        urlExecutorStatusNode(),
        {
            order_id: orderId,
            status,
            motivo: String(dados.motivo || '').slice(0, 300),
            confirmacao: dados.confirmacao || null
        },
        `Redis executor bridge bet_result ${orderId}`,
        3
    );
}

async function processarMensagemBacbo(mensagem) {
    const raiz = parseMensagemBacbo(mensagem);
    if (!raiz) {
        console.warn('⚠️ bacbo_events ignorado: JSON inválido.');
        return false;
    }

    if (String(raiz.action || '').trim().toLowerCase() === 'live_round') {
        const payload = normalizarLiveBacbo(raiz);
        if (!payload) {
            console.warn('⚠️ bacbo_events live_round ignorado: vencedor/payload inválido ou duplicado.');
            return false;
        }
        const entregue = await postInternoNode(
            urlReceberSinalNode(),
            payload,
            `bacbo_events live_round ${payload.tipminer_uuid || payload.coletor_seq}`
        );
        if (entregue) console.log(`📡 TipMiner LIVE -> Node | seq=${payload.coletor_seq} | vencedor=${payload.vencedor}`);
        return entregue;
    }

    const historyBruto = extrairHistoryBacbo(raiz);
    if (!historyBruto) return false;
    const snapshot = normalizarSnapshotBacbo(raiz);
    if (!snapshot) {
        console.warn(`⚠️ bacbo_events histórico ignorado: ${historyBruto.length} item(ns) sem winner/playerScore/bankerScore válidos.`);
        return false;
    }
    const entregue = await postInternoNode(
        urlCollectorRoadNode(),
        snapshot,
        `bacbo_events ROAD snapshot (${snapshot.history.length})`
    );
    if (entregue) console.log(`🧠 TipMiner ROAD -> Node | ${snapshot.history.length} resultado(s) históricos.`);
    return entregue;
}

function enfileirarMensagemBacbo(mensagem) {
    const executar = () => processarMensagemBacbo(mensagem);
    caudaBacbo = caudaBacbo.then(executar, executar).catch(erro => {
        console.error('⚠️ bacbo_events: falha inesperada na fila serial:', erro.message);
    });
}

function clienteRedisPronto(cliente) {
    return Boolean(cliente && (cliente.isReady === true || cliente.ready === true || cliente.connected === true));
}

async function conectarClienteRedis(cliente) {
    if (!cliente || typeof cliente.connect !== 'function') return;
    if (cliente.isOpen === true || clienteRedisPronto(cliente)) return;
    await cliente.connect();
}

function agendarReconexaoRedis() {
    if (!instalado || timerReconexaoRedis) return;
    timerReconexaoRedis = setTimeout(() => {
        timerReconexaoRedis = null;
        void garantirRedisPronto().catch(erro => {
            console.error('⚠️ Redis bridge indisponível; nova tentativa agendada:', erro.message);
            agendarReconexaoRedis();
        });
    }, 2000);
    if (timerReconexaoRedis && typeof timerReconexaoRedis.unref === 'function') timerReconexaoRedis.unref();
}

function registrarEventosCliente(cliente, nome, aoFechar) {
    cliente.on('error', erro => console.error(`⚠️ Redis ${nome}:`, erro.message));
    const fechado = () => {
        if (typeof aoFechar === 'function') aoFechar();
        agendarReconexaoRedis();
    };
    cliente.on('end', fechado);
    cliente.on('close', fechado);
}

function criarClientesRedis() {
    const { createClient } = require('redis');
    const redisUrl = String(process.env.REDIS_URL || 'redis://127.0.0.1:6379').trim() || 'redis://127.0.0.1:6379';
    const timeoutConfig = Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 3000);
    const connectTimeout = Number.isFinite(timeoutConfig) ? Math.max(500, Math.min(15000, timeoutConfig)) : 3000;
    const opcoes = { url: redisUrl, socket: { connectTimeout, reconnectStrategy: () => false } };

    if (!publisher) {
        publisher = createClient(opcoes);
        registrarEventosCliente(publisher, 'bridge publisher');
    }
    if (!responseSubscriber) {
        responseSubscriber = publisher.duplicate();
        registrarEventosCliente(responseSubscriber, 'bridge responses subscriber', () => {
            responseSubscriber.__bacboResponsesSubscribed = false;
        });
    }
    if (!bacboSubscriber) {
        bacboSubscriber = publisher.duplicate();
        registrarEventosCliente(bacboSubscriber, 'bacbo_events subscriber', () => {
            bacboSubscriber.__bacboEventsSubscribed = false;
        });
    }
}

async function garantirRedisPronto() {
    if (
        clienteRedisPronto(publisher)
        && clienteRedisPronto(responseSubscriber)
        && clienteRedisPronto(bacboSubscriber)
        && responseSubscriber.__bacboResponsesSubscribed
        && bacboSubscriber.__bacboEventsSubscribed
    ) return true;
    if (inicializacaoRedis) return inicializacaoRedis;

    inicializacaoRedis = (async () => {
        criarClientesRedis();
        await conectarClienteRedis(publisher);
        await conectarClienteRedis(responseSubscriber);
        await conectarClienteRedis(bacboSubscriber);

        if (!responseSubscriber.__bacboResponsesSubscribed) {
            await responseSubscriber.subscribe(REDIS_RESPONSE_CHANNEL, mensagem => {
                let dados = null;
                try {
                    dados = JSON.parse(String(mensagem || ''));
                } catch (e) {
                    return;
                }
                if (!dados || dados.action !== 'bet_result') return;
                void encaminharBetResultAoNode(dados);
            });
            responseSubscriber.__bacboResponsesSubscribed = true;
        }

        if (!bacboSubscriber.__bacboEventsSubscribed) {
            await bacboSubscriber.subscribe(BACBO_EVENTS_CHANNEL, mensagem => enfileirarMensagemBacbo(mensagem));
            bacboSubscriber.__bacboEventsSubscribed = true;
            console.log(`🎧 TipMiner Redis ativo em ${BACBO_EVENTS_CHANNEL}: histórico + live_round.`);
        }
        return true;
    })();

    try {
        return await inicializacaoRedis;
    } finally {
        inicializacaoRedis = null;
    }
}

function respostaJson(status, corpo) {
    return new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
}

async function fetchComExecutorRedis(input, init = {}) {
    const alvo = typeof input === 'string' || input instanceof URL ? String(input) : String(input && input.url || '');
    const metodo = String(init.method || (input && input.method) || 'GET').toUpperCase();
    if (metodo !== 'POST' || normalizarUrl(alvo) !== normalizarUrl(urlExecutorConfigurada())) return fetchOriginal(input, init);

    const dados = corpoJsonDaRequisicao(init);
    const orderId = String(dados && dados.order_id || '').trim().toLowerCase();
    if (!dados || !orderId) return respostaJson(400, { erro: 'order_id ausente no transporte Redis', aceita: false });

    try {
        await garantirRedisPronto();
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
    } catch (e) {
        console.error(`⚠️ Redis executor bridge: falha ao publicar place_bet ${orderId}:`, e.message);
        return respostaJson(503, { erro: 'transporte Redis do executor indisponivel', aceita: false });
    }
}

function instalarRedisExecutorBridge() {
    if (instalado) return;
    carregarAmbiente();
    configurarTimeoutMinimoSaldo();
    if (typeof globalThis.fetch !== 'function' || typeof globalThis.Response !== 'function') {
        throw new Error('Runtime Node sem fetch/Response nativos; Redis executor bridge nao pode ser instalado');
    }
    fetchOriginal = globalThis.fetch.bind(globalThis);
    globalThis.fetch = fetchComExecutorRedis;
    instalado = true;
    void garantirRedisPronto().catch(erro => {
        console.error('⚠️ Redis bridge não conectou no bootstrap:', erro.message);
        agendarReconexaoRedis();
    });
    console.log(`🔌 Redis ingress ativo: ${BACBO_EVENTS_CHANNEL} -> ROAD/LIVE -> Node; ${REDIS_COMMAND_CHANNEL} -> executor.`);
}

module.exports = {
    instalarRedisExecutorBridge,
    configurarTimeoutMinimoSaldo,
    normalizarPayloadTipMiner,
    normalizarSnapshotBacbo
};
