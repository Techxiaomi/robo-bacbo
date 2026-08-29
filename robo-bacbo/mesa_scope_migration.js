'use strict';

const mysql = require('mysql2/promise');

// MC22-C — primeira associação operacional com mesa_id.
// Escopo propositalmente restrito às tabelas históricas. Nenhuma consulta do runtime,
// lock, sinal, IA, Oráculo ou Auto-Trader é alterada neste checkpoint.
const TABELAS_HISTORICAS_MC22C = Object.freeze([
    'historico_resultados',
    'historico_disparos_robos',
    'historico_shadow_ia'
]);

function validarMesaPersistida(mesa) {
    const id = Number(mesa?.id);
    const codigo = String(mesa?.codigo || '').trim();
    if (!Number.isInteger(id) || id <= 0 || !codigo) {
        const erro = new Error('MC22-C: identidade persistida da mesa é inválida');
        erro.code = 'MESA_IDENTIDADE_INVALIDA';
        throw erro;
    }
    return { id, codigo };
}

async function tabelaExiste(conexao, tabela) {
    const [linhas] = await conexao.query(
        `SELECT COUNT(*) AS total
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        [tabela]
    );
    return Number(linhas?.[0]?.total || 0) === 1;
}

async function obterColunaMesa(conexao, tabela) {
    const [linhas] = await conexao.query(
        `SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = ?
           AND COLUMN_NAME = 'mesa_id'
         LIMIT 1`,
        [tabela]
    );
    return Array.isArray(linhas) && linhas.length === 1 ? linhas[0] : null;
}

async function garantirMesaIdHistorico(conexao, tabela, mesaId) {
    if (!(await tabelaExiste(conexao, tabela))) {
        // Em instalação totalmente nova, bot2_coletor ainda criará suas tabelas depois
        // deste bootstrap. Não criamos cópias parciais delas aqui para evitar divergência
        // de schema. A adaptação canônica dessas CREATE TABLE virá em checkpoint próprio.
        console.warn(`⚠️ MC22-C | ${tabela}: tabela ainda ausente; vínculo mesa_id adiado.`);
        return { tabela, migrada: false, motivo: 'TABELA_AUSENTE' };
    }

    const colunaAtual = await obterColunaMesa(conexao, tabela);
    if (!colunaAtual) {
        await conexao.query(
            `ALTER TABLE \`${tabela}\`
             ADD COLUMN mesa_id SMALLINT UNSIGNED NOT NULL DEFAULT ${mesaId}`
        );
    } else {
        // Recuperação idempotente de eventual execução parcial: primeiro preenche somente
        // linhas sem dono, nunca sobrescrevendo um mesa_id já existente.
        await conexao.query(
            `UPDATE \`${tabela}\` SET mesa_id=? WHERE mesa_id IS NULL`,
            [mesaId]
        );

        const nullable = String(colunaAtual.IS_NULLABLE || '').toUpperCase() === 'YES';
        const defaultAtual = Number(colunaAtual.COLUMN_DEFAULT);
        const tipoAtual = String(colunaAtual.COLUMN_TYPE || '').toLowerCase();
        const tipoOk = tipoAtual.includes('smallint') && tipoAtual.includes('unsigned');
        if (nullable || defaultAtual !== mesaId || !tipoOk) {
            await conexao.query(
                `ALTER TABLE \`${tabela}\`
                 MODIFY COLUMN mesa_id SMALLINT UNSIGNED NOT NULL DEFAULT ${mesaId}`
            );
        }
    }

    const [[validacao]] = await conexao.query(
        `SELECT COUNT(*) AS sem_mesa
         FROM \`${tabela}\`
         WHERE mesa_id IS NULL`
    );
    if (Number(validacao?.sem_mesa || 0) !== 0) {
        const erro = new Error(`MC22-C: ${tabela} permaneceu com registros sem mesa_id`);
        erro.code = 'MESA_BACKFILL_INCOMPLETO';
        throw erro;
    }

    return { tabela, migrada: true };
}

async function prepararEscopoHistoricoMesaAtual(mesaPersistida) {
    const mesa = validarMesaPersistida(mesaPersistida);
    const conexao = await mysql.createConnection({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
    });

    try {
        const resultados = [];
        for (const tabela of TABELAS_HISTORICAS_MC22C) {
            resultados.push(await garantirMesaIdHistorico(conexao, tabela, mesa.id));
        }

        const migradas = resultados.filter(item => item.migrada).length;
        console.log(
            `🧭 MC22-C | Escopo histórico associado a ${mesa.codigo}: `
            + `${migradas}/${TABELAS_HISTORICAS_MC22C.length} tabela(s).`
        );
        return resultados;
    } finally {
        await conexao.end();
    }
}

module.exports = {
    TABELAS_HISTORICAS_MC22C,
    prepararEscopoHistoricoMesaAtual
};
