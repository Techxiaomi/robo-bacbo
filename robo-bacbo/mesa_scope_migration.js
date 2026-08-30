'use strict';

const mysql = require('mysql2/promise');

// MC22-C/D/F/G — associação operacional inicial com mesa_id.
// C/D cobre histórico/analítico; F associa robôs/estratégias; G associa o domínio
// financeiro persistido. Nenhuma consulta do runtime é filtrada por mesa ainda.
const TABELAS_HISTORICAS_MC22C = Object.freeze([
    'historico_resultados',
    'historico_disparos_robos',
    'historico_shadow_ia',
    'giros_recentes'
]);

const TABELAS_OPERACIONAIS_MC22F = Object.freeze([
    'robos_canais',
    'estrategias'
]);

const TABELAS_FINANCEIRAS_MC22G = Object.freeze([
    'auto_traders',
    'auditoria_ordens'
]);

function validarMesaPersistida(mesa) {
    const id = Number(mesa?.id);
    const codigo = String(mesa?.codigo || '').trim();
    if (!Number.isInteger(id) || id <= 0 || !codigo) {
        const erro = new Error('MC22: identidade persistida da mesa é inválida');
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


const INDICE_SHADOW_ANTIGO = 'uq_shadow_estrategia_giro';
const INDICE_SHADOW_MESA = 'uq_shadow_mesa_estrategia_giro';

async function obterIndicePorNome(conexao, tabela, indice) {
    const [linhas] = await conexao.query(
        `SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
         FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = ?
           AND INDEX_NAME = ?
         ORDER BY SEQ_IN_INDEX ASC`,
        [tabela, indice]
    );

    if (!Array.isArray(linhas) || linhas.length === 0) {
        return null;
    }

    return {
        nome: String(linhas[0].INDEX_NAME || ''),
        unico: linhas.every(
            row => Number(row.NON_UNIQUE) === 0
        ),
        colunas: linhas.map(
            row => String(row.COLUMN_NAME || '')
        )
    };
}

function indiceTemAssinatura(indice, colunas) {
    if (!indice || indice.unico !== true) return false;
    if (!Array.isArray(indice.colunas)) return false;
    if (indice.colunas.length !== colunas.length) return false;

    return colunas.every(
        (coluna, i) => indice.colunas[i] === coluna
    );
}

async function garantirUnicidadeShadowPorMesa(conexao) {
    const tabela = 'historico_shadow_ia';

    if (!(await tabelaExiste(conexao, tabela))) {
        console.warn(
            'MC22-V-C | historico_shadow_ia ainda ausente; ' +
            'constraint sera criada pelo schema canonico.'
        );

        return {
            migrada: false,
            motivo: 'TABELA_AUSENTE'
        };
    }

    const colunaMesa = await obterColunaMesa(conexao, tabela);

    if (!colunaMesa) {
        const erro = new Error(
            'MC22-V-C: historico_shadow_ia sem mesa_id'
        );
        erro.code = 'SHADOW_MESA_ID_AUSENTE';
        throw erro;
    }

    let antigo = await obterIndicePorNome(
        conexao,
        tabela,
        INDICE_SHADOW_ANTIGO
    );

    let atual = await obterIndicePorNome(
        conexao,
        tabela,
        INDICE_SHADOW_MESA
    );

    if (
        antigo
        && !indiceTemAssinatura(
            antigo,
            ['estrategia_id', 'giro_resultado_id']
        )
    ) {
        const erro = new Error(
            'MC22-V-C: indice shadow legado possui assinatura inesperada'
        );
        erro.code = 'SHADOW_INDICE_LEGADO_INESPERADO';
        throw erro;
    }

    if (
        atual
        && !indiceTemAssinatura(
            atual,
            ['mesa_id', 'estrategia_id', 'giro_resultado_id']
        )
    ) {
        const erro = new Error(
            'MC22-V-C: indice shadow por mesa possui assinatura inesperada'
        );
        erro.code = 'SHADOW_INDICE_MESA_INESPERADO';
        throw erro;
    }

    if (!atual) {
        const [[duplicados]] = await conexao.query(
            `SELECT COUNT(*) AS total
             FROM (
                 SELECT
                     mesa_id,
                     estrategia_id,
                     giro_resultado_id
                 FROM historico_shadow_ia
                 GROUP BY
                     mesa_id,
                     estrategia_id,
                     giro_resultado_id
                 HAVING COUNT(*) > 1
             ) AS grupos_duplicados`
        );

        if (Number(duplicados?.total || 0) !== 0) {
            const erro = new Error(
                'MC22-V-C: historico_shadow_ia possui duplicidade por mesa'
            );
            erro.code = 'SHADOW_DUPLICIDADE_POR_MESA';
            throw erro;
        }

        await conexao.query(
            `ALTER TABLE historico_shadow_ia
             ADD UNIQUE KEY uq_shadow_mesa_estrategia_giro
             (mesa_id, estrategia_id, giro_resultado_id)`
        );

        atual = await obterIndicePorNome(
            conexao,
            tabela,
            INDICE_SHADOW_MESA
        );

        if (
            !indiceTemAssinatura(
                atual,
                ['mesa_id', 'estrategia_id', 'giro_resultado_id']
            )
        ) {
            const erro = new Error(
                'MC22-V-C: nova constraint shadow nao foi confirmada'
            );
            erro.code = 'SHADOW_INDICE_MESA_NAO_CONFIRMADO';
            throw erro;
        }
    }

    // A antiga so e removida depois de confirmar a nova.
    if (antigo) {
        await conexao.query(
            `ALTER TABLE historico_shadow_ia
             DROP INDEX uq_shadow_estrategia_giro`
        );
    }

    const antigoFinal = await obterIndicePorNome(
        conexao,
        tabela,
        INDICE_SHADOW_ANTIGO
    );

    const atualFinal = await obterIndicePorNome(
        conexao,
        tabela,
        INDICE_SHADOW_MESA
    );

    if (
        antigoFinal
        || !indiceTemAssinatura(
            atualFinal,
            ['mesa_id', 'estrategia_id', 'giro_resultado_id']
        )
    ) {
        const erro = new Error(
            'MC22-V-C: estado final da constraint shadow invalido'
        );
        erro.code = 'SHADOW_CONSTRAINT_FINAL_INVALIDA';
        throw erro;
    }

    return {
        migrada: true,
        indice: INDICE_SHADOW_MESA
    };
}

async function garantirMesaIdTabela(
    conexao,
    tabela,
    mesaId,
    fase
) {
    if (!(await tabelaExiste(conexao, tabela))) {
        // Em fresh install, bot2_coletor cria posteriormente
        // o schema canonico ja neutro por mesa.
        console.warn(
            `?? ${fase} | ${tabela}: tabela ainda ausente; ` +
            `vinculo mesa_id adiado.`
        );

        return {
            tabela,
            migrada: false,
            motivo: 'TABELA_AUSENTE'
        };
    }

    let colunaAtual =
        await obterColunaMesa(conexao, tabela);

    if (!colunaAtual) {
        // MC22-Z-B:
        // Em tabela legada populada, a coluna nasce nullable
        // apenas durante a janela controlada de backfill.
        // Nenhum DEFAULT dependente da instancia e criado.
        await conexao.query(
            `ALTER TABLE \`${tabela}\`
             ADD COLUMN mesa_id SMALLINT UNSIGNED NULL`
        );

        colunaAtual =
            await obterColunaMesa(conexao, tabela);

        if (!colunaAtual) {
            const erro = new Error(
                `${fase}: ${tabela} nao criou mesa_id`
            );
            erro.code = 'MESA_COLUNA_NAO_CRIADA';
            throw erro;
        }
    }

    const [[pendentesAntes]] =
        await conexao.query(
            `SELECT COUNT(*) AS sem_mesa
             FROM \`${tabela}\`
             WHERE mesa_id IS NULL`
        );

    const totalSemMesaAntes =
        Math.max(
            0,
            Number(pendentesAntes?.sem_mesa) || 0
        );

    if (totalSemMesaAntes > 0) {
        // Backfill estritamente legado:
        // apenas registros ainda sem dono recebem a mesa
        // que esta executando a migracao.
        await conexao.query(
            `UPDATE \`${tabela}\`
             SET mesa_id=?
             WHERE mesa_id IS NULL`,
            [mesaId]
        );
    }

    const colunaNormalizacao =
        await obterColunaMesa(conexao, tabela);

    if (!colunaNormalizacao) {
        const erro = new Error(
            `${fase}: ${tabela} perdeu coluna mesa_id`
        );
        erro.code = 'MESA_COLUNA_AUSENTE';
        throw erro;
    }

    const nullable =
        String(
            colunaNormalizacao.IS_NULLABLE || ''
        ).toUpperCase() === 'YES';

    const defaultPresente =
        colunaNormalizacao.COLUMN_DEFAULT !== null
        && colunaNormalizacao.COLUMN_DEFAULT !== undefined;

    const tipoAtual =
        String(
            colunaNormalizacao.COLUMN_TYPE || ''
        ).toLowerCase();

    const tipoOk =
        tipoAtual.includes('smallint')
        && tipoAtual.includes('unsigned');

    if (
        nullable
        || defaultPresente
        || !tipoOk
    ) {
        // Estado canonico compartilhado:
        // NOT NULL e SEM DEFAULT de mesa.
        await conexao.query(
            `ALTER TABLE \`${tabela}\`
             MODIFY COLUMN mesa_id
             SMALLINT UNSIGNED NOT NULL`
        );
    }

    const colunaFinal =
        await obterColunaMesa(conexao, tabela);

    const finalNullable =
        String(
            colunaFinal?.IS_NULLABLE || ''
        ).toUpperCase() === 'YES';

    const finalDefaultPresente =
        colunaFinal?.COLUMN_DEFAULT !== null
        && colunaFinal?.COLUMN_DEFAULT !== undefined;

    const finalTipo =
        String(
            colunaFinal?.COLUMN_TYPE || ''
        ).toLowerCase();

    const finalTipoOk =
        finalTipo.includes('smallint')
        && finalTipo.includes('unsigned');

    if (
        !colunaFinal
        || finalNullable
        || finalDefaultPresente
        || !finalTipoOk
    ) {
        const erro = new Error(
            `${fase}: ${tabela} permaneceu com ` +
            `schema mesa_id nao neutro`
        );
        erro.code = 'MESA_SCHEMA_NAO_NEUTRO';
        throw erro;
    }

    const [[validacao]] =
        await conexao.query(
            `SELECT COUNT(*) AS sem_mesa
             FROM \`${tabela}\`
             WHERE mesa_id IS NULL`
        );

    if (
        Number(validacao?.sem_mesa || 0) !== 0
    ) {
        const erro = new Error(
            `${fase}: ${tabela} permaneceu ` +
            `com registros sem mesa_id`
        );
        erro.code = 'MESA_BACKFILL_INCOMPLETO';
        throw erro;
    }

    return {
        tabela,
        migrada: true
    };
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
        const historicas = [];
        for (const tabela of TABELAS_HISTORICAS_MC22C) {
            historicas.push(await garantirMesaIdTabela(conexao, tabela, mesa.id, 'MC22-C/D'));
        }

        const historicasMigradas = historicas.filter(item => item.migrada).length;
        console.log(
            `🧭 MC22-C/D | Escopo histórico/analítico associado a ${mesa.codigo}: `
            + `${historicasMigradas}/${TABELAS_HISTORICAS_MC22C.length} tabela(s).`
        );

        const shadowUnicidade =
            await garantirUnicidadeShadowPorMesa(conexao);

        if (shadowUnicidade.migrada) {
            console.log(
                `MC22-V-C | Shadow IA com unicidade por mesa: ` +
                `${shadowUnicidade.indice}.`
            );
        }

        const operacionais = [];
        for (const tabela of TABELAS_OPERACIONAIS_MC22F) {
            operacionais.push(await garantirMesaIdTabela(conexao, tabela, mesa.id, 'MC22-F'));
        }

        const operacionaisMigradas = operacionais.filter(item => item.migrada).length;
        console.log(
            `🧭 MC22-F | Robôs/estratégias associados a ${mesa.codigo}: `
            + `${operacionaisMigradas}/${TABELAS_OPERACIONAIS_MC22F.length} tabela(s).`
        );

        const financeiras = [];
        for (const tabela of TABELAS_FINANCEIRAS_MC22G) {
            financeiras.push(await garantirMesaIdTabela(conexao, tabela, mesa.id, 'MC22-G'));
        }

        const financeirasMigradas = financeiras.filter(item => item.migrada).length;
        console.log(
            `🧭 MC22-G | Auto-Trader/auditoria associados a ${mesa.codigo}: `
            + `${financeirasMigradas}/${TABELAS_FINANCEIRAS_MC22G.length} tabela(s).`
        );

        return {
            historicas,
            shadowUnicidade,
            operacionais,
            financeiras
        };
    } finally {
        await conexao.end();
    }
}

module.exports = {
    TABELAS_HISTORICAS_MC22C,
    TABELAS_OPERACIONAIS_MC22F,
    TABELAS_FINANCEIRAS_MC22G,
    prepararEscopoHistoricoMesaAtual
};
