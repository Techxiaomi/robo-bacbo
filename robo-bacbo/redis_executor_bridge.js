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
const STATUS_VALIDOS = new Set(['EXECUTADA', 'FALHOU', 'EXPIRADA', 'AMBIGUA']);
const TIPMINER_REDIS_CHANNEL = String(process.env.TIPMINER_REDIS_CHANNEL || '').trim();
const TIPMINER_FILA_MAX = 500;
const TIPMINER_DEDUP_MAX = 1000;
const TIPMINER_DEDUP_WINDOW_MS = 3000;
const TIPMINER_SESSAO = `tipminer-redis-${process.pid}-${Date.now()}`;
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
    if (profundidade > 2 || valor === undefined || valor === null) return '';
    if (typeof valor === 'object') {
        const item = objeto(valor);
        if (!item) return '';
        return normalizarVencedor(
            primeiroDefinido(item.winner, item.vencedor, item.result, item.resultado, item.type, item.name, item.value),
            profundidade + 1
        );
    }

    const texto = String(valor).trim().toUpperCase();
    if (!texto) return '';
    if (texto === 'P' || texto === 'PLAYER' || texto === 'PLAYERWON' || texto === 'JOGADOR' || texto === 'AZUL') {
        return 'Player';
    }
    if (texto === 'B' || texto === 'BANKER' || texto === 'BANKERWON' || texto === 'BANCA' || texto === 'VERMELHO') {
        return 'Banker';
    }
    if (texto === 'T' || texto === 'TIE' || texto === 'DRAW' || texto === 'EMPATE') {
        return 'Tie';
    }
    return '';
}

