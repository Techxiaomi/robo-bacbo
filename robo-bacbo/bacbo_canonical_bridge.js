'use strict';

const mysql = require('mysql2/promise');

const MAX_HISTORY = 1000;
const MATCH_TOLERANCE_MS = 1500;

let pool = null;
let history = [];
let canonicalSession = `BACBO-V3-${Date.now()}`;
let integrationPatched = false;
let recoveryQueue = Promise.resolve();

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

function numero(valor) {
    const n = Number(valor);
    return Number.isFinite(n) ? n : null;
}

function normalizarWinner(valor) {
    const bruto = String(valor || '').trim().toUpperCase();
    if (bruto === 'PLAYER' || bruto === 'PLAYERWON' || bruto === 'P') return 'Player';
    if (bruto === 'BANKER' || bruto === 'BANKERWON' || bruto === 'B') return 'Banker';
    if (bruto === 'TIE' || bruto === 'TIEWON' || bruto === 'T') return 'Tie';
    return null;
}

function multiplicadorTie(score) {
    const n = numero(score);
    if (n === 2 || n === 12) return '88x';
    if (n === 3 || n === 11) return '25x';
    if (n === 4 || n === 10) return '10x';
    if (n === 5 || n === 9) return '6x';
    return '4x';
}

function normalizarRound(round) {
    if (!round || typeof round !== 'object') return null;
    const uuid = String(round.uuid || '').trim();
    const winner = normalizarWinner(round.winner || round.type || round.resultado || round.vencedor);
    const result = numero(round.result);
    const timestampMs = numero(round.timestamp_ms);
    if (!uuid || !winner || result === null || timestampMs === null || timestampMs <= 0) return null;
    return {
        uuid,
        winner,
        result,
        timestamp_ms: Math.trunc(timestampMs),
        canonical_session: String(round.canonical_session || canonicalSession)
    };
}

function ordenarUnicos(rounds) {
    const porUuid = new Map();
    for (const item of Array.isArray(rounds) ? rounds : []) {
        const round = normalizarRound(item);
        if (round) porUuid.set(round.uuid, round);
    }
    return [...porUuid.values()].sort((a, b) => a.timestamp_ms - b.timestamp_ms || a.uuid.localeCompare(b.uuid));
}

function trimHistory() {
    history.sort((a, b) => a.timestamp_ms - b.timestamp_ms || a.uuid.localeCompare(b.uuid));
    if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
}

function mergeHistory(rounds, { snapshot = false } = {}) {
    const incoming = ordenarUnicos(rounds);
    if (incoming.length === 0) return [];

    if (snapshot && history.length > 0) {
        const atuais = new Set(history.map(item => item.uuid));
        const possuiSobreposicao = incoming.some(item => atuais.has(item.uuid));
        if (!possuiSobreposicao) canonicalSession = `BACBO-V3-${Date.now()}`;
    }

    const mapa = new Map(history.map(item => [item.uuid, item]));
    for (const item of incoming) {
        mapa.set(item.uuid, {
            ...item,
            canonical_session: canonicalSession
        });
    }
    history = [...mapa.values()];
    trimHistory();
    return incoming;
}

function registrarRodada(round) {
    mergeHistory([round]);
}

function obterHistoricoCanonicoLive() {
    if (history.length === 0) {
        return {
            pronto: false,
            orientacao: 'OLD_TO_NEW',
            history: [],
            coletor_sessao: canonicalSession,
            atualizado_em: null
        };
    }

    return {
        pronto: true,
        orientacao: 'OLD_TO_NEW',
        history: history.map(round => ({
            uuid: round.uuid,
            resultado: round.winner,
            multiplicador: round.winner === 'Tie' ? multiplicadorTie(round.result) : '',
            id_sessao: round.canonical_session,
            timestamp_ms: round.timestamp_ms,
            result: round.result
        })),
        coletor_sessao: canonicalSession,
        atualizado_em: Date.now()
    };
}

function gerarSessaoRecuperacao(idAnterior = null) {
    const anterior = numero(idAnterior);
    const agora = Date.now();
    return anterior === null ? agora : Math.max(agora, Math.trunc(anterior) + 1);
}

