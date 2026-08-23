'use strict';

const {
    parseMensagem,
    normalizarTipoBacbo,
    validarLiveRound
} = require('./bacbo_payload_schema');
const {
    garantirSchema,
    persistirRodadaBacbo,
    persistirHistoricoBacbo
} = require('./bacbo_round_store');

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
const DEDUP_MAX = 5000;
const fingerprints = new Map();
const ROAD_SNAPSHOT_KEY = 'robo_bacbo:last_road_snapshot';
const RECENT_ROUNDS_KEY = 'robo_bacbo:recent_rounds_v3';

function objeto(valor) {
    return valor && typeof valor === 'object' && !Array.isArray(valor) ? valor : null;
}

function configurarTimeoutMinimoSaldo() {
    const atual = Number(process.env.BALANCE_SYNC_RESPONSE_TIMEOUT_MS);
    if (!Number.isFinite(atual) || atual < 20000) process.env.BALANCE_SYNC_RESPONSE_TIMEOUT_MS = '20000';
}

function acaoEvento(raiz) {
    const root = objeto(raiz) || {};
    return String(root.action || root.eventAction || '').trim().toLowerCase();
}

function extrairHistory(raiz) {
    const root = objeto(raiz);
    if (!root) return null;
    if (Array.isArray(root.data) && root.data.length > 0) return root.data;
    if (Array.isArray(root.history) && root.history.length > 0) return root.history;

    for (const chave of ['data', 'payload', 'event']) {
        const bloco = objeto(root[chave]);
        if (!bloco) continue;
        if (Array.isArray(bloco.history) && bloco.history.length > 0) return bloco.history;
        if (bloco.args && Array.isArray(bloco.args.history) && bloco.args.history.length > 0) {
            return bloco.args.history;
        }
    }

    if (root.args && Array.isArray(root.args.history) && root.args.history.length > 0) {
        return root.args.history;
    }
    return null;
}

function numero(valor) {
    if (valor === undefined || valor === null || valor === '' || typeof valor === 'boolean') return null;
    const n = Number(valor);
    return Number.isFinite(n) ? n : null;
}

function normalizarRoadLegado(item) {
    const dados = objeto(item);
    if (!dados) return null;
    const winner = normalizarTipoBacbo(dados.winner || dados.type || dados.vencedor || dados.resultado);
    const playerScore = numero(dados.playerScore ?? dados.player_score);
    const bankerScore = numero(dados.bankerScore ?? dados.banker_score);
    if (!winner || playerScore === null || bankerScore === null) return null;
    return { winner, playerScore, bankerScore };
}

function snapshotRoadLegado(raiz, history) {
    const itens = Array.isArray(history) ? history : [];
    if (itens.length === 0 || itens.length > 1000) return null;
    const normalizados = itens.map(normalizarRoadLegado);
    if (normalizados.some(item => item === null)) return null;
    return {
        evento: 'ROAD_SNAPSHOT',
        coletor_sessao: String(objeto(raiz)?.coletor_sessao || SESSION_LOCAL),
        timestamp_coleta: Date.now(),
        history: normalizados
    };
}

function payloadNode(round) {
    const payload = {
        uuid: round.uuid,
        round_uuid: round.uuid,
        tipminer_uuid: round.uuid,
        type: round.type,
        result: round.result,
        resultado_soma: round.result,
        instant: round.instant,
        timestamp_coleta: round.timestamp_ms,
        vencedor: round.winner_legacy,
        resultado: round.winner,
        winner: round.winner,
        resultado_ia: round.winner,
        resultado_sigla: round.winner_symbol,
        coletor_sessao: SESSION_LOCAL,
        coletor_seq: ++sequenciaLocal,
        fonte: 'TipMiner',
        redis_channel: BACBO_EVENTS_CHANNEL
    };

    // Compatibilidade somente com somas; nenhum dado individual e criado ou inferido.
    if (round.winner === 'Player') payload.pontos_jogador = round.result;
    else if (round.winner === 'Banker') payload.pontos_banca = round.result;
    else if (round.winner === 'Tie') {
        payload.pontos_jogador = round.result;
        payload.pontos_banca = round.result;
    }

    return payload;
}

function rodadaJaProcessada(uuid) {
    return fingerprints.has(uuid);
}

