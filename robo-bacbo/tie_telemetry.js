'use strict';

const NIVEIS = Object.freeze([
    'direto',
    'gale1',
    'gale2'
]);

const RETORNO_PRINCIPAL_TIE =
    0.90;

const RETENCAO_PRINCIPAL_TIE =
    0.10;

function normalizarNivelEmpate(valor) {
    if (
        valor === 0
        || valor === '0'
        || String(valor || '')
            .trim()
            .toUpperCase() === 'DIRETO'
    ) {
        return 'direto';
    }

    if (
        valor === 1
        || valor === '1'
        || ['GALE1', 'G1', 'GALE 1'].includes(
            String(valor || '')
                .trim()
                .toUpperCase()
        )
    ) {
        return 'gale1';
    }

    if (
        valor === 2
        || valor === '2'
        || ['GALE2', 'G2', 'GALE 2'].includes(
            String(valor || '')
                .trim()
                .toUpperCase()
        )
    ) {
        return 'gale2';
    }

    return null;
}

function normalizarProtecaoSnapshot(valor) {
    if (
        valor === true
        || valor === 1
        || valor === '1'
        || String(valor || '')
            .trim()
            .toLowerCase() === 'true'
    ) {
        return true;
    }

    if (
        valor === false
        || valor === 0
        || valor === '0'
        || String(valor || '')
            .trim()
            .toLowerCase() === 'false'
    ) {
        return false;
    }

    return null;
}

function normalizarMultiplicadorEmpate(valor) {
    const texto =
        String(valor || '')
            .trim();

    return texto || '';
}

function numeroMonetarioConhecido(valor) {
    const numero =
        Number(valor);

    return (
        Number.isFinite(numero)
        && numero > 0
    )
        ? numero
        : null;
}

function arredondarFinanceiro(valor) {
    return Math.round(
        (Number(valor) + Number.EPSILON) * 100
    ) / 100;
}

function impactoPrincipalTieSemProtecao(
    valorPrincipal
) {
    const principal =
        numeroMonetarioConhecido(
            valorPrincipal
        );

    if (principal === null) {
        return Object.freeze({
            conhecido: false,
            regra: 'RETORNO_90_RETENCAO_10',
            percentual_retorno: 90,
            percentual_retencao: 10,
            base_principal: null,
            valor_retornado: null,
            valor_retido: null,
            pnl_principal: null
        });
    }

    const retornado =
        arredondarFinanceiro(
            principal
            * RETORNO_PRINCIPAL_TIE
        );

    const retido =
        arredondarFinanceiro(
            principal
            * RETENCAO_PRINCIPAL_TIE
        );

    return Object.freeze({
        conhecido: true,
        regra: 'RETORNO_90_RETENCAO_10',
        percentual_retorno: 90,
        percentual_retencao: 10,

        base_principal:
            arredondarFinanceiro(
                principal
            ),

        valor_retornado:
            retornado,

        valor_retido:
            retido,

        pnl_principal:
            -retido
    });
}

function classificarTieObservado({
    resultado,
    nivel,
    multiplicador,
    proteger_empate_snapshot,
    valor_principal
} = {}) {
    if (
        String(resultado || '')
            .trim()
            .toUpperCase() !== 'TIE'
    ) {
        return Object.freeze({
            observado: false,
            motivo: 'RESULTADO_NAO_TIE'
        });
    }

    const nivelNormalizado =
        normalizarNivelEmpate(
            nivel
        );

    if (!nivelNormalizado) {
        return Object.freeze({
            observado: false,
            motivo: 'NIVEL_TIE_INVALIDO'
        });
    }

    const protecao =
        normalizarProtecaoSnapshot(
            proteger_empate_snapshot
        );

    const multiplicadorNormalizado =
        normalizarMultiplicadorEmpate(
            multiplicador
        );

    if (protecao === null) {
        return Object.freeze({
            observado: true,
            classificacao:
                'PROTECAO_DESCONHECIDA',

            nivel:
                nivelNormalizado,

            multiplicador:
                multiplicadorNormalizado,

            proteger_empate_snapshot:
                null,

            impacto_sem_protecao:
                null
        });
    }

    if (protecao) {
        return Object.freeze({
            observado: true,
            classificacao:
                'PROTEGIDO',

            nivel:
                nivelNormalizado,

            multiplicador:
                multiplicadorNormalizado,

            proteger_empate_snapshot:
                true,

            impacto_sem_protecao:
                null
        });
    }

    return Object.freeze({
        observado: true,
        classificacao:
            'SEM_PROTECAO',

        nivel:
            nivelNormalizado,

        multiplicador:
            multiplicadorNormalizado,

        proteger_empate_snapshot:
            false,

        impacto_sem_protecao:
            impactoPrincipalTieSemProtecao(
                valor_principal
            )
    });
}

