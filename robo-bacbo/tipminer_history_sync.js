'use strict';

const crypto = require('crypto');

const BACBO_EVENTS_CHANNEL = 'bacbo_events';
const BACBO_HISTORY_KEY = 'bacbo_history';
const HISTORY_ACK_KEY = String(
    process.env.REDIS_BACBO_HISTORY_ACK_KEY || 'robo_bacbo:history_applied_signature'
).trim() || 'robo_bacbo:history_applied_signature';
const PROCESS_EPOCH = `${process.pid}-${Date.now()}`;
const MAX_BARRIERS = 1000;

let instalado = false;
let subscriber = null;
let reader = null;
let processadorBacbo = null;
let ultimaAssinaturaProcessada = null;
let ultimaAssinaturaConfirmada = null;
let ultimasChaves = new Set();
let ultimaJanela = 0;
let versaoAplicada = 0;
let filaSincronizacao = Promise.resolve();
let consumidoresCriticosProntos = false;

const listenersAplicacao = new Set();
const barreirasConfirmadas = new Map();

function objeto(valor) {
    return valor && typeof valor === 'object' && !Array.isArray(valor) ? valor : null;
}

function parseJson(valor) {
    if (typeof valor !== 'string') return valor;
    const texto = valor.trim();
    if (!texto) return null;
    try { return JSON.parse(texto); } catch (_) { return null; }
}

function extrairHistory(valor) {
    const parsed = parseJson(valor);
    if (Array.isArray(parsed)) return parsed;

    const root = objeto(parsed);
    if (!root) return null;
    if (Array.isArray(root.history)) return root.history;
    if (Array.isArray(root.data)) return root.data;
    if (Array.isArray(root.results)) return root.results;
    if (Array.isArray(root.rounds)) return root.rounds;

    for (const chave of ['data', 'payload', 'event']) {
        const bloco = objeto(root[chave]);
        if (!bloco) continue;
        if (Array.isArray(bloco.history)) return bloco.history;
        if (Array.isArray(bloco.results)) return bloco.results;
        if (Array.isArray(bloco.rounds)) return bloco.rounds;
    }
    return null;
}

function timestampHistoryItem(item) {
    const valor = objeto(item) || {};
    const bruto = valor.instant || valor.data_hora || valor.timestamp || '';
    const ms = Date.parse(String(bruto || ''));
    return Number.isFinite(ms) ? ms : null;
}

function historyCronologico(history) {
    const itens = (Array.isArray(history) ? history : []).map((item, indice) => ({ item, indice }));
    const todosTemTimestamp = itens.every(({ item }) => timestampHistoryItem(item) !== null);
    if (!todosTemTimestamp) return itens.map(({ item }) => item);

    itens.sort((a, b) => {
        const delta = timestampHistoryItem(a.item) - timestampHistoryItem(b.item);
        return delta || a.indice - b.indice;
    });
    return itens.map(({ item }) => item);
}

function chaveHistoryItem(item, indice = 0) {
    const valor = objeto(item) || {};
    const uuid = String(valor.uuid || valor.id || '').trim();
    if (uuid) return `uuid:${uuid.toLowerCase()}`;
    return [
        'fallback',
        indice,
        valor.instant || valor.data_hora || valor.timestamp || '',
        valor.type || valor.winner || valor.resultado || '',
        valor.result ?? valor.resultado_soma ?? ''
    ].join('|');
}

function assinaturaHistory(history) {
    const itens = historyCronologico(history);
    const hash = crypto.createHash('sha256');

    itens.forEach(item => {
        const valor = objeto(item) || {};
        const uuid = String(valor.uuid || valor.id || '').trim().toLowerCase();
        const tipo = String(valor.type || valor.winner || valor.resultado || '').trim().toUpperCase();
        const result = String(valor.result ?? valor.resultado_soma ?? '');
        const instant = String(valor.instant || valor.data_hora || valor.timestamp || '').trim();
        hash.update(`${uuid}|${tipo}|${result}|${instant}\n`);
    });

    return `${itens.length}|${hash.digest('hex')}`;
}

function chavesHistory(history) {
    return new Set((Array.isArray(history) ? history : []).map(chaveHistoryItem));
}

function contarNovos(history) {
    if (ultimaAssinaturaProcessada === null) return null;
    let total = 0;
    (Array.isArray(history) ? history : []).forEach((item, indice) => {
        if (!ultimasChaves.has(chaveHistoryItem(item, indice))) total++;
    });
    return total;
}

function normalizarBarrierId(valor) {
    const id = String(valor || '').trim();
    if (!id || id.length > 160 || !/^[A-Za-z0-9:_-]+$/.test(id)) return '';
    return id;
}