function marcarRodadaProcessada(uuid) {
    fingerprints.set(uuid, Date.now());
    while (fingerprints.size > DEDUP_MAX) fingerprints.delete(fingerprints.keys().next().value);
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
                headers: {
                    'Content-Type': 'application/json',
                    'X-Internal-Token': token
                },
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

async function persistirRetencaoRedis(round) {
    if (!publisher) return;
    try {
        await publisher.lPush(RECENT_ROUNDS_KEY, JSON.stringify({
            uuid: round.uuid,
            type: round.type,
            result: round.result,
            instant: round.instant
        }));
        await publisher.lTrim(RECENT_ROUNDS_KEY, 0, 999);
    } catch (_) { }
}

async function processarLiveRound(raiz) {
    const validacao = validarLiveRound(raiz);
    if (!validacao.ok) {
        console.warn(`⚠️ bacbo_events live_round rejeitado | motivo=${validacao.erro}.`);
        return false;
    }

    const round = validacao.round;
    if (rodadaJaProcessada(round.uuid)) {
        console.log(`↩️ bacbo_events live_round duplicado ignorado | uuid=${round.uuid}.`);
        return false;
    }

    try {
        await persistirRodadaBacbo(round);
    } catch (erro) {
        // O motor ao vivo nao e derrubado por indisponibilidade temporaria do banco canonico.
        console.error(`⚠️ Persistencia bacbo_rounds falhou | uuid=${round.uuid}:`, erro.message);
    }

    const payload = payloadNode(round);
    const entregue = await postNode('/receber-sinal', payload, `LIVE ${round.uuid}`);
    if (!entregue) return false;

    marcarRodadaProcessada(round.uuid);
    await persistirRetencaoRedis(round);
    console.log(`📡 TipMiner LIVE -> Node | uuid=${round.uuid} | vencedor=${round.winner} | soma=${round.result}`);
    return true;
}

async function processarHistorico(raiz, history) {
    const itens = Array.isArray(history) ? history : [];
    if (itens.length === 0) return false;

    const validacoes = itens.map(item => validarLiveRound(item));
    const roundsNovos = validacoes.filter(v => v.ok).map(v => v.round);
    if (roundsNovos.length === itens.length) {
        try {
            const persistidos = await persistirHistoricoBacbo(roundsNovos);
            console.log(`🧠 TipMiner HISTORY schema novo persistido | ${persistidos} rodada(s).`);
            return true;
        } catch (erro) {
            console.error('⚠️ Persistencia do historico BacBo falhou:', erro.message);
            return false;
        }
    }

    const snapshot = snapshotRoadLegado(raiz, itens);
    if (!snapshot) {
        console.warn(`⚠️ bacbo_events histórico rejeitado | schema novo=${roundsNovos.length}/${itens.length}; ROAD legado inválido.`);
        return false;
    }

    const entregue = await postNode('/collector-road', snapshot, 'ROAD legado');
    if (entregue) {
        try { await publisher.set(ROAD_SNAPSHOT_KEY, JSON.stringify(snapshot)); } catch (_) { }
        console.log(`🧠 TipMiner ROAD -> Node | ${snapshot.history.length} resultado(s) históricos.`);
    }
    return entregue;
}

async function processarBacbo(mensagem) {
    const raiz = parseMensagem(mensagem);
    if (!raiz) {
        console.warn('⚠️ bacbo_events ignorado: JSON/payload inválido.');
        return false;
    }

    const acao = acaoEvento(raiz);
    const payloadPossivelmenteLive = objeto(raiz.data) || raiz;
    const possuiSchemaLive = payloadPossivelmenteLive
        && payloadPossivelmenteLive.uuid !== undefined
        && payloadPossivelmenteLive.type !== undefined
        && payloadPossivelmenteLive.result !== undefined;

    if (acao === 'live_round' || (!acao && possuiSchemaLive)) {
        return processarLiveRound(raiz);
    }

    const history = extrairHistory(raiz);
    if (history) return processarHistorico(raiz, history);
    return false;
}

function enfileirarBacbo(mensagem) {
    const executar = () => processarBacbo(mensagem);
    filaBacbo = filaBacbo.then(executar, executar).catch(erro => {
        console.error('⚠️ fila bacbo_events:', erro.message);
    });
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
            console.error('⚠️ Redis runtime V3 indisponível; nova tentativa:', erro.message);
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
        registrarEventos(responseSubscriber, 'responses', () => {
            responseSubscriber.__subscribed = false;
        });
    }
    if (!bacboSubscriber) {
        bacboSubscriber = publisher.duplicate();
        registrarEventos(bacboSubscriber, 'bacbo_events', () => {
            bacboSubscriber.__subscribed = false;
        });
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
    if (
        clientePronto(publisher)
        && clientePronto(responseSubscriber)
        && clientePronto(bacboSubscriber)
        && responseSubscriber.__subscribed
        && bacboSubscriber.__subscribed
    ) return true;
    if (inicializacaoRedis) return inicializacaoRedis;

    inicializacaoRedis = (async () => {
        criarClientes();
        await conectar(publisher);
        await conectar(responseSubscriber);
        await conectar(bacboSubscriber);

        if (!responseSubscriber.__subscribed) {
            await responseSubscriber.subscribe(REDIS_RESPONSE_CHANNEL, mensagem => {
                const dados = parseMensagem(mensagem);
                if (!dados || dados.action !== 'bet_result') return;
                void encaminharBetResult(dados);
            });
            responseSubscriber.__subscribed = true;
        }

        if (!bacboSubscriber.__subscribed) {
            await bacboSubscriber.subscribe(BACBO_EVENTS_CHANNEL, mensagem => enfileirarBacbo(mensagem));
            bacboSubscriber.__subscribed = true;
            console.log(`🎧 TipMiner Redis V3 ativo em ${BACBO_EVENTS_CHANNEL}: uuid + type + result.`);
        }
        return true;
    })();

    try {
        return await inicializacaoRedis;
    } finally {
        inicializacaoRedis = null;
    }
}

function urlExecutorConfigurada() {
    return String(process.env.EXECUTOR_URL || 'http://127.0.0.1:5000/apostar').trim();
}

function normalizarUrl(valor) {
    try { return new URL(String(valor)).href; } catch (_) { return String(valor || ''); }
}

function corpoJson(init) {
    if (!init || typeof init.body !== 'string') return null;
    try {
        const parsed = JSON.parse(init.body);
        return objeto(parsed);
    } catch (_) {
        return null;
    }
}

function respostaJson(status, corpo) {
    return new Response(JSON.stringify(corpo), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

async function fetchComExecutorRedis(input, init = {}) {
    const alvo = typeof input === 'string' || input instanceof URL
        ? String(input)
        : String(input?.url || '');
    const metodo = String(init.method || input?.method || 'GET').toUpperCase();
    if (metodo !== 'POST' || normalizarUrl(alvo) !== normalizarUrl(urlExecutorConfigurada())) {
        return fetchOriginal(input, init);
    }

    const dados = corpoJson(init);
    const orderId = String(dados?.order_id || '').trim().toLowerCase();
    if (!dados || !orderId) {
        return respostaJson(400, { erro: 'order_id ausente no transporte Redis', aceita: false });
    }

    try {
        await garantirRedis();
        const comando = {
            action: 'place_bet',
            order_id: orderId,
            alvo: dados.alvo,
            valor: dados.valor
        };
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
        console.error(`⚠️ Redis executor V3: falha ao publicar place_bet ${orderId}:`, erro.message);
        return respostaJson(503, { erro: 'transporte Redis do executor indisponível', aceita: false });
    }
}

function instalarRedisRuntimeV3() {
    if (instalado) return;
    configurarTimeoutMinimoSaldo();
    if (typeof globalThis.fetch !== 'function' || typeof globalThis.Response !== 'function') {
        throw new Error('Runtime Node sem fetch/Response nativos');
    }

    fetchOriginal = globalThis.fetch.bind(globalThis);
    globalThis.fetch = fetchComExecutorRedis;
    instalado = true;

    void garantirSchema().catch(erro => {
        console.error('⚠️ Schema bacbo_rounds não inicializou no bootstrap:', erro.message);
    });
    void garantirRedis().catch(erro => {
        console.error('⚠️ Redis runtime V3 não conectou no bootstrap:', erro.message);
        agendarReconexao();
    });

    console.log(`🔌 Redis Runtime V3: ${BACBO_EVENTS_CHANNEL} -> schema novo -> Node; ${REDIS_COMMAND_CHANNEL} -> executor.`);
}

module.exports = {
    instalarRedisRuntimeV3,
    processarBacbo,
    payloadNode
};
