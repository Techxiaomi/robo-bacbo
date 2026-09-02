'use strict';

const mysql = require('mysql2/promise');
const canonicalBridge = require('./bacbo_canonical_bridge');
const { obterMesaRuntime } = require('./mesa_runtime_context');
const { withMysqlDeadlockRetry } = require('./mysql_deadlock_retry');

let pool = null;
let inicializacao = null;

function criarPool() {
    if (pool) return pool;

    pool = mysql.createPool({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        waitForConnections: true,
        connectionLimit: 4,
        queueLimit: 0
    });

    return pool;
}

async function primaryKeyBacboRounds(db) {
    const [linhas] = await db.query(
        `SELECT COLUMN_NAME
         FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA=DATABASE()
           AND TABLE_NAME='bacbo_rounds'
           AND INDEX_NAME='PRIMARY'
         ORDER BY SEQ_IN_INDEX ASC`
    );

    return linhas.map(
        row => String(row.COLUMN_NAME || '')
    );
}

async function garantirEscopoMesaBacboRounds(db, mesaId) {
    const [colunas] = await db.query(
        `SELECT IS_NULLABLE
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA=DATABASE()
           AND TABLE_NAME='bacbo_rounds'
           AND COLUMN_NAME='mesa_id'`
    );

    if (colunas.length === 0) {
        await db.query(
            `ALTER TABLE bacbo_rounds
             ADD COLUMN mesa_id SMALLINT UNSIGNED NULL FIRST`
        );

        await db.query(
            `UPDATE bacbo_rounds
             SET mesa_id=?
             WHERE mesa_id IS NULL`,
            [mesaId]
        );

        await db.query(
            `ALTER TABLE bacbo_rounds
             MODIFY COLUMN mesa_id SMALLINT UNSIGNED NOT NULL`
        );
    } else {
        await db.query(
            `UPDATE bacbo_rounds
             SET mesa_id=?
             WHERE mesa_id IS NULL OR mesa_id<=0`,
            [mesaId]
        );

        if (
            String(colunas[0].IS_NULLABLE || '').toUpperCase()
            === 'YES'
        ) {
            await db.query(
                `ALTER TABLE bacbo_rounds
                 MODIFY COLUMN mesa_id SMALLINT UNSIGNED NOT NULL`
            );
        }
    }

    const pk = await primaryKeyBacboRounds(db);

    if (
        pk.length === 1
        && pk[0] === 'uuid'
    ) {
        await db.query(
            `ALTER TABLE bacbo_rounds
             DROP PRIMARY KEY,
             ADD PRIMARY KEY (mesa_id, uuid)`
        );
    } else if (
        pk.length === 2
        && pk[0] === 'mesa_id'
        && pk[1] === 'uuid'
    ) {
        // estado esperado
    } else {
        throw new Error(
            `MC22-Y-A: PRIMARY KEY inesperada em bacbo_rounds: ` +
            `${pk.join(',') || '<ausente>'}`
        );
    }
}

async function garantirSchema() {
    if (inicializacao) return inicializacao;

    inicializacao = (async () => {
        const mesaRuntime = obterMesaRuntime();
        const mesaId = Number(mesaRuntime.id);

        if (!Number.isInteger(mesaId) || mesaId <= 0) {
            throw new Error(
                'MC22-Y-A: mesa runtime invalida em bacbo_rounds'
            );
        }

        const db = criarPool();

        await db.query(`
            CREATE TABLE IF NOT EXISTS bacbo_rounds (
                mesa_id SMALLINT UNSIGNED NOT NULL,
                uuid CHAR(36) NOT NULL,
                instant DATETIME(3) NOT NULL,
                \`result\` DOUBLE NOT NULL,
                winner VARCHAR(10) NOT NULL,
                PRIMARY KEY (mesa_id, uuid)
            )
        `);

        await garantirEscopoMesaBacboRounds(
            db,
            mesaId
        );

        return true;
    })();

    try {
        return await inicializacao;
    } catch (erro) {
        inicializacao = null;
        throw erro;
    }
}

