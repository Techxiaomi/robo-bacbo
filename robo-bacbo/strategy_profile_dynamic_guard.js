'use strict';

const {
    dinamico
} = require('./strategy_profile_policy');

const {
    validarEscritaRobo
} = require('./strategy_profile_write_validation');

function resultadoOk(extra = {}) {
    return Object.freeze({
        ok: true,
        ...extra
    });
}

function resultadoFalha(
    erro,
    detalhe = {}
) {
    return Object.freeze({
        ok: false,

        erro,

        ...detalhe
    });
}

function criarFilhoDinamicoVirtual({
    candidato,
    robo,
    mesaId,
    configAutoTuning
}) {
    return Object.freeze({
        id:
            String(
                candidato?.id ?? ''
            ),

        mesa_id:
            Number(mesaId),

        origem:
            String(
                candidato?.origem
                ?? `[AUTO] ${String(
                    robo?.nome
                    ?? `Auto Pilot ${robo?.id ?? ''}`
                )}`
            ).trim(),

        gales:
            configAutoTuning?.gales,

        proteger_empate:
            configAutoTuning
                ?.proteger_empate,

        ativo:
            candidato?.ativo
            ?? false,

        is_dinamico:
            true,

        robo_dono_id:
            Number(robo?.id)
    });
}

function snapshotPosReconciliacao({
    estrategias,
    candidatosRetidos,
    robo,
    mesaId,
    configAutoTuning
}) {
    const roboId =
        Number(robo?.id);

    const base =
        (
            Array.isArray(estrategias)
                ? estrategias
                : []
        ).filter(
            estrategia =>
                !(
                    Number(
                        estrategia?.mesa_id
                    ) === Number(mesaId)

                    && dinamico(
                        estrategia?.is_dinamico
                    )

                    && Number(
                        estrategia
                            ?.robo_dono_id
                    ) === roboId
                )
        );

    const filhos =
        (
            Array.isArray(
                candidatosRetidos
            )
                ? candidatosRetidos
                : []
        ).map(
            candidato =>
                criarFilhoDinamicoVirtual({
                    candidato,
                    robo,
                    mesaId,
                    configAutoTuning
                })
        );

    return Object.freeze([
        ...base,
        ...filhos
    ]);
}

function validarFilhosDinamicosDoRobo({
    robo,
    mesaId,
    configRobo,
    configAutoTuning,
    origens,
    estrategias,
    candidatosRetidos
}) {
    const candidatos =
        Array.isArray(
            candidatosRetidos
        )
            ? candidatosRetidos
            : [];

    /*
     * Sem candidato a criar/atualizar, este gate não deve
     * impedir o Auto Pilot de remover/desativar filhos antigos.
     * A operação nesse caso é redutora de estado.
     */
    if (candidatos.length === 0) {
        return resultadoOk({
            motivo:
                'SEM_FILHOS_A_PERSISTIR',

            total_filhos:
                0
        });
    }

    const roboId =
        Number(robo?.id);

    if (
        !Number.isInteger(roboId)
        || roboId <= 0
    ) {
        return resultadoFalha(
            'AUTO_PILOT_ROBO_PAI_INVALIDO'
        );
    }

    const snapshot =
        snapshotPosReconciliacao({
            estrategias,
            candidatosRetidos:
                candidatos,

            robo,
            mesaId,
            configAutoTuning
        });

    const validacao =
        validarEscritaRobo({
            roboId,
            mesaId,

            config:
                configRobo,

            origens,
            estrategias:
                snapshot
        });

    if (!validacao.ok) {
        return resultadoFalha(
            'AUTO_PILOT_FILHO_PERFIL_ESTRUTURAL_INCOMPATIVEL',
            {
                robo_id:
                    roboId,

                robo_nome:
                    String(
                        robo?.nome ?? ''
                    ),

                total_filhos:
                    candidatos.length,

                validacao:
                    validacao.body
                    ?? validacao
            }
        );
    }

    return resultadoOk({
        robo_id:
            roboId,

        perfil:
            validacao.perfil,

        estado:
            validacao.estado,

        total_filhos:
            candidatos.length,

        estrategias:
            validacao.estrategias
    });
}

module.exports = {
    criarFilhoDinamicoVirtual,
    snapshotPosReconciliacao,
    validarFilhosDinamicosDoRobo
};
