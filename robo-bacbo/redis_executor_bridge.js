const crypto = require('crypto');

let instalado = false;
let publisher = null;
let subscriber = null;
let inicializacaoRedis = null;
let fetchOriginal = null;
let timerReconexaoRedis = null;
let processandoFilaTipMiner = false;

const REDIS_COMMAND_CHANNEL = 'auto_trader_commands';
const REDIS_RESPONSE_CHANNEL = 'auto_trader_responses';
const TIPMINER_REDIS_CHANNEL = 'bacbo_events';
const STATUS_VALIDOS = new Set(['EXECUTADA', 'FALHOU', 'EXPIRADA', 'AMBIGUA']);
const TIPMINER_FILA_MAX = 500;
const TIPMINER_DEDUP_MAX = 1000;
const TIPMINER_SESSAO = `tipminer-bacbo-events-${process.pid}-${Date.now()}`;
const filaTipMiner = [];
const fingerprintsTipMiner = new Map();
let sequenciaTipMiner = 0;

function configurarTimeoutMinimoSaldo() {
    const atual = Number(process.env.BALANCE_SYNC_RESPONSE_TIMEOUT_MS);
    if (!Number.isFinite(atual) || atual < 20000) {
        process.env.BALANCE_SYNC_RESPONSE_TIMEOUT_MS = '20000';
    }
}

function urlExecutorConfigurada() {
    return String(process.env.EXECUTOR_URL || 'http://127.0.0.1:5000/apostar').trim();
}

function hostNodeLocal() {
    const hostBruto = String(process.env.NODE_HOST || '127.0.0.1').trim() || '127.0.0.1';
    return hostBruto.includes(':') && !hostBruto.startsWith('[')
        ? `[${hostBruto}]`
        : hostBruto;
}

function urlExecutorStatusNode() {
    return `http://${hostNodeLocal()}:${Number(process.env.NODE_PORT || 3000)}/executor-status`;
}

function urlReceberSinalNode() {
    return `http://${hostNodeLocal()}:${Number(process.env.NODE_PORT || 3000)}/receber-sinal`;
}

function normalizarUrl(valor) {
    try {
        return new URL(String(valor)).href;
    } catch (e) {
        return String(valor || '');
    }
}