function inteirosDeLista(valor) {
    if (valor === undefined || valor === null) return [];
    let lista = valor;
    if (!Array.isArray(lista)) {
        if (typeof lista === 'string') {
            lista = lista.split(/[^0-9]+/).filter(Boolean);
        } else {
            const obj = objeto(lista);
            if (obj) {
                lista = primeiroDefinido(obj.dice, obj.dados, obj.values, obj.rolls, obj.cards, []);
            }
        }
    }
    if (!Array.isArray(lista)) return [];
    return lista
        .map(item => {
            if (item && typeof item === 'object') {
                return Number(primeiroDefinido(item.value, item.valor, item.number, item.numero, item.face));
            }
            return Number(item);
        })
        .filter(Number.isFinite)
        .map(Math.trunc)
        .filter(item => item >= 0)
        .slice(0, 4);
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

function podarFingerprintsTipMiner(agora = Date.now()) {
    const limiteAntigo = agora - 10 * 60 * 1000;
    for (const [chave, registro] of fingerprintsTipMiner) {
        if (Number(registro && registro.em) < limiteAntigo) fingerprintsTipMiner.delete(chave);
    }
    while (fingerprintsTipMiner.size > TIPMINER_DEDUP_MAX) {
        const primeiro = fingerprintsTipMiner.keys().next().value;
        fingerprintsTipMiner.delete(primeiro);
    }
}

function eventoTipMinerDuplicado(evento, payloadNormalizado, mensagemBruta) {
    const agora = Date.now();
    const idEvento = String(primeiroDefinido(
        evento.round_id,
        evento.roundId,
        evento.game_id,
        evento.gameId,
        evento.event_id,
        evento.eventId,
        evento.id,
        ''
    ) || '').trim();

    const base = idEvento
        ? `id:${idEvento}`
        : `fp:${crypto.createHash('sha256').update(String(mensagemBruta || JSON.stringify(payloadNormalizado))).digest('hex')}`;
    const anterior = fingerprintsTipMiner.get(base);
    const janela = idEvento ? 10 * 60 * 1000 : TIPMINER_DEDUP_WINDOW_MS;
    if (anterior && agora - Number(anterior.em || 0) <= janela) return true;

    fingerprintsTipMiner.set(base, { em: agora });
    podarFingerprintsTipMiner(agora);
    return false;
}

function normalizarPayloadTipMiner(mensagem, canal) {
    let raiz = null;
    try {
        raiz = JSON.parse(String(mensagem || ''));
    } catch (e) {
        return null;
    }
    if (!objeto(raiz)) return null;

    // Canais internos do executor usam action e nunca representam uma rodada TipMiner.
    if (canal === REDIS_COMMAND_CHANNEL || canal === REDIS_RESPONSE_CHANNEL) return null;
    if (typeof raiz.action === 'string' && raiz.action.trim()) return null;

    const aninhado = objeto(raiz.data) || objeto(raiz.payload) || objeto(raiz.event) || {};
    const resultadoObj = objeto(raiz.result) || objeto(aninhado.result) || {};
    const evento = { ...raiz, ...aninhado, ...resultadoObj };

    const vencedor = normalizarVencedor(primeiroDefinido(
        evento.vencedor,
        evento.winner,
        evento.resultado,
        evento.result,
        evento.type,
        resultadoObj.winner,
        resultadoObj.type
    ));
    if (!vencedor) return null;

    const jogadorObj = objeto(primeiroDefinido(evento.player, evento.jogador)) || {};
    const bancaObj = objeto(primeiroDefinido(evento.banker, evento.banca)) || {};
    const dadosJogador = inteirosDeLista(primeiroDefinido(
        evento.dados_jogador,
        evento.player_dice,
        evento.playerDice,
        evento.player_values,
        jogadorObj.dice,
        jogadorObj.dados,
        jogadorObj.values,
        jogadorObj.rolls
    ));
    const dadosBanca = inteirosDeLista(primeiroDefinido(
        evento.dados_banca,
        evento.banker_dice,
        evento.bankerDice,
        evento.banker_values,
        bancaObj.dice,
        bancaObj.dados,
        bancaObj.values,
        bancaObj.rolls
    ));

    const pontosJogadorBruto = primeiroDefinido(
        evento.pontos_jogador,
        evento.player_points,
        evento.playerPoints,
        evento.player_score,
        evento.playerScore,
        jogadorObj.points,
        jogadorObj.score
    );
    const pontosBancaBruto = primeiroDefinido(
        evento.pontos_banca,
        evento.banker_points,
        evento.bankerPoints,
        evento.banker_score,
        evento.bankerScore,
        bancaObj.points,
        bancaObj.score
    );
    const pontosJogador = Number(pontosJogadorBruto);
    const pontosBanca = Number(pontosBancaBruto);

    const seqRecebida = Number(primeiroDefinido(evento.coletor_seq, evento.seq, evento.sequence));
    const seq = Number.isSafeInteger(seqRecebida) && seqRecebida > 0
        ? seqRecebida
        : ++sequenciaTipMiner;
    const sessao = String(primeiroDefinido(
        evento.coletor_sessao,
        evento.session_id,
        evento.sessionId,
        evento.session,
        TIPMINER_SESSAO
    )).trim().slice(0, 128) || TIPMINER_SESSAO;
    const coletadoEm = timestampMs(primeiroDefinido(
        evento.timestamp_coleta,
        evento.timestamp,
        evento.ts,
        evento.created_at,
        evento.createdAt,
        evento.time
    ));

    const normalizado = {
        vencedor,
        resultado: vencedor,
        result: vencedor,
        winner: vencedor,
        type: vencedor,
        dados_jogador: dadosJogador,
        dados_banca: dadosBanca,
        coletor_sessao: sessao,
        coletor_seq: seq,
        timestamp_coleta: coletadoEm,
        fonte: 'TipMiner',
        redis_channel: String(canal || '')
    };
    if (Number.isFinite(pontosJogador) && pontosJogador >= 0) normalizado.pontos_jogador = pontosJogador;
    if (Number.isFinite(pontosBanca) && pontosBanca >= 0) normalizado.pontos_banca = pontosBanca;

    if (eventoTipMinerDuplicado(evento, normalizado, mensagem)) return null;
    return normalizado;
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
        console.error('⚠️ TipMiner Redis ingress: INTERNAL_API_TOKEN ausente; rodada nao pode ser entregue ao motor.');
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
        `⚠️ TipMiner Redis ingress: falha ao entregar rodada ${payload.coletor_seq} ao motor Node:`,
        ultimoErro && ultimoErro.message ? ultimoErro.message : ultimoErro
    );
    return false;
}

