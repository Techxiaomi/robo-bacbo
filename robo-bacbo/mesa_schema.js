'use strict';

const mysql = require('mysql2/promise');
const {
    MESAS_CONHECIDAS,
    mesaConfigurada
} = require('./mesa_context');

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

        for (
            const conhecida
            of Object.values(MESAS_CONHECIDAS)
        ) {
            await conexao.query(
                `INSERT INTO mesas
                    (codigo, nome, tipo_jogo, ativo)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                     nome=VALUES(nome),
                     tipo_jogo=VALUES(tipo_jogo)`,
                [
                    conhecida.codigo,
                    conhecida.nome,
                    conhecida.tipo_jogo,
                    conhecida.ativo_persistido === true
                ]
            );

            // Identidade conhecida em pre-ativacao nunca pode
            // permanecer ativa por dado legado/manual.
            if (
                conhecida.runtime_habilitado !== true
                && conhecida.runtime_ativacao_explicita !== true
            ) {
                await conexao.query(
                    `UPDATE mesas
                     SET ativo=false
                     WHERE codigo=?`,
                    [conhecida.codigo]
                );
            }
        }

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

        if (!Boolean(persistida.ativo)) {
            const erro = new Error(
                `MC22-Z-F: mesa persistida inativa: ${mesa.codigo}`
            );

            erro.code =
                'MESA_PERSISTIDA_INATIVA';

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
