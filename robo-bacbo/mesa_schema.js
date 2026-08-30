'use strict';

const mysql = require('mysql2/promise');
const { mesaConfigurada } = require('./mesa_context');

// MC22-B — persistência mínima e aditiva da identidade da mesa atual.
// Nao migra tabelas operacionais, nao registra segunda mesa e nao altera o runtime de sinais.
// O objetivo deste checkpoint é apenas garantir que BACBO_INT exista como entidade
// persistida antes de começarmos a introduzir mesa_id nos domínios existentes.
async function prepararSchemaMesas() {
    const mesa = mesaConfigurada();
    const conexao = await mysql.createConnection({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
    });

    try {
        await conexao.query(`
            CREATE TABLE IF NOT EXISTS mesas (
                id SMALLINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                codigo VARCHAR(40) NOT NULL,
                nome VARCHAR(120) NOT NULL,
                tipo_jogo VARCHAR(40) NOT NULL,
                ativo BOOLEAN NOT NULL DEFAULT true,
                config_json TEXT DEFAULT NULL,
                criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uq_mesas_codigo (codigo)
            )
        `);

        await conexao.query(
            `INSERT INTO mesas (codigo, nome, tipo_jogo, ativo)
             VALUES (?, ?, ?, true)
             ON DUPLICATE KEY UPDATE
                 nome=VALUES(nome),
                 tipo_jogo=VALUES(tipo_jogo)`,
            [mesa.codigo, mesa.nome, mesa.tipo_jogo]
        );

        const [linhas] = await conexao.query(
            `SELECT id, codigo, nome, tipo_jogo, ativo
             FROM mesas
             WHERE codigo=?
             LIMIT 1`,
            [mesa.codigo]
        );

        if (!Array.isArray(linhas) || linhas.length !== 1) {
            const erro = new Error(`MC22-B: identidade persistida ausente para ${mesa.codigo}`);
            erro.code = 'MESA_IDENTIDADE_AUSENTE';
            throw erro;
        }

        const persistida = linhas[0];
        if (
            String(persistida.codigo) !== mesa.codigo
            || String(persistida.tipo_jogo) !== mesa.tipo_jogo
        ) {
            const erro = new Error(`MC22-B: identidade persistida inconsistente para ${mesa.codigo}`);
            erro.code = 'MESA_IDENTIDADE_INCONSISTENTE';
            throw erro;
        }

        console.log(
            `🧭 MC22 | Mesa canônica persistida: ${persistida.codigo} `
            + `(${persistida.nome}) | id=${persistida.id}.`
        );

        return {
            id: Number(persistida.id),
            codigo: String(persistida.codigo),
            nome: String(persistida.nome),
            tipo_jogo: String(persistida.tipo_jogo),
            ativo: Boolean(persistida.ativo)
        };
    } finally {
        await conexao.end();
    }
}

module.exports = {
    prepararSchemaMesas
};
