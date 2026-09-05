'use strict';

const {
    validarEscritaEstrategiaEmOrigem,
    validarEscritaRobo
} = require('./strategy_profile_write_validation');

function ok(extra = {}) {
    return Object.freeze({
        ok: true,
        status: 200,
        ...extra
    });
}

function conflito(erro, detalhe = {}) {
    return Object.freeze({
        ok: false,
        status: 409,
        body: Object.freeze({
            sucesso: false,
            erro,
            ...detalhe
        })
    });
}

async function buscarOrigem({
    dbPool,
    mesaId,
    origem
}) {
    const nome = String(origem ?? '').trim();

    const [rows] = await dbPool.query(
        `SELECT id, mesa_id, nome
         FROM origens
         WHERE mesa_id=?
           AND nome=?
         LIMIT 1`,
        [Number(mesaId), nome]
    );

    return (
        Array.isArray(rows)
        && rows.length === 1
    )
        ? rows[0]
        : null;
}

async function buscarEstrategiaManual({
    dbPool,
    mesaId,
    estrategiaId
}) {
    const [rows] = await dbPool.query(
        `SELECT
            id,
            mesa_id,
            nome,
            origem,
            gales,
            proteger_empate,
            is_dinamico,
            robo_dono_id
         FROM estrategias
         WHERE mesa_id=?
           AND id=?
           AND is_dinamico=false
         LIMIT 1`,
        [
            Number(mesaId),
            String(estrategiaId ?? '')
        ]
    );

    return (
        Array.isArray(rows)
        && rows.length === 1
    )
        ? rows[0]
        : null;
}

async function listarEstrategiasManuaisDaOrigem({
    dbPool,
    mesaId,
    origem
}) {
    const [rows] = await dbPool.query(
        `SELECT
            id,
            mesa_id,
            nome,
            origem,
            gales,
            proteger_empate,
            is_dinamico,
            robo_dono_id
         FROM estrategias
         WHERE mesa_id=?
           AND origem=?
           AND is_dinamico=false
         ORDER BY id`,
        [
            Number(mesaId),
            String(origem ?? '').trim()
        ]
    );

    return Array.isArray(rows)
        ? rows
        : [];
}

async function carregarMesaEstrutural({
    dbPool,
    mesaId
}) {
    const [origens] = await dbPool.query(
        `SELECT
            id,
            mesa_id,
            nome
         FROM origens
         WHERE mesa_id=?
         ORDER BY id`,
        [Number(mesaId)]
    );

    const [estrategias] = await dbPool.query(
        `SELECT
            id,
            mesa_id,
            nome,
            origem,
            gales,
            proteger_empate,
            ativo,
            is_dinamico,
            robo_dono_id
         FROM estrategias
         WHERE mesa_id=?
         ORDER BY origem, id`,
        [Number(mesaId)]
    );

    return Object.freeze({
        origens: Array.isArray(origens)
            ? origens
            : [],

        estrategias: Array.isArray(estrategias)
            ? estrategias
            : []
    });
}

async function validarCriacaoEstrategiaRoute({
    dbPool,
    mesaId,
    estrategia
}) {
    const origemNome =
        String(estrategia?.origem ?? '').trim();

    const origem = await buscarOrigem({
        dbPool,
        mesaId,
        origem: origemNome
    });

    if (!origem) {
        return conflito(
            'ESTRATEGIA_ORIGEM_INEXISTENTE',
            {
                origem: origemNome
            }
        );
    }

    const existentes =
        await listarEstrategiasManuaisDaOrigem({
            dbPool,
            mesaId,
            origem: origemNome
        });

    return validarEscritaEstrategiaEmOrigem({
        estrategia,
        estrategiasDaOrigem: existentes
    });
}

async function validarEdicaoEstrategiaRoute({
    dbPool,
    mesaId,
    estrategiaId,
    estrategia
}) {
    const atual =
        await buscarEstrategiaManual({
            dbPool,
            mesaId,
            estrategiaId
        });

    /*
     * A rota antiga é responsável pelo 404.
     * Não transformamos inexistência em conflito estrutural.
     */
    if (!atual) {
        return ok({
            existente: false
        });
    }

    const origemDestino =
        String(estrategia?.origem ?? '').trim();

    const origem = await buscarOrigem({
        dbPool,
        mesaId,
        origem: origemDestino
    });

    if (!origem) {
        return conflito(
            'ESTRATEGIA_ORIGEM_INEXISTENTE',
            {
                origem: origemDestino,
                origem_anterior:
                    String(atual.origem ?? '').trim()
            }
        );
    }

    const destino =
        await listarEstrategiasManuaisDaOrigem({
            dbPool,
            mesaId,
            origem: origemDestino
        });

    const validacao =
        validarEscritaEstrategiaEmOrigem({
            estrategia,
            estrategiasDaOrigem: destino,
            estrategiaIdAtual:
                estrategiaId
        });

    if (!validacao.ok) {
        return validacao;
    }

    return Object.freeze({
        ...validacao,
        existente: true,
        origem_anterior:
            String(atual.origem ?? '').trim(),
        origem_destino:
            origemDestino,
        mudou_origem:
            String(atual.origem ?? '').trim()
            !== origemDestino
    });
}

async function validarCriacaoRoboRoute({
    dbPool,
    mesaId,
    config
}) {
    const estado =
        await carregarMesaEstrutural({
            dbPool,
            mesaId
        });

    return validarEscritaRobo({
        roboId: null,
        mesaId,
        config,
        origens: estado.origens,
        estrategias: estado.estrategias
    });
}

async function validarEdicaoRoboRoute({
    dbPool,
    mesaId,
    roboId,
    config
}) {
    const estado =
        await carregarMesaEstrutural({
            dbPool,
            mesaId
        });

    return validarEscritaRobo({
        roboId,
        mesaId,
        config,
        origens: estado.origens,
        estrategias: estado.estrategias
    });
}

module.exports = {
    buscarOrigem,
    buscarEstrategiaManual,
    listarEstrategiasManuaisDaOrigem,
    carregarMesaEstrutural,

    validarCriacaoEstrategiaRoute,
    validarEdicaoEstrategiaRoute,

    validarCriacaoRoboRoute,
    validarEdicaoRoboRoute
};