async function persistirRodadaBacbo(round) {
    canonicalBridge.registrarRodada(round);

    await garantirSchema();

    const mesaRuntime = obterMesaRuntime();
    const db = criarPool();
    const timestampSegundos =
        Number(round.timestamp_ms) / 1000;

    await withMysqlDeadlockRetry(
        () => db.query(
            `INSERT INTO bacbo_rounds
                (mesa_id, uuid, instant, \`result\`, winner)
             VALUES (?, ?, FROM_UNIXTIME(?), ?, ?)
             ON DUPLICATE KEY UPDATE
                instant=VALUES(instant),
                \`result\`=VALUES(\`result\`),
                winner=VALUES(winner)`,
            [
                mesaRuntime.id,
                round.uuid,
                timestampSegundos,
                round.result,
                round.winner
            ]
        ),
        {
            onRetry: ({ nextAttempt, delayMs }) => {
                console.warn(
                    `BACBO_ROUND_DEADLOCK_RETRY uuid=${round.uuid} ` +
                    `attempt=${nextAttempt}/3 delay_ms=${delayMs}`
                );
            }
        }
    );

    return true;
}

function roundsUnicos(rounds) {
    const porUuid = new Map();

    for (
        const round
        of Array.isArray(rounds) ? rounds : []
    ) {
        const uuid =
            String(round?.uuid || '')
                .trim()
                .toLowerCase();

        if (!uuid) continue;
        porUuid.set(uuid, round);
    }

    return [...porUuid.values()];
}

async function localizarUuidsExistentes(
    conexao,
    uuids,
    mesaId
) {
    const existentes = new Set();

    const lista = [
        ...new Set(
            (Array.isArray(uuids) ? uuids : [])
                .map(String)
                .filter(Boolean)
        )
    ];

    const TAMANHO_LOTE = 100;

    for (
        let inicio = 0;
        inicio < lista.length;
        inicio += TAMANHO_LOTE
    ) {
        const lote =
            lista.slice(inicio, inicio + TAMANHO_LOTE);

        if (lote.length === 0) continue;

        const placeholders =
            lote.map(() => '?').join(',');

        const [linhas] = await conexao.query(
            `SELECT uuid
             FROM bacbo_rounds
             WHERE mesa_id=?
               AND uuid IN (${placeholders})`,
            [mesaId, ...lote]
        );

        for (const linha of linhas) {
            existentes.add(
                String(linha.uuid || '')
                    .trim()
                    .toLowerCase()
            );
        }
    }

    return existentes;
}

async function persistirHistoricoUmaTentativa(db, itens, mesaId) {
    const conexao = await db.getConnection();
    let novos = [];

    try {
        const existentes =
            await localizarUuidsExistentes(
                conexao,
                itens.map(round => round.uuid),
                mesaId
            );

        novos = itens.filter(
            round => !existentes.has(
                String(round.uuid || '')
                    .trim()
                    .toLowerCase()
            )
        );

        if (novos.length === 0) return 0;

        await conexao.beginTransaction();

        for (const round of novos) {
            await conexao.query(
                `INSERT INTO bacbo_rounds
                    (mesa_id, uuid, instant, \`result\`, winner)
                 VALUES (?, ?, FROM_UNIXTIME(?), ?, ?)
                 ON DUPLICATE KEY UPDATE
                    instant=VALUES(instant),
                    \`result\`=VALUES(\`result\`),
                    winner=VALUES(winner)`,
                [
                    mesaId,
                    round.uuid,
                    Number(round.timestamp_ms) / 1000,
                    round.result,
                    round.winner
                ]
            );
        }

        await conexao.commit();
        return novos.length;
    } catch (erro) {
        try {
            await conexao.rollback();
        } catch (_) {}
        throw erro;
    } finally {
        conexao.release();
    }
}

async function persistirHistoricoBacbo(rounds) {
    const itens = roundsUnicos(rounds);

    if (itens.length === 0) return 0;

    await garantirSchema();

    const mesaRuntime = obterMesaRuntime();
    const mesaId = Number(mesaRuntime.id);
    const db = criarPool();

    const novosPersistidos = await withMysqlDeadlockRetry(
        () => persistirHistoricoUmaTentativa(db, itens, mesaId),
        {
            onRetry: ({ nextAttempt, delayMs }) => {
                console.warn(
                    `BACBO_HISTORY_DEADLOCK_RETRY mesa=${mesaId} ` +
                    `attempt=${nextAttempt}/3 delay_ms=${delayMs}`
                );
            }
        }
    );

    try {
        await canonicalBridge.sincronizarHistorico(
            itens
        );
    } catch (erro) {
        console.error(
            'Recovery analitico do historico falhou:',
            erro.message
        );
    }

    return novosPersistidos;
}

module.exports = {
    garantirSchema,
    persistirRodadaBacbo,
    persistirHistoricoBacbo,
    persistirHistoricoUmaTentativa
};
