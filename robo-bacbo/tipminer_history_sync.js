'use strict';

const crypto = require('crypto');

const BACBO_EVENTS_CHANNEL = 'bacbo_events';
const TIPMINER_HISTORY_KEY = 'bacbo_history';

let instalado = false;
let subscriber = null;
let reader = null;
let ultimaAssinatura = null;
let ultimasChaves = new Set();
let filaSincronizacao = Promise.resolve();

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
    const itens = Array.isArray(history) ? history : [];
    const hash = crypto.createHash('sha256');
    itens.forEach((item, indice) => {
        const valor = objeto(item) || {};
        hash.update(chaveHistoryItem(valor, indice));
        hash.update('|');
        hash.update(String(valor.type || valor.winner || valor.resultado || ''));
        hash.update('|');
        hash.update(String(valor.result ?? valor.resultado_soma ?? ''));
        hash.update('|');
        hash.update(String(valor.instant || valor.data_hora || valor.timestamp || ''));
        hash.update('\n');
    });
    return `${itens.length}|${hash.digest('hex')}`;
}

function chavesHistory(history) {
    return new Set((Array.isArray(history) ? history : []).map(chaveHistoryItem));
}

function contarNovos(history) {
    if (ultimaAssinatura === null) return null;
    let total = 0;
    (Array.isArray(history) ? history : []).forEach((item, indice) => {
        if (!ultimasChaves.has(chaveHistoryItem(item, indice))) total++;
    });
    return total;
}

async function lerHistoryRetido() {
    if (!reader) return null;

    try {
        const bruto = await reader.get(TIPMINER_HISTORY_KEY);
        const history = extrairHistory(bruto);
        if (Array.isArray(history) && history.length > 0) return history;
        if (bruto !== null) {
            console.warn(`⚠️ TipMiner HISTORY_SYNC: ${TIPMINER_HISTORY_KEY} existe, mas o JSON não contém histórico reconhecível.`);
        }
        return null;
    } catch (erro) {
        if (!String(erro?.message || '').toUpperCase().includes('WRONGTYPE')) throw erro;
    }

    const itens = await reader.lRange(TIPMINER_HISTORY_KEY, 0, -1);
    if (!Array.isArray(itens) || itens.length === 0) return null;

    const history = [];
    for (const item of itens) {
        const parsed = parseJson(item);
        if (Array.isArray(parsed)) history.push(...parsed);
        else if (objeto(parsed)) history.push(parsed);
    }
    return history.length ? history : null;
}

async function entregarHistory(processarBacbo, origem) {
    const history = await lerHistoryRetido();
    if (!Array.isArray(history) || history.length === 0) {
        console.warn(`⚠️ TipMiner HISTORY_SYNC recebido, mas ${TIPMINER_HISTORY_KEY} está vazio ou inválido.`);
        return false;
    }

    const assinatura = assinaturaHistory(history);
    if (assinatura === ultimaAssinatura) return true;

    const primeiraSincronizacao = ultimaAssinatura === null;
    const novosEstimados = contarNovos(history);

    if (primeiraSincronizacao) {
        console.log(
            `♻️ TipMiner HISTORY_SYNC -> Node | ${history.length} giro(s) lidos de Redis `
            + `key=${TIPMINER_HISTORY_KEY} | origem=${origem}.`
        );
    }

    const aceito = await processarBacbo(JSON.stringify({
        action: 'history_snapshot',
        source: 'tipminer_history_key',
        history_meta: {
            origem,
            janela: history.length,
            novos_estimados: novosEstimados
        },
        history
    }));

    if (!aceito) {
        console.warn(`⚠️ TipMiner HISTORY lido (${history.length}), mas o Runtime V3 não concluiu o processamento.`);
        return false;
    }

    ultimaAssinatura = assinatura;
    ultimasChaves = chavesHistory(history);

    if (primeiraSincronizacao) {
        console.log(`✅ TipMiner HISTORY sincronizado com Runtime V3 | ${history.length} giro(s).`);
    } else {
        console.log(
            `♻️ TipMiner HISTORY atualizado | janela=${history.length} | `
            + `novas=${Math.max(0, Number(novosEstimados) || 0)} | origem=${origem}.`
        );
    }
    return true;
}

function enfileirarHistory(processarBacbo, origem) {
    const executar = () => entregarHistory(processarBacbo, origem);
    filaSincronizacao = filaSincronizacao.then(executar, executar);
    return filaSincronizacao;
}

async function instalarTipMinerHistorySync(processarBacbo) {
    if (instalado) return true;
    if (typeof processarBacbo !== 'function') {
        throw new TypeError('processarBacbo ausente no adaptador TipMiner HISTORY_SYNC');
    }

    const { createClient } = require('redis');
    const redisUrl = String(process.env.REDIS_URL || 'redis://127.0.0.1:6379').trim() || 'redis://127.0.0.1:6379';
    const timeout = Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 3000);
    const connectTimeout = Number.isFinite(timeout) ? Math.max(500, Math.min(15000, timeout)) : 3000;
    const opcoes = { url: redisUrl, socket: { connectTimeout, reconnectStrategy: () => false } };

    reader = createClient(opcoes);
    subscriber = reader.duplicate();
    reader.on('error', erro => console.error('⚠️ Redis TipMiner history reader:', erro.message));
    subscriber.on('error', erro => console.error('⚠️ Redis TipMiner history subscriber:', erro.message));

    await reader.connect();
    await subscriber.connect();

    await subscriber.subscribe(BACBO_EVENTS_CHANNEL, mensagem => {
        let evento = null;
        try { evento = JSON.parse(String(mensagem || '')); } catch (_) { return; }
        const action = String(objeto(evento)?.action || '').trim().toLowerCase();
        if (action !== 'history_sync') return;
        void enfileirarHistory(processarBacbo, 'history_sync').catch(erro => {
            console.error('⚠️ TipMiner HISTORY_SYNC falhou:', erro.message);
        });
    });

    instalado = true;
    console.log(`🎧 Adaptador TipMiner HISTORY_SYNC ativo: ${TIPMINER_HISTORY_KEY} -> Runtime V3.`);

    // O snapshot retido é concluído antes de liberar o bootstrap do backend.
    // Assim banco canônico, recovery analítico e motor de sinais começam da mesma fronteira.
    try {
        await enfileirarHistory(processarBacbo, 'startup');
    } catch (erro) {
        console.error('⚠️ TipMiner HISTORY startup falhou:', erro.message);
    }
    return true;
}

module.exports = { instalarTipMinerHistorySync };