function lembrarBarreiraConfirmada(barrierId, assinatura) {
    const id = normalizarBarrierId(barrierId);
    if (!id) return;
    barreirasConfirmadas.set(id, { assinatura, em: Date.now() });
    while (barreirasConfirmadas.size > MAX_BARRIERS) {
        barreirasConfirmadas.delete(barreirasConfirmadas.keys().next().value);
    }
}

async function lerHistoryRetido() {
    if (!reader) return null;

    try {
        const bruto = await reader.get(BACBO_HISTORY_KEY);
        const history = extrairHistory(bruto);
        if (Array.isArray(history) && history.length > 0) return historyCronologico(history);
        if (bruto !== null) {
            console.warn(`⚠️ Bac Bo HISTORY_SYNC: ${BACBO_HISTORY_KEY} existe, mas o JSON não contém histórico reconhecível.`);
        }
        return null;
    } catch (erro) {
        if (!String(erro?.message || '').toUpperCase().includes('WRONGTYPE')) throw erro;
    }

    const itens = await reader.lRange(BACBO_HISTORY_KEY, 0, -1);
    if (!Array.isArray(itens) || itens.length === 0) return null;

    const history = [];
    for (const item of itens) {
        const parsed = parseJson(item);
        if (Array.isArray(parsed)) history.push(...parsed);
        else if (objeto(parsed)) history.push(parsed);
    }
    return history.length ? historyCronologico(history) : null;
}

function estadoHistorico() {
    return Object.freeze({
        assinatura_processada: ultimaAssinaturaProcessada,
        assinatura_confirmada: ultimaAssinaturaConfirmada,
        versao: versaoAplicada,
        janela: ultimaJanela,
        process_epoch: PROCESS_EPOCH,
        consumidores_criticos_prontos: consumidoresCriticosProntos
    });
}

function marcarConsumidoresCriticosProntos() {
    consumidoresCriticosProntos = true;
    return true;
}

async function publicarAckHistorico(assinatura, janela, origem, barrierId = '') {
    if (!reader || !assinatura) return false;
    const payload = {
        signature: assinatura,
        barrier_id: normalizarBarrierId(barrierId) || null,
        applied_at: Date.now(),
        process_epoch: PROCESS_EPOCH,
        window: Math.max(0, Number(janela) || 0),
        source: String(origem || 'history_sync')
    };
    await reader.set(HISTORY_ACK_KEY, JSON.stringify(payload));
    return payload;
}

async function notificarConsumidores(meta) {
    if (!consumidoresCriticosProntos) {
        throw new Error('consumidores críticos ainda inicializando');
    }
    if (listenersAplicacao.size === 0) {
        throw new Error('nenhum consumidor crítico registrado para a barreira histórica');
    }

    for (const listener of [...listenersAplicacao]) {
        const resultado = await listener(meta);
        if (resultado === false || resultado?.ok === false || resultado?.adiado === true) {
            throw new Error('consumidor crítico não confirmou a consolidação histórica');
        }
    }
    return true;
}

function onHistoricoAplicado(listener) {
    if (typeof listener !== 'function') return () => {};
    listenersAplicacao.add(listener);
    return () => listenersAplicacao.delete(listener);
}

async function confirmarAplicacao(assinatura, history, origem, novosEstimados, barrierId = '') {
    const barreira = normalizarBarrierId(barrierId);
    const meta = Object.freeze({
        assinatura,
        barrier_id: barreira || null,
        janela: history.length,
        origem,
        novos_estimados: Math.max(0, Number(novosEstimados) || 0),
        versao: versaoAplicada,
        process_epoch: PROCESS_EPOCH
    });

    if (barreira) await notificarConsumidores(meta);

    ultimaAssinaturaConfirmada = assinatura;
    if (barreira) lembrarBarreiraConfirmada(barreira, assinatura);
    await publicarAckHistorico(assinatura, history.length, origem, barreira);
    return true;
}