function corpoJsonDaRequisicao(init) {
    const body = init && init.body;
    if (typeof body !== 'string') return null;
    try {
        const dados = JSON.parse(body);
        return dados && typeof dados === 'object' && !Array.isArray(dados) ? dados : null;
    } catch (e) {
        return null;
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

function normalizarVencedor(valor, profundidade = 0) {
    if (profundidade > 3 || valor === undefined || valor === null) return '';

    if (typeof valor === 'object') {
        const item = objeto(valor);
        if (!item) return '';
        return normalizarVencedor(
            primeiroDefinido(
                item.winner,
                item.vencedor,
                item.result,
                item.resultado,
                item.value,
                item.name,
                item.type
            ),
            profundidade + 1
        );
    }

    const texto = String(valor).trim().toUpperCase();
    if (!texto) return '';

    if (
        texto === 'P'
        || texto === 'PLAYER'
        || texto === 'PLAYERWON'
        || texto === 'PLAYER_WON'
        || texto === 'JOGADOR'
        || texto === 'AZUL'
    ) {
        return 'Player';
    }

    if (
        texto === 'B'
        || texto === 'BANKER'
        || texto === 'BANKERWON'
        || texto === 'BANKER_WON'
        || texto === 'BANCA'
        || texto === 'VERMELHO'
    ) {
        return 'Banker';
    }

    if (
        texto === 'T'
        || texto === 'TIE'
        || texto === 'DRAW'
        || texto === 'EMPATE'
    ) {
        return 'Tie';
    }

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

function podarFingerprintsTipMiner() {
    while (fingerprintsTipMiner.size > TIPMINER_DEDUP_MAX) {
        const primeiro = fingerprintsTipMiner.keys().next().value;
        fingerprintsTipMiner.delete(primeiro);
    }
}

function eventoTipMinerDuplicado(uuid) {
    const chave = String(uuid || '').trim();
    if (!chave) return false;
    if (fingerprintsTipMiner.has(chave)) return true;
    fingerprintsTipMiner.set(chave, Date.now());
    podarFingerprintsTipMiner();
    return false;
}

function normalizarPayloadTipMiner(mensagem, canal = TIPMINER_REDIS_CHANNEL) {
    if (canal !== TIPMINER_REDIS_CHANNEL) return null;

    let raiz = null;
    try {
        raiz = JSON.parse(String(mensagem || ''));
    } catch (e) {
        return null;
    }

    if (!objeto(raiz)) return null;
    if (String(raiz.action || '').trim().toLowerCase() !== 'live_round') return null;

    const aninhado = objeto(raiz.data) || objeto(raiz.payload) || objeto(raiz.event) || {};
    const evento = { ...raiz, ...aninhado };
    const uuid = String(primeiroDefinido(evento.uuid, evento.id, evento.round_id, evento.roundId) || '').trim();

    const vencedor = normalizarVencedor(primeiroDefinido(
        evento.result,
        evento.resultado,
        evento.winner,
        evento.vencedor,
        evento.type
    ));
    if (!vencedor) return null;
    if (eventoTipMinerDuplicado(uuid)) return null;

    const seqRecebida = Number(primeiroDefinido(evento.coletor_seq, evento.seq, evento.sequence));
    const seq = Number.isSafeInteger(seqRecebida) && seqRecebida > 0
        ? seqRecebida
        : ++sequenciaTipMiner;

    const sessao = String(primeiroDefinido(
        evento.coletor_sessao,
        evento.session_id,
        evento.sessionId,
        TIPMINER_SESSAO
    )).trim().slice(0, 128) || TIPMINER_SESSAO;

    const coletadoEm = timestampMs(primeiroDefinido(
        evento.instant,
        evento.timestamp_coleta,
        evento.timestamp,
        evento.ts,
        evento.created_at,
        evento.createdAt
    ));

    return {
        vencedor,
        resultado: vencedor,
        result: vencedor,
        winner: vencedor,
        type: vencedor,
        dados_jogador: [],
        dados_banca: [],
        coletor_sessao: sessao,
        coletor_seq: seq,
        timestamp_coleta: coletadoEm,
        fonte: 'TipMiner',
        redis_channel: TIPMINER_REDIS_CHANNEL,
        tipminer_uuid: uuid || null,
        tipminer_type: evento.type === undefined ? null : evento.type,
        tipminer_instant: evento.instant === undefined ? null : evento.instant
    };
}

async function encaminharBetResultAoNode(dados) {
    const orderId = String(dados && dados.order_id || '').trim().toLowerCase();
    const status = String(dados && dados.status || '').trim().toUpperCase();
    if (!orderId || !STATUS_VALIDOS.has(status)) return false;

    const token = String(process.env.INTERNAL_API_TOKEN || '').trim();
    if (!token) {
        console.error('⚠️ Redis executor bridge: INTERNAL_API_TOKEN ausente para callback local.');
        return false;
    }

    const payload = {
        order_id: orderId,
        status,
        motivo: String(dados.motivo || '').slice(0, 300),
        confirmacao: dados.confirmacao || null
    };

    let ultimoErro = null;
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
        try {
            const resposta = await fetchOriginal(urlExecutorStatusNode(), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Internal-Token': token
                },
                body: JSON.stringify(payload)
            });
            if (resposta.ok) return true;
            ultimoErro = new Error(`HTTP ${resposta.status}`);
        } catch (e) {
            ultimoErro = e;
        }
        await new Promise(resolve => setTimeout(resolve, 150));
    }

    console.error(
        `⚠️ Redis executor bridge: falha ao entregar bet_result ${orderId} ao Node:`,
        ultimoErro && ultimoErro.message ? ultimoErro.message : ultimoErro
    );
    return false;
}

