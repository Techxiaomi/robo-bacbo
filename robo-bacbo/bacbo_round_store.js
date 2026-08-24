'use strict';

const mysql = require('mysql2/promise');
const canonicalBridge = require('./bacbo_canonical_bridge');

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

async function garantirSchema() {
    if (inicializacao) return inicializacao;
    inicializacao = (async () => {
        const db = criarPool();
        await db.query(`
            CREATE TABLE IF NOT EXISTS bacbo_rounds (
                uuid CHAR(36) PRIMARY KEY,
                instant DATETIME(3) NOT NULL,
                \`result\` DOUBLE NOT NULL,
                winner VARCHAR(10) NOT NULL
            )
        `);
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
    // O histórico usado para detectar sinais é independente da disponibilidade do MySQL.
    // O Runtime V3 continua fail-open na persistência, mas nunca perde a rodada em memória.
    canonicalBridge.registrarRodada(round);

    await garantirSchema();
    const db = criarPool();
    const timestampSegundos = Number(round.timestamp_ms) / 1000;
    await db.query(
        `INSERT INTO bacbo_rounds (uuid, instant, \`result\`, winner)
         VALUES (?, FROM_UNIXTIME(?), ?, ?)
         ON DUPLICATE KEY UPDATE
            instant = VALUES(instant),
            \`result\` = VALUES(\`result\`),
            winner = VALUES(winner)`,
        [round.uuid, timestampSegundos, round.result, round.winner]
    );
    return true;
}

async function persistirHistoricoBacbo(rounds) {
    const itens = Array.isArray(rounds) ? rounds : [];
    if (itens.length === 0) return 0;
    await garantirSchema();
    const db = criarPool();
    const conexao = await db.getConnection();
    try {
        await conexao.beginTransaction();
        for (const round of itens) {
            await conexao.query(
                `INSERT INTO bacbo_rounds (uuid, instant, \`result\`, winner)
                 VALUES (?, FROM_UNIXTIME(?), ?, ?)
                 ON DUPLICATE KEY UPDATE
                    instant = VALUES(instant),
                    \`result\` = VALUES(\`result\`),
                    winner = VALUES(winner)`,
                [round.uuid, Number(round.timestamp_ms) / 1000, round.result, round.winner]
            );
        }
        await conexao.commit();
    } catch (erro) {
        try { await conexao.rollback(); } catch (_) { }
        throw erro;
    } finally {
        conexao.release();
    }

    // O backfill é apenas estatístico: grava giros_recentes diretamente e nunca chama /receber-sinal.
    // Falha de recovery não invalida a persistência canônica já confirmada acima.
    try {
        await canonicalBridge.sincronizarHistorico(itens);
    } catch (erro) {
        console.error('⚠️ Recovery analítico do histórico falhou sem afetar bacbo_rounds:', erro.message);
    }

    return itens.length;
}

module.exports = {
    garantirSchema,
    persistirRodadaBacbo,
    persistirHistoricoBacbo
};