async function entregarHistory(processarBacbo, origem, opcoes = {}) {
    const history = await lerHistoryRetido();
    if (!Array.isArray(history) || history.length === 0) {
        console.warn(`⚠️ Bac Bo HISTORY_SYNC recebido, mas ${BACBO_HISTORY_KEY} está vazio ou inválido.`);
        return false;
    }

    const barrierId = normalizarBarrierId(opcoes.barrier_id);
    const assinatura = assinaturaHistory(history);
    const primeiraSincronizacao = ultimaAssinaturaProcessada === null;
    const novosEstimados = contarNovos(history);
    const barreiraAnterior = barrierId ? barreirasConfirmadas.get(barrierId) : null;

    if (barreiraAnterior?.assinatura === assinatura) {
        await publicarAckHistorico(assinatura, history.length, origem, barrierId);
        return true;
    }

    const assinaturaMudou = assinatura !== ultimaAssinaturaProcessada;
    if (assinaturaMudou) {
        if (primeiraSincronizacao) {
            console.log(
                `♻️ Bac Bo HISTORY_SYNC -> Node | ${history.length} giro(s) lidos de Redis `
                + `key=${BACBO_HISTORY_KEY} | origem=${origem}.`
            );
        }

        const aceito = await processarBacbo(JSON.stringify({
            action: 'history_snapshot',
            source: 'bacbo_history_key',
            history_meta: {
                origem,
                janela: history.length,
                novos_estimados: novosEstimados,
                assinatura,
                barrier_id: barrierId || null
            },
            history
        }));

        if (!aceito) {
            console.warn(`⚠️ Bac Bo HISTORY lido (${history.length}), mas o Runtime V3 não concluiu o processamento.`);
            return false;
        }

        ultimaAssinaturaProcessada = assinatura;
        ultimasChaves = chavesHistory(history);
        ultimaJanela = history.length;
        versaoAplicada++;
    }

    try {
        await confirmarAplicacao(assinatura, history, origem, novosEstimados, barrierId);
    } catch (erro) {
        if (barrierId) {
            console.log(`⏳ Bac Bo HISTORY final aguardando consumidor crítico | ${erro.message}.`);
        } else {
            console.error(`⚠️ Bac Bo HISTORY aplicado ao banco, mas confirmação final falhou: ${erro.message}`);
        }
        return false;
    }

    if (primeiraSincronizacao) {
        console.log(`✅ Bac Bo HISTORY sincronizado com Runtime V3 | ${history.length} giro(s).`);
    } else if (assinaturaMudou && Math.max(0, Number(novosEstimados) || 0) > 0) {
        console.log(
            `♻️ Bac Bo HISTORY atualizado | janela=${history.length} | `
            + `novas=${Math.max(0, Number(novosEstimados) || 0)} | origem=${origem}.`
        );
    } else if (barrierId) {
        console.log(`🔒 Bac Bo HISTORY final confirmado | janela=${history.length}.`);
    }
    return true;
}

function enfileirarHistory(processarBacbo, origem, opcoes = {}) {
    const executar = () => entregarHistory(processarBacbo, origem, opcoes);
    filaSincronizacao = filaSincronizacao.then(executar, executar);
    return filaSincronizacao;
}

async function drenarHistoricoPendente(origem = 'barreira') {
    if (!processadorBacbo) return estadoHistorico();
    await enfileirarHistory(processadorBacbo, origem);
    await filaSincronizacao;
    return estadoHistorico();
}

async function instalarTipMinerHistorySync(processarBacbo) {
    if (instalado) return true;
    if (typeof processarBacbo !== 'function') {
        throw new TypeError('processarBacbo ausente no adaptador Bac Bo HISTORY_SYNC');
    }

    processadorBacbo = processarBacbo;

    const { createClient } = require('redis');
    const redisUrl = String(process.env.REDIS_URL || 'redis://127.0.0.1:6379').trim() || 'redis://127.0.0.1:6379';
    const timeout = Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 3000);
    const connectTimeout = Number.isFinite(timeout) ? Math.max(500, Math.min(15000, timeout)) : 3000;
    const opcoesRedis = { url: redisUrl, socket: { connectTimeout, reconnectStrategy: () => false } };

    reader = createClient(opcoesRedis);
    subscriber = reader.duplicate();
    reader.on('error', erro => console.error('⚠️ Redis Bac Bo history reader:', erro.message));
    subscriber.on('error', erro => console.error('⚠️ Redis Bac Bo history subscriber:', erro.message));

    await reader.connect();
    await subscriber.connect();

    await subscriber.subscribe(BACBO_EVENTS_CHANNEL, mensagem => {
        let evento = null;
        try { evento = JSON.parse(String(mensagem || '')); } catch (_) { return; }
        const root = objeto(evento) || {};
        const action = String(root.action || '').trim().toLowerCase();
        if (action !== 'history_sync') return;
        const barrierId = normalizarBarrierId(root.barrier_id);
        void enfileirarHistory(processadorBacbo, 'history_sync', { barrier_id: barrierId }).catch(erro => {
            console.error('⚠️ Bac Bo HISTORY_SYNC falhou:', erro.message);
        });
    });

    instalado = true;
    console.log(`🎧 Adaptador Bac Bo HISTORY_SYNC ativo: ${BACBO_HISTORY_KEY} -> Runtime V3.`);

    try {
        await enfileirarHistory(processadorBacbo, 'startup');
    } catch (erro) {
        console.error('⚠️ Bac Bo HISTORY startup falhou:', erro.message);
    }
    return true;
}

module.exports = {
    HISTORY_ACK_KEY,
    instalarTipMinerHistorySync,
    drenarHistoricoPendente,
    estadoHistorico,
    onHistoricoAplicado,
    marcarConsumidoresCriticosProntos,
    assinaturaHistory
};
