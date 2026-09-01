'use strict';

const {
    parseMensagem,
    extrairPayloadLive,
    normalizarTipoBacbo,
    validarLiveRound
} = require('./bacbo_payload_schema');
const {
    garantirSchema,
    persistirRodadaBacbo,
    persistirHistoricoBacbo
} = require('./bacbo_round_store');
const {
    obterEscopoRedisMesa
} = require('./mesa_redis_scope');
const {
    buildPlaceBetSignal
} = require('./global_signal_publisher');

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
const GLOBAL_SIGNAL_CHANNEL = String(process.env.SIGNAL_ROUTER_GLOBAL_CHANNEL || 'global_signals').trim();
const GLOBAL_SIGNAL_RESULT_CHANNEL = String(process.env.SIGNAL_ROUTER_RESULT_CHANNEL || 'global_signal_results').trim();

const ESCOPO_REDIS_MESA =
    obterEscopoRedisMesa();

const BACBO_EVENTS_CHANNEL =
    ESCOPO_REDIS_MESA.eventsChannel;

const STATUS_VALIDOS =
    new Set([
        'EXECUTADA',
        'FALHOU',
        'EXPIRADA',
        'AMBIGUA'
    ]);

const SESSION_LOCAL =
    `tipminer-${ESCOPO_REDIS_MESA.codigo}-`
    + `${process.pid}-${Date.now()}`;

const DEDUP_MAX = 5000;
const fingerprints = new Map();

const ROAD_SNAPSHOT_KEY =
    ESCOPO_REDIS_MESA.roadSnapshotKey;

const RECENT_ROUNDS_KEY =
    ESCOPO_REDIS_MESA.recentRoundsKey;

const LIVE_DELIVERY_ATTEMPTS =
    Number.POSITIVE_INFINITY;

function objeto(valor) {
    return valor && typeof valor === 'object' && !Array.isArray(valor) ? valor : null;
}

function envBoolean(nome, padrao = false) {
    const bruto = String(process.env[nome] ?? '').trim().toLowerCase();
    if (!bruto) return padrao;
    if (['1', 'true', 'yes', 'on', 'sim'].includes(bruto)) return true;
    if (['0', 'false', 'no', 'off', 'nao', 'não'].includes(bruto)) return false;
    throw new Error(`REDIS_RUNTIME_INVALID_${nome}: ${bruto}`);
}

function multiAccountRouterEnabled() {
    return envBoolean('AUTO_TRADER_MULTI_ACCOUNT_ROUTER_ENABLED', false);
}

function tableKeyRuntime() {
    const codigo = String(ESCOPO_REDIS_MESA.codigo || '').trim().toUpperCase();
    if (codigo === 'BR' || codigo === 'BACBO_BR') return 'bacbo_br';
    if (codigo === 'INT' || codigo === 'BACBO_INT') return 'bacbo_int';
    throw new Error(`MULTI_ACCOUNT_TABLE_KEY_UNSUPPORTED: ${codigo || '<empty>'}`);
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
        mesa_id: ESCOPO_REDIS_MESA.mesaId,
        mesa_codigo: ESCOPO_REDIS_MESA.codigo,
        coletor_sessao: String(objeto(raiz)?.coletor_sessao || SESSION_LOCAL),
        timestamp_coleta: Date.now(),
        history: normalizados
    };
}