function criarDistribuicaoNiveis() {
    return {
        total: 0,
        direto: 0,
        gale1: 0,
        gale2: 0
    };
}

function criarMultiplicadoresPorNivel() {
    return {
        direto: {},
        gale1: {},
        gale2: {}
    };
}

function criarTelemetriaEmpatesVazia() {
    return {
        observados:
            criarDistribuicaoNiveis(),

        protegidos: {
            ...criarDistribuicaoNiveis(),

            multiplicadores:
                criarMultiplicadoresPorNivel()
        },

        sem_protecao:
            criarDistribuicaoNiveis(),

        protecao_desconhecida:
            criarDistribuicaoNiveis(),

        impacto_sem_protecao: {
            eventos_com_base: 0,
            eventos_sem_base: 0,
            base_principal_total: 0,
            valor_retornado_total: 0,
            valor_retido_total: 0,
            pnl_principal_total: 0
        }
    };
}

function incrementarNivel(
    destino,
    nivel
) {
    destino.total++;
    destino[nivel]++;
}

function agregarTieObservado(
    telemetria,
    evento
) {
    const destino =
        telemetria
        && typeof telemetria === 'object'
            ? telemetria
            : criarTelemetriaEmpatesVazia();

    const classificado =
        evento
        && evento.observado !== undefined
            ? evento
            : classificarTieObservado(
                evento
            );

    if (!classificado.observado) {
        return destino;
    }

    const nivel =
        classificado.nivel;

    if (!NIVEIS.includes(nivel)) {
        return destino;
    }

    incrementarNivel(
        destino.observados,
        nivel
    );

    if (
        classificado.classificacao
        === 'PROTEGIDO'
    ) {
        incrementarNivel(
            destino.protegidos,
            nivel
        );

        const multiplicador =
            String(
                classificado.multiplicador
                || ''
            ).trim();

        if (multiplicador) {
            if (
                !destino
                    .protegidos
                    .multiplicadores[nivel][
                        multiplicador
                    ]
            ) {
                destino
                    .protegidos
                    .multiplicadores[nivel][
                        multiplicador
                    ] = 0;
            }

            destino
                .protegidos
                .multiplicadores[nivel][
                    multiplicador
                ]++;
        }

        return destino;
    }

    if (
        classificado.classificacao
        === 'SEM_PROTECAO'
    ) {
        incrementarNivel(
            destino.sem_protecao,
            nivel
        );

        const impacto =
            classificado
                .impacto_sem_protecao;

        if (
            impacto
            && impacto.conhecido
        ) {
            destino
                .impacto_sem_protecao
                .eventos_com_base++;

            destino
                .impacto_sem_protecao
                .base_principal_total =
                arredondarFinanceiro(
                    destino
                        .impacto_sem_protecao
                        .base_principal_total
                    + impacto.base_principal
                );

            destino
                .impacto_sem_protecao
                .valor_retornado_total =
                arredondarFinanceiro(
                    destino
                        .impacto_sem_protecao
                        .valor_retornado_total
                    + impacto.valor_retornado
                );

            destino
                .impacto_sem_protecao
                .valor_retido_total =
                arredondarFinanceiro(
                    destino
                        .impacto_sem_protecao
                        .valor_retido_total
                    + impacto.valor_retido
                );

            destino
                .impacto_sem_protecao
                .pnl_principal_total =
                arredondarFinanceiro(
                    destino
                        .impacto_sem_protecao
                        .pnl_principal_total
                    + impacto.pnl_principal
                );
        }
        else {
            destino
                .impacto_sem_protecao
                .eventos_sem_base++;
        }

        return destino;
    }

    incrementarNivel(
        destino.protecao_desconhecida,
        nivel
    );

    return destino;
}

function agregarListaTies(
    eventos
) {
    const telemetria =
        criarTelemetriaEmpatesVazia();

    for (
        const evento
        of (
            Array.isArray(eventos)
                ? eventos
                : []
        )
    ) {
        agregarTieObservado(
            telemetria,
            evento
        );
    }

    return telemetria;
}