async function encaminharTipMinerAoNode(payload) {
    const token = String(process.env.INTERNAL_API_TOKEN || '').trim();
    if (!token) {
        console.error('⚠️ bacbo_events: INTERNAL_API_TOKEN ausente; live_round nao pode entrar no motor.');
        return false;
    }

    let ultimoErro = null;
    for (let tentativa = 1; tentativa <= 60; tentativa++) {
        try {
            const resposta = await fetchOriginal(urlReceberSinalNode(), {
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
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.error(
        `⚠️ bacbo_events: falha ao entregar live_round ${payload.tipminer_uuid || payload.coletor_seq} ao motor:`,
        ultimoErro && ultimoErro.message ? ultimoErro.message : ultimoErro
    );
    return false;
}

function enfileirarTipMiner(payload) {
    if (!payload) return false;
    if (filaTipMiner.length >= TIPMINER_FILA_MAX) {
        console.error('🚨 bacbo_events: fila cheia; live_round recusado para evitar crescimento ilimitado.');
        return false;
    }

    filaTipMiner.push(payload);
    if (!processandoFilaTipMiner) void drenarFilaTipMiner();
    return true;
}

async function drenarFilaTipMiner() {
    if (processandoFilaTipMiner) return;
    processandoFilaTipMiner = true;

    try {
        while (filaTipMiner.length > 0) {
            const atual = filaTipMiner[0];
            await encaminharTipMinerAoNode(atual);
            filaTipMiner.shift();
        }
    } finally {
        processandoFilaTipMiner = false;
        if (filaTipMiner.length > 0) void drenarFilaTipMiner();
    }
}

function processarMensagemTipMiner(mensagem) {
    const payload = normalizarPayloadTipMiner(mensagem, TIPMINER_REDIS_CHANNEL);
    if (!payload) return false;
    return enfileirarTipMiner(payload);
}

function agendarReconexaoRedis() {
    if (!instalado || timerReconexaoRedis) return;

    timerReconexaoRedis = setTimeout(() => {
        timerReconexaoRedis = null;
        void garantirRedisPronto().catch(erro => {
            console.error(
                '⚠️ Redis bridge indisponivel; nova tentativa agendada:',
                erro && erro.message ? erro.message : erro
            );
            agendarReconexaoRedis();
        });
    }, 2000);

    if (typeof timerReconexaoRedis.unref === 'function') timerReconexaoRedis.unref();
}

async function garantirRedisPronto() {
    if (publisher?.isReady === true && subscriber?.isReady === true) return true;
    if (inicializacaoRedis) return inicializacaoRedis;

    inicializacaoRedis = (async () => {
        const { createClient } = require('redis');
        const redisUrl = String(process.env.REDIS_URL || 'redis://127.0.0.1:6379').trim()
            || 'redis://127.0.0.1:6379';
        const timeoutConfig = Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 3000);
        const connectTimeout = Number.isFinite(timeoutConfig)
            ? Math.max(500, Math.min(15000, timeoutConfig))
            : 3000;

        if (!publisher) {
            publisher = createClient({
                url: redisUrl,
                socket: {
                    connectTimeout,
                    reconnectStrategy: () => false
                }
            });
            publisher.on('error', erro => {
                console.error('⚠️ Redis executor bridge publisher:', erro.message);
            });
            publisher.on('end', () => agendarReconexaoRedis());
        }

        if (!subscriber) {
            subscriber = publisher.duplicate();
            subscriber.on('error', erro => {
                console.error('⚠️ Redis executor bridge subscriber:', erro.message);
            });
            subscriber.on('end', () => {
                subscriber.__bacboBetResultSubscribed = false;
                subscriber.__bacboEventsSubscribed = false;
                agendarReconexaoRedis();
            });
        }

        if (!publisher.isOpen) await publisher.connect();
        if (!subscriber.isOpen) await subscriber.connect();

        if (!subscriber.__bacboBetResultSubscribed) {
            await subscriber.subscribe(REDIS_RESPONSE_CHANNEL, mensagem => {
                let dados = null;
                try {
                    dados = JSON.parse(String(mensagem || ''));
                } catch (e) {
                    return;
                }
                if (!dados || dados.action !== 'bet_result') return;
                void encaminharBetResultAoNode(dados);
            });
            subscriber.__bacboBetResultSubscribed = true;
        }

        if (!subscriber.__bacboEventsSubscribed) {
            await subscriber.subscribe(TIPMINER_REDIS_CHANNEL, mensagem => {
                processarMensagemTipMiner(mensagem);
            });
            subscriber.__bacboEventsSubscribed = true;
            console.log(`🎧 TipMiner Redis: inscrito persistentemente em ${TIPMINER_REDIS_CHANNEL}.`);
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
    return new Response(JSON.stringify(corpo), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

async function fetchComExecutorRedis(input, init = {}) {
    const alvo = typeof input === 'string' || input instanceof URL
        ? String(input)
        : String(input && input.url || '');
    const metodo = String(init.method || (input && input.method) || 'GET').toUpperCase();

    if (
        metodo !== 'POST'
        || normalizarUrl(alvo) !== normalizarUrl(urlExecutorConfigurada())
    ) {
        return fetchOriginal(input, init);
    }

    const dados = corpoJsonDaRequisicao(init);
    const orderId = String(dados && dados.order_id || '').trim().toLowerCase();
    if (!dados || !orderId) {
        return respostaJson(400, {
            erro: 'order_id ausente no transporte Redis',
            aceita: false
        });
    }

    try {
        await garantirRedisPronto();
        const comando = {
            action: 'place_bet',
            order_id: orderId,
            alvo: dados.alvo,
            valor: dados.valor
        };
        if (Array.isArray(dados.apostas) && dados.apostas.length > 0) {
            comando.apostas = dados.apostas;
        }

        const receptores = await publisher.publish(
            REDIS_COMMAND_CHANNEL,
            JSON.stringify(comando)
        );
        if (!Number.isFinite(Number(receptores)) || Number(receptores) < 1) {
            return respostaJson(503, {
                erro: 'executor Redis sem assinante ativo',
                aceita: false
            });
        }

        return respostaJson(200, {
            status: 'Ordem Redis aceita pelo transporte local',
            duplicada: false,
            dados: {
                order_id: orderId,
                alvo: dados.alvo,
                valor: dados.valor
            }
        });
    } catch (e) {
        console.error(
            `⚠️ Redis executor bridge: falha ao publicar place_bet ${orderId}:`,
            e && e.message ? e.message : e
        );
        return respostaJson(503, {
            erro: 'transporte Redis do executor indisponivel',
            aceita: false
        });
    }
}

function instalarRedisExecutorBridge() {
    configurarTimeoutMinimoSaldo();
    if (instalado) return;
    if (typeof globalThis.fetch !== 'function' || typeof globalThis.Response !== 'function') {
        throw new Error('Runtime Node sem fetch/Response nativos; Redis executor bridge nao pode ser instalado');
    }

    fetchOriginal = globalThis.fetch.bind(globalThis);
    globalThis.fetch = fetchComExecutorRedis;
    instalado = true;

    void garantirRedisPronto().catch(erro => {
        console.error(
            '⚠️ Redis bridge nao conectou no bootstrap:',
            erro && erro.message ? erro.message : erro
        );
        agendarReconexaoRedis();
    });

    console.log(
        `🔌 Redis ativo: ${TIPMINER_REDIS_CHANNEL} -> motor de sinais -> place_bet; `
        + `timeout de saldo >= ${process.env.BALANCE_SYNC_RESPONSE_TIMEOUT_MS}ms.`
    );
}

module.exports = {
    instalarRedisExecutorBridge,
    configurarTimeoutMinimoSaldo,
    normalizarPayloadTipMiner
};
