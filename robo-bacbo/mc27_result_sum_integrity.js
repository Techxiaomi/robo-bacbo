'use strict';

const mysql = require('mysql2/promise');
const { obterMesaRuntime } = require('./mesa_runtime_context');

const MATCH_TOLERANCE_MS = 1500;
const AMBIGUITY_GAP_MS = 750;
const BACKFILL_BATCH = 250;
const BACKFILL_PAUSE_MS = 75;
const LIVE_INTERVAL_MS = 1500;
const LIVE_WINDOW_MINUTES = 10;

let pool = null;
let instalado = false;
let timerLive = null;
let backfillPromise = null;
let maxIdInicial = 0;

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

function numeroSoma(valor) {
    if (
        valor === null
        || valor === undefined
        || valor === ''
        || typeof valor === 'boolean'
    ) {
        return null;
    }

    const n = Number(valor);

    if (
        !Number.isInteger(n)
        || n < 2
        || n > 12
    ) {
        return null;
    }

    return n;
}

function timestampMs(valor) {
    if (valor instanceof Date) {
        const ms = valor.getTime();
        return Number.isFinite(ms) ? ms : NaN;
    }

    if (
        typeof valor === 'number'
        && Number.isFinite(valor)
    ) {
        return valor < 1e12 ? valor * 1000 : valor;
    }

    const ms = Date.parse(String(valor || ''));
    return Number.isFinite(ms) ? ms : NaN;
}

function normalizarWinner(valor) {
    const bruto = String(valor || '')
        .trim()
        .toUpperCase();

    if (
        bruto === 'PLAYER'
        || bruto === 'PLAYERWON'
        || bruto === 'P'
    ) {
        return 'Player';
    }

    if (
        bruto === 'BANKER'
        || bruto === 'BANKERWON'
        || bruto === 'B'
    ) {
        return 'Banker';
    }

    if (
        bruto === 'TIE'
        || bruto === 'TIEWON'
        || bruto === 'T'
    ) {
        return 'Tie';
    }

    return null;
}

function dadoValido(valor) {
    const n = Number(valor);
    return Number.isInteger(n) && n >= 1 && n <= 6
        ? n
        : null;
}

function somaLegadaComprovavel(giro) {
    const winner = normalizarWinner(giro?.resultado);

    if (winner === 'Player') {
        const d1 = dadoValido(giro?.p_d1);
        const d2 = dadoValido(giro?.p_d2);
        return d1 !== null && d2 !== null
            ? numeroSoma(d1 + d2)
            : null;
    }

    if (winner === 'Banker') {
        const d1 = dadoValido(giro?.b_d1);
        const d2 = dadoValido(giro?.b_d2);
        return d1 !== null && d2 !== null
            ? numeroSoma(d1 + d2)
            : null;
    }

    if (winner === 'Tie') {
        return numeroSoma(giro?.numero_empate);
    }

    return null;
}

function normalizarCanonico(item, indice) {
    const winner = normalizarWinner(item?.winner);
    const soma = numeroSoma(item?.result);
    const ms = timestampMs(item?.instant);
    const uuid = String(item?.uuid || '').trim();

    if (
        !winner
        || soma === null
        || !Number.isFinite(ms)
        || !uuid
    ) {
        return null;
    }

    return {
        indice,
        uuid,
        winner,
        soma,
        ms
    };
}

function parearGirosCanonicos(
    giros,
    canonicos,
    toleranciaMs = MATCH_TOLERANCE_MS
) {
    const normalizados =
        (Array.isArray(canonicos) ? canonicos : [])
            .map(normalizarCanonico)
            .filter(Boolean);

    const usados = new Set();
    const pares = new Map();

    for (const giro of Array.isArray(giros) ? giros : []) {
        const id = Number(giro?.id);
        const winner = normalizarWinner(giro?.resultado);
        const giroMs = timestampMs(giro?.data_hora);

        if (
            !Number.isInteger(id)
            || id <= 0
            || !winner
            || !Number.isFinite(giroMs)
        ) {
            continue;
        }

        const candidatos = [];

        for (const can of normalizados) {
            if (usados.has(can.indice)) continue;
            if (can.winner !== winner) continue;

            const distancia = Math.abs(can.ms - giroMs);

            if (distancia <= toleranciaMs) {
                candidatos.push({
                    ...can,
                    distancia
                });
            }
        }

        candidatos.sort(
            (a, b) =>
                a.distancia - b.distancia
                || a.ms - b.ms
                || a.uuid.localeCompare(b.uuid)
        );

        if (candidatos.length === 0) continue;

        if (
            candidatos.length > 1
            && (
                candidatos[1].distancia
                - candidatos[0].distancia
            ) < AMBIGUITY_GAP_MS
        ) {
            continue;
        }

        const escolhido = candidatos[0];
        usados.add(escolhido.indice);
        pares.set(id, {
            soma: escolhido.soma,
            round_uuid: escolhido.uuid,
            distancia_ms: escolhido.distancia
        });
    }

    return pares;
}

