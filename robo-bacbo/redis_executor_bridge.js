const crypto = require('crypto');

let instalado = false;
let publisher = null;
let subscriber = null;
let inicializacaoRedis = null;
let fetchOriginal = null;

const REDIS_COMMAND_CHANNEL = 'auto_trader_commands';
const REDIS_RESPONSE_CHANNEL = 'auto_trader_responses';
const STATUS_VALIDOS = new Set(['EXECUTADA', 'FALHOU', 'EXPIRADA', 'AMBIGUA']);

function configurarTimeoutMinimoSaldo() {
    const atual = Number(process.env.BALANCE_SYNC_RESPONSE_TIMEOUT_MS);
    if (!Number.isFinite(atual) || atual < 20000) {
        process.env.BALANCE_SYNC_RESPONSE_TIMEOUT_MS = '20000';
    }
}

function urlExecutorConfigurada() {
    return String(process.env.EXECUTOR_URL || 'http://127.0.0.1:5000/apostar').trim();
}

function urlExecutorStatusNode() {
    const hostBruto = String(process.env.NODE_HOST || '127.0.0.1').trim() || '127.0.0.1';
    const host = hostBruto.includes(':') && !hostBruto.startsWith('[')
        ? `[${hostBruto}]`
        : hostBruto;
    const porta = Number(process.env.NODE_PORT || 3000);
    return `http://${host}:${porta}/executor-status`;
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
        }

        if (!subscriber) {
            subscriber = publisher.duplicate();
            subscriber.on('error', erro => {
                console.error('⚠️ Redis executor bridge subscriber:', erro.message);
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
    console.log(
        '🔌 Transporte do executor restaurado: sinais do Auto-Trader -> Redis place_bet; '
        + `timeout de saldo >= ${process.env.BALANCE_SYNC_RESPONSE_TIMEOUT_MS}ms.`
    );
}

module.exports = {
    instalarRedisExecutorBridge,
    configurarTimeoutMinimoSaldo
};
