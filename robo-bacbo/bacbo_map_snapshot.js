'use strict';

const fs = require('fs/promises');
const path = require('path');
const mysql = require('mysql2/promise');
const { createClient } = require('redis');
const { validarLiveRound } = require('./bacbo_payload_schema');
const { publicarRodadaLive } = require('./bacbo_live_bus');

const MAX_ROUNDS = 1000;
const SNAPSHOT_PATH = path.join(__dirname, 'public', 'bacbo-map-snapshot.json');
const RETENTION_KEY = 'robo_bacbo:recent_rounds_v3';
const HISTORY_KEY = 'bacbo_history';
const EVENTS_CHANNEL = 'bacbo_events';

let instalado = false;
let pool = null;
let subscriber = null;
let rodadas = [];
let persistencia = Promise.resolve();

function dbPool() {
    if (pool) return pool;
    pool = mysql.createPool({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        waitForConnections: true,
        connectionLimit: 2,
        queueLimit: 0
    });
    return pool;
}

function winner(valor) {
    const bruto = String(valor || '').trim().toUpperCase();
    if (bruto === 'PLAYER' || bruto === 'PLAYERWON' || bruto === 'P') return 'Player';
    if (bruto === 'BANKER' || bruto === 'BANKERWON' || bruto === 'B') return 'Banker';
    if (bruto === 'TIE' || bruto === 'TIEWON' || bruto === 'T') return 'Tie';
    return '';
}

function numero(valor) {
    const n = Number(valor);
    return Number.isFinite(n) ? n : null;
}

function normalizarRound(item) {
    if (!item || typeof item !== 'object') return null;
    const tipo = winner(item.winner || item.type || item.vencedor || item.resultado);
    const result = numero(item.result ?? item.resultado_soma ?? item.soma);
    const instant = item.instant || item.data_hora || item.timestamp || null;
    const ms = instant ? Date.parse(String(instant)) : NaN;
    if (!tipo || result === null || !Number.isFinite(ms)) return null;
    return {
        uuid: String(item.uuid || item.round_uuid || '').trim(),
        winner: tipo,
        result,
        instant: new Date(ms).toISOString(),
        ms
    };
}

function ordenarELimitar(lista) {
    const dedup = new Map();
    for (const item of lista) {
        const round = normalizarRound(item);
        if (!round) continue;
        const chave = round.uuid || `${round.instant}|${round.winner}|${round.result}`;
        dedup.set(chave, round);
    }
    return [...dedup.values()]
        .sort((a, b) => a.ms - b.ms)
        .slice(-MAX_ROUNDS);
}

function snapshotPublico() {
    return {
        version: 2,
        updated_at: new Date().toISOString(),
        rows: rodadas.map(({ uuid, winner: tipo, result, instant }) => ({
            uuid,
            winner: tipo,
            result,
            instant
        }))
    };
}

function persistirSnapshot() {
    persistencia = persistencia
        .then(async () => {
            const conteudo = JSON.stringify(snapshotPublico());
            await fs.writeFile(SNAPSHOT_PATH, conteudo, 'utf8');
        })
        .catch(erro => {
            console.warn(`⚠️ Mapa Bac Bo: snapshot visual não pôde ser gravado: ${erro.message}`);
        });
    return persistencia;
}

async function hidratarBanco() {
    try {
        const [linhas] = await dbPool().query(
            `SELECT uuid, winner, \`result\`, instant
             FROM bacbo_rounds
             ORDER BY instant DESC
             LIMIT ?`,
            [MAX_ROUNDS]
        );
        if (Array.isArray(linhas) && linhas.length > 0) {
            rodadas = ordenarELimitar(linhas.reverse());
            return rodadas.length;
        }
    } catch (_) {}
    return 0;
}

function parseJson(valor) {
    try { return JSON.parse(String(valor || '')); } catch (_) { return null; }
}

function extrairArrayHistorico(valor) {
    const parsed = typeof valor === 'string' ? parseJson(valor) : valor;
    if (Array.isArray(parsed)) return parsed;
    if (!parsed || typeof parsed !== 'object') return [];
    for (const chave of ['history', 'data', 'results', 'rounds']) {
        if (Array.isArray(parsed[chave])) return parsed[chave];
    }
    return [];
}

async function hidratarRedis(cliente) {
    const acumulado = [];
    try {
        const recentes = await cliente.lRange(RETENTION_KEY, 0, MAX_ROUNDS - 1);
        for (const bruto of recentes.reverse()) {
            const item = parseJson(bruto);
            if (item) acumulado.push(item);
        }
    } catch (_) {}

    try {
        const bruto = await cliente.get(HISTORY_KEY);
        acumulado.push(...extrairArrayHistorico(bruto));
    } catch (_) {}

    if (acumulado.length > 0) {
        rodadas = ordenarELimitar([...rodadas, ...acumulado]);
    }
    return rodadas.length;
}

function payloadLive(mensagem) {
    const raiz = parseJson(mensagem);
    if (!raiz || typeof raiz !== 'object') return null;
    const acao = String(raiz.action || '').toLowerCase();
    if (acao === 'history_sync') return null;

    for (const candidato of [raiz, raiz.data, raiz.payload, raiz.event]) {
        if (!candidato || typeof candidato !== 'object' || Array.isArray(candidato)) continue;
        if (candidato.uuid !== undefined && candidato.type !== undefined && candidato.result !== undefined) {
            return candidato;
        }
    }
    return null;
}

function incorporarLive(payload) {
    const validacao = validarLiveRound(payload);
    if (!validacao.ok) return false;

    const roundValidado = validacao.round;
    const round = {
        uuid: roundValidado.uuid,
        winner: roundValidado.winner,
        result: roundValidado.result,
        instant: roundValidado.instant,
        ms: roundValidado.timestamp_ms
    };

    rodadas = ordenarELimitar([...rodadas, round]);

    // Caminho crítico visual: o navegador recebe a rodada antes de qualquer I/O em disco.
    // O snapshot permanece apenas como recuperação para abertura/reconexão da página.
    publicarRodadaLive(round);
    void persistirSnapshot();
    return true;
}

async function conectarRedis() {
    const redisUrl = String(process.env.REDIS_URL || 'redis://127.0.0.1:6379').trim() || 'redis://127.0.0.1:6379';
    const timeoutBruto = Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 3000);
    const connectTimeout = Number.isFinite(timeoutBruto)
        ? Math.max(500, Math.min(15000, timeoutBruto))
        : 3000;

    subscriber = createClient({
        url: redisUrl,
        socket: { connectTimeout }
    });
    subscriber.on('error', erro => {
        console.warn(`⚠️ Mapa Bac Bo: Redis visual indisponível: ${erro.message}`);
    });
    await subscriber.connect();
    await hidratarRedis(subscriber);
    await persistirSnapshot();
    await subscriber.subscribe(EVENTS_CHANNEL, mensagem => {
        const live = payloadLive(mensagem);
        if (live) incorporarLive(live);
    });
}

async function instalarBacboMapSnapshot() {
    if (instalado) return true;
    instalado = true;

    await fs.mkdir(path.dirname(SNAPSHOT_PATH), { recursive: true });
    await hidratarBanco();
    await persistirSnapshot();

    void conectarRedis().catch(erro => {
        console.warn(`⚠️ Mapa Bac Bo: atualização em tempo real não iniciou: ${erro.message}`);
    });

    console.log(`🗺️ Mapa Bac Bo pronto | snapshot/recovery de até ${MAX_ROUNDS} rodada(s).`);
    return true;
}

module.exports = { instalarBacboMapSnapshot };