function payloadNode(round) {
    const payload = {
        mesa_id: ESCOPO_REDIS_MESA.mesaId,
        mesa_codigo: ESCOPO_REDIS_MESA.codigo,
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
    let aguardandoBackend = false;
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
            if (resposta.ok) {
                if (aguardandoBackend && path === '/receber-sinal') {
                    console.log('✅ Fila live liberada | backend pronto; processamento retomado em ordem.');
                }
                return true;
            }
            ultimoErro = new Error(`HTTP ${resposta.status}`);
            if (resposta.status !== 503) break;
            if (!aguardandoBackend && path === '/receber-sinal') {
                aguardandoBackend = true;
                console.log('⏳ Fila live aguardando o backend concluir a inicialização.');
            }
        } catch (erro) {
            ultimoErro = erro;
            if (!aguardandoBackend && path === '/receber-sinal') {
                aguardandoBackend = true;
                console.log('⏳ Fila live aguardando o servidor local ficar disponível.');
            }
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

function resumoLiveRecebido(raiz) {
    const payload = extrairPayloadLive(raiz) || {};
    return {
        uuid: String(payload.uuid ?? '').trim() || 'n/a',
        type: payload.type ?? 'n/a',
        result: payload.result ?? 'n/a'
    };
}

async function processarLiveRound(raiz) {
    const recebido = resumoLiveRecebido(raiz);
    const validacao = validarLiveRound(raiz);
    if (!validacao.ok) {
        console.warn(
            `⚠️ Rodada recebida mas ignorada | motivo=${validacao.erro} | `
            + `uuid=${recebido.uuid} | type=${String(recebido.type)} | result=${String(recebido.result)}.`
        );
        return false;
    }

    const round = validacao.round;
    if (!round.winner || !round.winner_symbol || !['P', 'B', 'T'].includes(round.winner_symbol)) {
        console.warn(
            `⚠️ Rodada recebida mas ignorada | motivo=falha_mapeamento_ia | `
            + `uuid=${round.uuid} | type=${round.type} | winner=${String(round.winner)}.`
        );
        return false;
    }

    console.log(
        `🔄 Mapeamento BacBo -> IA | uuid=${round.uuid} | type=${round.type} -> `
        + `interno=${round.winner} | simbolo=${round.winner_symbol} | soma=${round.result}`
    );

    if (rodadaJaProcessada(round.uuid)) {
        console.warn(`⚠️ Rodada recebida mas ignorada | motivo=uuid_duplicado | uuid=${round.uuid}.`);
        return false;
    }

    try {
        await persistirRodadaBacbo(round);
    } catch (erro) {
        console.error(`⚠️ Persistencia bacbo_rounds falhou | uuid=${round.uuid}:`, erro.message);
    }

    const payload = payloadNode(round);
    const entregue = await postNode('/receber-sinal', payload, 'Rodada live', LIVE_DELIVERY_ATTEMPTS);
    if (!entregue) {
        console.warn('⚠️ Rodada live não entregue ao backend; fila preservada sem marcar como processada.');
        return false;
    }

    marcarRodadaProcessada(round.uuid);
    await persistirRetencaoRedis(round);
    console.log(
        `✅ Nova rodada processada pela IA -> Vencedor: ${round.winner_symbol} `
        + `(${round.winner}) | Soma: ${round.result} | UUID: ${round.uuid}`
    );
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

    const mesaCodigo = String(raiz.mesa_codigo || '').trim().toUpperCase();
    if (mesaCodigo !== ESCOPO_REDIS_MESA.codigo) {
        console.warn(
            `MC22-Y-B: evento Redis rejeitado | mesa=${mesaCodigo || '<ausente>'} | `
            + `runtime=${ESCOPO_REDIS_MESA.codigo}.`
        );
        return false;
    }

    const acao = acaoEvento(raiz);
    const payloadPossivelmenteLive = extrairPayloadLive(raiz) || raiz;
    const possuiSchemaLive = payloadPossivelmenteLive
        && payloadPossivelmenteLive.uuid !== undefined
        && payloadPossivelmenteLive.type !== undefined
        && payloadPossivelmenteLive.result !== undefined;

    if (acao === 'live_round' || possuiSchemaLive) return processarLiveRound(raiz);

    const history = extrairHistory(raiz);
    if (history) return processarHistorico(raiz, history);

    console.warn(`⚠️ bacbo_events recebido mas ignorado | motivo=evento_nao_reconhecido | action=${acao || 'n/a'}.`);
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

async function encaminharResultadoMultiConta(dados) {
    if (!dados || dados.action !== 'multi_account_bet_result') return false;
    if (String(dados.table_key || '').trim().toLowerCase() !== tableKeyRuntime()) return false;

    const orderId = String(dados.order_id || dados.signal_id || '').trim().toLowerCase();
    const status = String(dados.executor_status || '').trim().toUpperCase();
    if (!orderId || !STATUS_VALIDOS.has(status)) return false;

    const motivo = status === 'EXECUTADA'
        ? `MULTI_ACCOUNT_${dados.status}: ${Number(dados.success_accounts) || 0}/${Number(dados.expected_accounts) || 0}`
        : `MULTI_ACCOUNT_${dados.status || 'FAILED'}: ${Number(dados.success_accounts) || 0}/${Number(dados.expected_accounts) || 0}`;

    console.log(
        `🔀 MULTI-ACCOUNT RESULT | signal=${orderId} | aggregate=${dados.status} | `
        + `executor=${status} | success=${dados.success_accounts}/${dados.expected_accounts}`
    );

    if (dados.simulation === true) {
        console.log(
            `🧪 MULTI-ACCOUNT SIMULATION | signal=${orderId} | aggregate=${dados.status} | `
            + 'executor_status_delivery=skipped'
        );
        return true;
    }

    return postNode('/executor-status', {
        order_id: orderId,
        status,
        motivo: motivo.slice(0, 300),
        confirmacao: dados.confirmacao || null
    }, `multi_account_result ${orderId}`, 3);
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
            if (multiAccountRouterEnabled()) {
                await responseSubscriber.subscribe(GLOBAL_SIGNAL_RESULT_CHANNEL, mensagem => {
                    const dados = parseMensagem(mensagem);
                    if (!dados || dados.action !== 'multi_account_bet_result') return;
                    void encaminharResultadoMultiConta(dados).catch(erro => {
                        console.error(`⚠️ Multi-account fan-in ignorado por erro controlado: ${erro?.message || erro}`);
                    });
                });
                console.log(`🎧 Multi-account fan-in ativo em ${GLOBAL_SIGNAL_RESULT_CHANNEL}.`);
            } else {
                await responseSubscriber.subscribe(REDIS_RESPONSE_CHANNEL, mensagem => {
                    const dados = parseMensagem(mensagem);
                    if (!dados || dados.action !== 'bet_result') return;
                    void encaminharBetResult(dados).catch(erro => {
                        console.error(`⚠️ bet_result Redis ignorado por erro controlado: ${erro?.message || erro}`);
                    });
                });
            }
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

async function publicarViaRouterMultiConta(dados, orderId) {
    const tableKey = tableKeyRuntime();
    const signal = buildPlaceBetSignal({
        signal_id: orderId,
        source: 'bot2_coletor',
        event_id: orderId,
        table_key: tableKey,
        alvo: dados.alvo,
        valor_base: dados.valor,
        ...(Array.isArray(dados.apostas) && dados.apostas.length > 0 ? { apostas: dados.apostas } : {})
    });

    const receptores = await publisher.publish(GLOBAL_SIGNAL_CHANNEL, JSON.stringify(signal));
    if (!Number.isFinite(Number(receptores)) || Number(receptores) < 1) {
        return respostaJson(503, { erro: 'Signal Router sem assinante ativo', aceita: false });
    }

    console.log(
        `🔀 MULTI-ACCOUNT CUTOVER | order_id=${orderId} | signal=${signal.signal_id} | `
        + `table=${tableKey} | router_subscribers=${receptores}`
    );

    return respostaJson(200, {
        status: 'Ordem aceita pelo Signal Router multi-conta',
        duplicada: false,
        dados: { order_id: orderId, alvo: dados.alvo, valor: dados.valor }
    });
}

async function publicarViaExecutorLegado(dados, orderId) {
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
        if (multiAccountRouterEnabled()) {
            return await publicarViaRouterMultiConta(dados, orderId);
        }
        return await publicarViaExecutorLegado(dados, orderId);
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
        console.error('⚠️ Redis Runtime V3 não conectou no bootstrap:', erro.message);
        agendarReconexao();
    });

    if (multiAccountRouterEnabled()) {
        console.log(
            `🔀 Redis Runtime V3 MULTI-ACCOUNT: ${BACBO_EVENTS_CHANNEL} -> Node; `
            + `${GLOBAL_SIGNAL_CHANNEL} -> Router; ${GLOBAL_SIGNAL_RESULT_CHANNEL} -> fan-in.`
        );
    } else {
        console.log(`🔌 Redis Runtime V3: ${BACBO_EVENTS_CHANNEL} -> schema novo -> Node; ${REDIS_COMMAND_CHANNEL} -> executor.`);
    }
}

module.exports = {
    instalarRedisRuntimeV3,
    processarBacbo,
    payloadNode,
    multiAccountRouterEnabled,
    tableKeyRuntime
};