function enfileirarTipMiner(payload) {
    if (!payload) return false;
    if (filaTipMiner.length >= TIPMINER_FILA_MAX) {
        console.error('🚨 TipMiner Redis ingress: fila cheia; rodada recusada para evitar crescimento ilimitado.');
        return false;
    }
    filaTipMiner.push(payload);
    if (!processandoFilaTipMiner) {
        void drenarFilaTipMiner();
    }
    return true;
}

async function drenarFilaTipMiner() {
    if (processandoFilaTipMiner) return;
    processandoFilaTipMiner = true;
    try {
        while (filaTipMiner.length > 0) {
            const atual = filaTipMiner[0];
            const entregue = await encaminharTipMinerAoNode(atual);
            if (!entregue) {
                // Falha fechada: nao ultrapassa uma rodada que nao foi entregue ao motor.
                filaTipMiner.shift();
                continue;
            }
            filaTipMiner.shift();
        }
    } finally {
        processandoFilaTipMiner = false;
        if (filaTipMiner.length > 0) void drenarFilaTipMiner();
    }
}

function processarMensagemTipMiner(mensagem, canal) {
    const payload = normalizarPayloadTipMiner(mensagem, canal);
    if (!payload) return false;
    enfileirarTipMiner(payload);
    return true;
}

function agendarReconexaoRedis() {
    if (!instalado || timerReconexaoRedis) return;
    timerReconexaoRedis = setTimeout(() => {
        timerReconexaoRedis = null;
        void garantirRedisPronto().catch(erro => {
            console.error('⚠️ Redis executor/TipMiner bridge indisponivel:', erro && erro.message ? erro.message : erro);
            agendarReconexaoRedis();
        });
    }, 2000);
    if (timerReconexaoRedis && typeof timerReconexaoRedis.unref === 'function') timerReconexaoRedis.unref();
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
                subscriber.__tipMinerSubscribed = false;
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

        if (!subscriber.__tipMinerSubscribed) {
            if (TIPMINER_REDIS_CHANNEL) {
                await subscriber.subscribe(TIPMINER_REDIS_CHANNEL, mensagem => {
                    processarMensagemTipMiner(mensagem, TIPMINER_REDIS_CHANNEL);
                });
                console.log(`🎧 TipMiner Redis ingress: inscrito no canal exato ${TIPMINER_REDIS_CHANNEL}.`);
            } else {
                // O coletor TipMiner e local e pode ter um canal legado diferente. Sem uma
                // configuracao explicita, escutamos Pub/Sub e aceitamos SOMENTE JSON que
                // normalize para uma rodada Bac Bo valida; canais internos action=* sao ignorados.
                await subscriber.pSubscribe('*', (mensagem, canal) => {
                    processarMensagemTipMiner(mensagem, canal);
                });
                console.log('🎧 TipMiner Redis ingress: descoberta de canal ativa; somente rodadas Bac Bo validas sao encaminhadas.');
            }
            subscriber.__tipMinerSubscribed = true;
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

    // A assinatura precisa nascer no bootstrap; esperar a primeira aposta criaria um
    // deadlock operacional porque nenhum resultado TipMiner chegaria ao motor para gerar sinal.
    void garantirRedisPronto().catch(erro => {
        console.error('⚠️ Redis executor/TipMiner bridge nao conectou no bootstrap:', erro && erro.message ? erro.message : erro);
        agendarReconexaoRedis();
    });

    console.log(
        '🔌 Transporte Redis ativo: TipMiner -> motor de sinais -> place_bet; '
        + `timeout de saldo >= ${process.env.BALANCE_SYNC_RESPONSE_TIMEOUT_MS}ms.`
    );
}

module.exports = {
    instalarRedisExecutorBridge,
    configurarTimeoutMinimoSaldo,
    normalizarPayloadTipMiner
};