function timestampLinhaTie(valor) {
    if (valor instanceof Date) {
        const ms = valor.getTime();
        return Number.isFinite(ms) ? ms : null;
    }

    const numero = Number(valor);
    if (Number.isFinite(numero) && numero > 0) {
        return numero < 100000000000 ? numero * 1000 : numero;
    }

    const parsed = Date.parse(String(valor || ''));
    return Number.isFinite(parsed) ? parsed : null;
}

function limitesPeriodosTie(agoraMs = Date.now()) {
    const agora = new Date(agoraMs);

    if (!Number.isFinite(agoraMs) || Number.isNaN(agora.getTime())) {
        return limitesPeriodosTie(Date.now());
    }

    const inicioHoje = new Date(
        agora.getFullYear(),
        agora.getMonth(),
        agora.getDate()
    ).getTime();

    const inicioSemana = new Date(
        agora.getFullYear(),
        agora.getMonth(),
        agora.getDate() - agora.getDay()
    ).getTime();

    const inicioMes = new Date(
        agora.getFullYear(),
        agora.getMonth(),
        1
    ).getTime();

    return Object.freeze({
        '24h': agoraMs - (24 * 60 * 60 * 1000),
        hoje: inicioHoje,
        semana: inicioSemana,
        mes: inicioMes
    });
}

function periodosDaLinhaTie(linha, agoraMs = Date.now()) {
    const periodos = ['geral'];

    const ts = timestampLinhaTie(
        linha?.data_hora
        ?? linha?.timestamp_ms
        ?? linha?.timestamp
    );

    if (!Number.isFinite(ts) || ts <= 0) {
        return periodos;
    }

    const limites = limitesPeriodosTie(agoraMs);

    if (ts >= limites['24h']) periodos.push('24h');
    if (ts >= limites.hoje) periodos.push('hoje');
    if (ts >= limites.semana) periodos.push('semana');
    if (ts >= limites.mes) periodos.push('mes');

    return periodos;
}

function criarTelemetriaTiePorPeriodosVazia() {
    return {
        '24h': criarTelemetriaEmpatesVazia(),
        hoje: criarTelemetriaEmpatesVazia(),
        semana: criarTelemetriaEmpatesVazia(),
        mes: criarTelemetriaEmpatesVazia(),
        geral: criarTelemetriaEmpatesVazia()
    };
}

function eventoTieDaLinhaPersistida(linha) {
    const nivel = normalizarNivelEmpate(linha?.nivel);

    if (!nivel) {
        return Object.freeze({
            observado: false,
            motivo: 'NIVEL_INVALIDO'
        });
    }

    const snapshot = normalizarProtecaoSnapshot(
        linha?.proteger_empate_snapshot
    );

    let classificacao = 'PROTECAO_DESCONHECIDA';

    if (snapshot === true) classificacao = 'PROTEGIDO';
    else if (snapshot === false) classificacao = 'SEM_PROTECAO';

    return Object.freeze({
        observado: true,
        nivel,
        multiplicador: normalizarMultiplicadorEmpate(linha?.multiplicador),
        proteger_empate_snapshot: snapshot,
        classificacao,
        impacto_sem_protecao: impactoPrincipalTieSemProtecao(linha?.valor_principal)
    });
}

function agregarLinhasTiePorPeriodo(linhas, agoraMs = Date.now()) {
    const resultado = criarTelemetriaTiePorPeriodosVazia();

    if (!Array.isArray(linhas) || linhas.length === 0) {
        return resultado;
    }

    for (const linha of linhas) {
        const evento = eventoTieDaLinhaPersistida(linha);

        if (!evento.observado) continue;

        const periodos = periodosDaLinhaTie(linha, agoraMs);

        for (const periodo of periodos) {
            agregarTieObservado(resultado[periodo], evento);
        }
    }

    return resultado;
}
module.exports = {
    NIVEIS,
    RETORNO_PRINCIPAL_TIE,
    RETENCAO_PRINCIPAL_TIE,

    normalizarNivelEmpate,
    normalizarProtecaoSnapshot,
    normalizarMultiplicadorEmpate,

    impactoPrincipalTieSemProtecao,
    classificarTieObservado,

    criarTelemetriaEmpatesVazia,
    agregarTieObservado,
    agregarListaTies,
    timestampLinhaTie,
    limitesPeriodosTie,
    periodosDaLinhaTie,
    criarTelemetriaTiePorPeriodosVazia,
    eventoTieDaLinhaPersistida,
    agregarLinhasTiePorPeriodo
};