function pausa(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function tabelaExiste(db, tabela) {
    const [linhas] = await db.query(
        `SELECT COUNT(*) AS total
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA=DATABASE()
           AND TABLE_NAME=?`,
        [tabela]
    );

    return Number(linhas?.[0]?.total || 0) === 1;
}

async function colunaExiste(db, tabela, coluna) {
    const [linhas] = await db.query(
        `SELECT COUNT(*) AS total
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA=DATABASE()
           AND TABLE_NAME=?
           AND COLUMN_NAME=?`,
        [tabela, coluna]
    );

    return Number(linhas?.[0]?.total || 0) === 1;
}

async function indiceExiste(db, tabela, indice) {
    const [linhas] = await db.query(
        `SELECT COUNT(*) AS total
         FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA=DATABASE()
           AND TABLE_NAME=?
           AND INDEX_NAME=?`,
        [tabela, indice]
    );

    return Number(linhas?.[0]?.total || 0) > 0;
}

async function garantirColuna(
    db,
    tabela,
    coluna,
    definicao
) {
    if (await colunaExiste(db, tabela, coluna)) return false;

    try {
        await db.query(
            `ALTER TABLE \`${tabela}\`
             ADD COLUMN \`${coluna}\` ${definicao}`
        );
    } catch (erro) {
        if (
            erro?.code === 'ER_DUP_FIELDNAME'
            || Number(erro?.errno) === 1060
        ) {
            return false;
        }

        throw erro;
    }

    return true;
}

async function garantirIndice(
    db,
    tabela,
    indice,
    colunasSql
) {
    if (await indiceExiste(db, tabela, indice)) return false;

    try {
        await db.query(
            `ALTER TABLE \`${tabela}\`
             ADD INDEX \`${indice}\` (${colunasSql})`
        );
    } catch (erro) {
        if (
            erro?.code === 'ER_DUP_KEYNAME'
            || Number(erro?.errno) === 1061
        ) {
            return false;
        }

        throw erro;
    }

    return true;
}

async function garantirSchema() {
    const db = dbPool();

    await db.query(`
        CREATE TABLE IF NOT EXISTS giros_recentes (
            id INT AUTO_INCREMENT PRIMARY KEY,
            mesa_id SMALLINT UNSIGNED NOT NULL,
            resultado VARCHAR(20),
            p_d1 INT DEFAULT 0,
            p_d2 INT DEFAULT 0,
            b_d1 INT DEFAULT 0,
            b_d2 INT DEFAULT 0,
            numero_empate INT DEFAULT 0,
            multiplicador VARCHAR(10) DEFAULT '',
            id_sessao BIGINT,
            data_hora DATETIME DEFAULT CURRENT_TIMESTAMP,
            resultado_soma TINYINT UNSIGNED NULL,
            round_uuid CHAR(36) NULL
        )
    `);

    const adicionouSoma = await garantirColuna(
        db,
        'giros_recentes',
        'resultado_soma',
        'TINYINT UNSIGNED NULL'
    );

    const adicionouUuid = await garantirColuna(
        db,
        'giros_recentes',
        'round_uuid',
        'CHAR(36) NULL'
    );

    await garantirIndice(
        db,
        'giros_recentes',
        'idx_mc27_mesa_soma_id',
        '`mesa_id`, `resultado_soma`, `id`'
    );

    if (await tabelaExiste(db, 'bacbo_rounds')) {
        await garantirIndice(
            db,
            'bacbo_rounds',
            'idx_mc27_mesa_instant',
            '`mesa_id`, `instant`'
        );
    }

    return {
        adicionou_soma: adicionouSoma,
        adicionou_uuid: adicionouUuid
    };
}

async function carregarCanonicosJanela(
    db,
    mesaId,
    giros
) {
    if (!(await tabelaExiste(db, 'bacbo_rounds'))) {
        return [];
    }

    const tempos =
        giros
            .map(giro => timestampMs(giro?.data_hora))
            .filter(Number.isFinite);

    if (tempos.length === 0) return [];

    const inicio =
        new Date(Math.min(...tempos) - MATCH_TOLERANCE_MS);

    const fim =
        new Date(Math.max(...tempos) + MATCH_TOLERANCE_MS);

    const [linhas] = await db.query(
        `SELECT uuid, winner, \`result\`, instant
         FROM bacbo_rounds
         WHERE mesa_id=?
           AND instant BETWEEN ? AND ?
           AND \`result\` BETWEEN 2 AND 12
         ORDER BY instant ASC, uuid ASC`,
        [mesaId, inicio, fim]
    );

    return Array.isArray(linhas) ? linhas : [];
}

function construirReparos(giros, canonicos) {
    const pares = parearGirosCanonicos(
        giros,
        canonicos,
        MATCH_TOLERANCE_MS
    );

    const reparos = [];

    for (const giro of giros) {
        const id = Number(giro?.id);
        if (!Number.isInteger(id) || id <= 0) continue;

        const can = pares.get(id);

        if (can) {
            reparos.push({
                id,
                soma: can.soma,
                round_uuid: can.round_uuid,
                origem: 'CANONICO'
            });
            continue;
        }

        const legado = somaLegadaComprovavel(giro);

        if (legado !== null) {
            reparos.push({
                id,
                soma: legado,
                round_uuid: null,
                origem: 'LEGADO'
            });
        }
    }

    return reparos;
}

async function aplicarReparos(db, mesaId, reparos) {
    const validos =
        (Array.isArray(reparos) ? reparos : [])
            .filter(item =>
                Number.isInteger(Number(item?.id))
                && Number(item.id) > 0
                && numeroSoma(item?.soma) !== null
            );

    if (validos.length === 0) return 0;

    const ids = validos.map(item => Number(item.id));

    const somaCases = validos
        .map(() => 'WHEN ? THEN ?')
        .join(' ');

    const somaParams = [];

    for (const item of validos) {
        somaParams.push(Number(item.id), Number(item.soma));
    }

    const uuidComprovados = validos.filter(
        item => String(item.round_uuid || '').trim() !== ''
    );

    let uuidSql = 'round_uuid';
    const uuidParams = [];

    if (uuidComprovados.length > 0) {
        uuidSql = `CASE id ${uuidComprovados
            .map(() => 'WHEN ? THEN ?')
            .join(' ')} ELSE round_uuid END`;

        for (const item of uuidComprovados) {
            uuidParams.push(
                Number(item.id),
                String(item.round_uuid).trim()
            );
        }
    }

    const placeholders = ids.map(() => '?').join(',');

    const [resultado] = await db.query(
        `UPDATE giros_recentes
         SET resultado_soma = CASE id
                ${somaCases}
                ELSE resultado_soma
             END,
             round_uuid = ${uuidSql}
         WHERE mesa_id=?
           AND resultado_soma IS NULL
           AND id IN (${placeholders})`,
        [
            ...somaParams,
            ...uuidParams,
            mesaId,
            ...ids
        ]
    );

    return Math.max(
        0,
        Number(resultado?.affectedRows) || 0
    );
}

async function reconciliarLote(db, mesaId, giros) {
    if (!Array.isArray(giros) || giros.length === 0) {
        return {
            examinados: 0,
            reparados: 0,
            canonicos: 0,
            legados: 0
        };
    }

    const canonicos =
        await carregarCanonicosJanela(
            db,
            mesaId,
            giros
        );

    const reparos =
        construirReparos(
            giros,
            canonicos
        );

    const reparados =
        await aplicarReparos(
            db,
            mesaId,
            reparos
        );

    return {
        examinados: giros.length,
        reparados,
        canonicos: reparos.filter(
            item => item.origem === 'CANONICO'
        ).length,
        legados: reparos.filter(
            item => item.origem === 'LEGADO'
        ).length
    };
}

async function repararRecentes() {
    const mesaRuntime = obterMesaRuntime();
    const mesaId = Number(mesaRuntime.id);
    const db = dbPool();

    const [giros] = await db.query(
        `SELECT
            id,
            resultado,
            p_d1,
            p_d2,
            b_d1,
            b_d2,
            numero_empate,
            data_hora
         FROM giros_recentes
         WHERE mesa_id=?
           AND resultado_soma IS NULL
           AND data_hora >= NOW() - INTERVAL ${LIVE_WINDOW_MINUTES} MINUTE
         ORDER BY id DESC
         LIMIT 100`,
        [mesaId]
    );

    return reconciliarLote(
        db,
        mesaId,
        Array.isArray(giros) ? giros.reverse() : []
    );
}

async function executarBackfillHistorico(limiteId) {
    const mesaRuntime = obterMesaRuntime();
    const mesaId = Number(mesaRuntime.id);
    const codigo = String(mesaRuntime.codigo || 'BACBO');
    const db = dbPool();

    let cursor = Number(limiteId);
    let totalExaminado = 0;
    let totalReparado = 0;
    let totalCanonico = 0;
    let totalLegado = 0;

    while (Number.isInteger(cursor) && cursor > 0) {
        const [giros] = await db.query(
            `SELECT
                id,
                resultado,
                p_d1,
                p_d2,
                b_d1,
                b_d2,
                numero_empate,
                data_hora
             FROM giros_recentes
             WHERE mesa_id=?
               AND id<=?
               AND resultado_soma IS NULL
             ORDER BY id DESC
             LIMIT ${BACKFILL_BATCH}`,
            [mesaId, cursor]
        );

        if (!Array.isArray(giros) || giros.length === 0) {
            break;
        }

        const menorId = Math.min(
            ...giros.map(item => Number(item.id))
                .filter(Number.isFinite)
        );

        if (!Number.isFinite(menorId) || menorId <= 0) {
            break;
        }

        const lote = await reconciliarLote(
            db,
            mesaId,
            giros.slice().reverse()
        );

        totalExaminado += lote.examinados;
        totalReparado += lote.reparados;
        totalCanonico += lote.canonicos;
        totalLegado += lote.legados;

        cursor = Math.trunc(menorId) - 1;

        await pausa(BACKFILL_PAUSE_MS);
    }

    console.log(
        `MC27 | ${codigo} | backfill soma concluido | `
        + `examinados=${totalExaminado} | reparados=${totalReparado} | `
        + `canonico=${totalCanonico} | legado=${totalLegado}.`
    );

    return {
        examinados: totalExaminado,
        reparados: totalReparado,
        canonicos: totalCanonico,
        legados: totalLegado
    };
}

function iniciarMonitorLive() {
    if (timerLive) return timerLive;

    timerLive = setInterval(() => {
        void repararRecentes().catch(erro => {
            console.warn(
                `MC27 | reconciliacao live da soma falhou: ${erro.message}`
            );
        });
    }, LIVE_INTERVAL_MS);

    timerLive.unref?.();
    return timerLive;
}

async function instalarIntegridadeSomaResultados() {
    if (instalado) return true;

    const mesaRuntime = obterMesaRuntime();
    const mesaId = Number(mesaRuntime.id);
    const codigo = String(mesaRuntime.codigo || '').trim();

    if (
        !Number.isInteger(mesaId)
        || mesaId <= 0
        || !codigo
    ) {
        const erro = new Error(
            'MC27: mesa runtime invalida para integridade da soma'
        );
        erro.code = 'MC27_MESA_RUNTIME_INVALIDA';
        throw erro;
    }

    const schema = await garantirSchema();
    const db = dbPool();

    const [[estado]] = await db.query(
        `SELECT
            COALESCE(MAX(id), 0) AS max_id,
            SUM(CASE WHEN resultado_soma IS NULL THEN 1 ELSE 0 END) AS pendentes
         FROM giros_recentes
         WHERE mesa_id=?`,
        [mesaId]
    );

    maxIdInicial = Math.max(
        0,
        Number(estado?.max_id) || 0
    );

    const pendentes = Math.max(
        0,
        Number(estado?.pendentes) || 0
    );

    const recentes = await repararRecentes();

    iniciarMonitorLive();

    backfillPromise =
        pausa(500)
            .then(() => executarBackfillHistorico(maxIdInicial))
            .catch(erro => {
                console.warn(
                    `MC27 | ${codigo} | backfill historico da soma interrompido: ${erro.message}`
                );
                return null;
            });

    instalado = true;

    console.log(
        `MC27 | integridade da soma ativa em ${codigo} | `
        + `resultado_soma=${schema.adicionou_soma ? 'criada' : 'ok'} | `
        + `round_uuid=${schema.adicionou_uuid ? 'criada' : 'ok'} | `
        + `pendentes=${pendentes} | recentes_reparados=${recentes.reparados}.`
    );

    return true;
}

module.exports = {
    MATCH_TOLERANCE_MS,
    AMBIGUITY_GAP_MS,
    numeroSoma,
    normalizarWinner,
    somaLegadaComprovavel,
    parearGirosCanonicos,
    construirReparos,
    instalarIntegridadeSomaResultados
};