async function garantirLedgerAnalitico() {
    const db = dbPool();
    await db.query(`
        CREATE TABLE IF NOT EXISTS giros_recentes (
            id INT AUTO_INCREMENT PRIMARY KEY,
            resultado VARCHAR(20),
            p_d1 INT DEFAULT 0,
            p_d2 INT DEFAULT 0,
            b_d1 INT DEFAULT 0,
            b_d2 INT DEFAULT 0,
            numero_empate INT DEFAULT 0,
            multiplicador VARCHAR(10) DEFAULT '',
            id_sessao BIGINT,
            data_hora DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
}

async function giroJaExiste(db, round) {
    const inicio = (round.timestamp_ms - MATCH_TOLERANCE_MS) / 1000;
    const fim = (round.timestamp_ms + MATCH_TOLERANCE_MS) / 1000;
    const [linhas] = await db.query(
        `SELECT id
         FROM giros_recentes
         WHERE resultado=?
           AND data_hora BETWEEN FROM_UNIXTIME(?) AND FROM_UNIXTIME(?)
         ORDER BY ABS(TIMESTAMPDIFF(MICROSECOND, data_hora, FROM_UNIXTIME(?))) ASC, id ASC
         LIMIT 1`,
        [round.winner, inicio, fim, round.timestamp_ms / 1000]
    );
    return linhas.length > 0;
}

function localizarAncora(snapshot, ultimo) {
    if (!ultimo || !Array.isArray(snapshot) || snapshot.length === 0) return -1;
    const ts = numero(ultimo.timestamp_ms);
    const winner = normalizarWinner(ultimo.resultado);
    if (ts === null || !winner) return -1;

    let melhorIndice = -1;
    let melhorDelta = Infinity;
    snapshot.forEach((round, indice) => {
        if (round.winner !== winner) return;
        const delta = Math.abs(round.timestamp_ms - ts);
        if (delta <= MATCH_TOLERANCE_MS && delta < melhorDelta) {
            melhorIndice = indice;
            melhorDelta = delta;
        }
    });
    return melhorIndice;
}

async function reconciliarHistoricoAnaliticoInterno(rounds) {
    const snapshot = ordenarUnicos(rounds);
    if (snapshot.length === 0) return { recuperados: 0, motivo: 'snapshot_vazio' };

    await garantirLedgerAnalitico();
    const db = dbPool();
    const [ultimos] = await db.query(`
        SELECT id, resultado, id_sessao,
               UNIX_TIMESTAMP(data_hora) * 1000 AS timestamp_ms
        FROM giros_recentes
        ORDER BY data_hora DESC, id DESC
        LIMIT 1
    `);

    const ultimo = ultimos[0] || null;
    const primeiraTs = snapshot[0].timestamp_ms;
    const ultimaTs = snapshot[snapshot.length - 1].timestamp_ms;
    const ultimoTs = numero(ultimo?.timestamp_ms);

    if (ultimoTs !== null && ultimoTs >= (ultimaTs - MATCH_TOLERANCE_MS)) {
        return { recuperados: 0, motivo: 'ledger_atualizado' };
    }

    const indiceAncora = localizarAncora(snapshot, ultimo);
    let candidatos = [];
    let idSessao = null;
    let fronteiraNova = false;

    if (indiceAncora >= 0) {
        candidatos = snapshot.slice(indiceAncora + 1);
        idSessao = numero(ultimo?.id_sessao) ?? gerarSessaoRecuperacao();
    } else if (ultimoTs === null) {
        candidatos = snapshot;
        idSessao = gerarSessaoRecuperacao();
        fronteiraNova = true;
    } else if (ultimoTs < (primeiraTs - MATCH_TOLERANCE_MS)) {
        candidatos = snapshot;
        idSessao = gerarSessaoRecuperacao(ultimo?.id_sessao);
        fronteiraNova = true;
    } else {
        console.warn(
            '⚠️ Recovery analítico não aplicado: a última rodada local cai dentro da janela histórica, '
            + 'mas não há âncora temporal segura. Ledger preservado sem adivinhação.'
        );
        return { recuperados: 0, motivo: 'ancora_ambigua' };
    }

    if (candidatos.length === 0) return { recuperados: 0, motivo: 'sem_gap' };

    const conexao = await db.getConnection();
    let recuperados = 0;
    try {
        await conexao.beginTransaction();
        for (const round of candidatos) {
            if (await giroJaExiste(conexao, round)) continue;
            const tie = round.winner === 'Tie';
            await conexao.query(
                `INSERT INTO giros_recentes
                    (resultado, p_d1, p_d2, b_d1, b_d2, numero_empate, multiplicador, id_sessao, data_hora)
                 VALUES (?, 0, 0, 0, 0, ?, ?, ?, FROM_UNIXTIME(?))`,
                [
                    round.winner,
                    tie ? Math.trunc(round.result) : 0,
                    tie ? multiplicadorTie(round.result) : '',
                    idSessao,
                    round.timestamp_ms / 1000
                ]
            );
            recuperados++;
        }
        await conexao.commit();
    } catch (erro) {
        try { await conexao.rollback(); } catch (_) {}
        throw erro;
    } finally {
        conexao.release();
    }

    if (recuperados > 0) {
        console.log(
            `🧩 Recovery analítico | ${recuperados} giro(s) recomposto(s) cronologicamente | `
            + `janela=${snapshot.length}${fronteiraNova ? ' | nova fronteira estatística' : ''}.`
        );
    }

    return { recuperados, motivo: fronteiraNova ? 'nova_fronteira' : 'continuidade_recuperada' };
}

function sincronizarHistorico(rounds) {
    const snapshot = mergeHistory(rounds, { snapshot: true });
    const executar = () => reconciliarHistoricoAnaliticoInterno(snapshot);
    recoveryQueue = recoveryQueue.then(executar, executar);
    return recoveryQueue;
}

function instalarCompatibilidadeSinais() {
    if (integrationPatched) return true;

    const moduloLegado = require('./bug051b_integration');
    const criarOriginal = moduloLegado.criarIntegracaoContadorDiario;
    if (typeof criarOriginal !== 'function') {
        throw new Error('Factory de integração de sinais não encontrada');
    }

    moduloLegado.criarIntegracaoContadorDiario = function criarIntegracaoComBacboV3(...args) {
        const integracao = criarOriginal(...args);
        const obterLegado = typeof integracao?.obterHistoricoCanonicoLive === 'function'
            ? integracao.obterHistoricoCanonicoLive.bind(integracao)
            : null;

        integracao.obterHistoricoCanonicoLive = (...providerArgs) => {
            const atual = obterHistoricoCanonicoLive(...providerArgs);
            if (atual.pronto) return atual;
            return obterLegado
                ? obterLegado(...providerArgs)
                : { pronto: false, orientacao: null, history: [], coletor_sessao: null };
        };
        return integracao;
    };

    integrationPatched = true;
    console.log('🔗 Histórico canônico V3 conectado ao motor de sinais Web/Telegram.');
    return true;
}

module.exports = {
    registrarRodada,
    sincronizarHistorico,
    obterHistoricoCanonicoLive,
    instalarCompatibilidadeSinais
};
