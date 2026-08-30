'use strict';

// MC22-A — contrato de identidade de mesa.
// Esta primeira etapa não altera o runtime atual: apenas define uma identidade
// canônica e fail-closed para a mesa já existente, preparando a migração multi-mesa.

const TIPO_JOGO_BACBO = 'BACBO';
const MESA_PADRAO_CODIGO = 'BACBO_INT';
const MESA_BR_CODIGO = 'BACBO_BR';

const TIPMINER_ROUND_ID_INT_CONHECIDO =
    'cc71e81d-8b56-4868-91c7-7224be543dce';

const TIPMINER_ROUND_ID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MESAS_CONHECIDAS = Object.freeze({
    [MESA_PADRAO_CODIGO]: Object.freeze({
        codigo: MESA_PADRAO_CODIGO,
        nome: 'Bac Bo Live Internacional',
        tipo_jogo: TIPO_JOGO_BACBO,
        runtime_habilitado: true,
        ativo_persistido: true
    }),

    [MESA_BR_CODIGO]: Object.freeze({
        codigo: MESA_BR_CODIGO,
        nome: 'Bac Bo Brasil',
        tipo_jogo: TIPO_JOGO_BACBO,
        runtime_habilitado: false,
        runtime_ativacao_explicita: true,
        ativo_persistido: false
    })
});

function normalizarCodigoMesa(valor) {
    return String(valor ?? '').trim().toUpperCase();
}

function resolverMesaConhecida(valor = MESA_PADRAO_CODIGO) {
    const codigo = normalizarCodigoMesa(valor || MESA_PADRAO_CODIGO);
    const mesa = MESAS_CONHECIDAS[codigo];
    if (!mesa) {
        const erro = new Error(`Mesa não suportada: ${codigo || '<vazia>'}`);
        erro.code = 'MESA_NAO_SUPORTADA';
        throw erro;
    }
    return mesa;
}

function criarErroMesaRuntime(
    mesa,
    code,
    mensagem
) {
    const codigo = normalizarCodigoMesa(
        mesa?.codigo
    );

    const erro = new Error(
        `${mensagem}: ${codigo || '<vazia>'}`
    );

    erro.code = code;

    return erro;
}

function runtimeAtivacaoExplicitaSolicitada(
    env = process.env
) {
    return (
        String(
            env?.BACBO_MESA_RUNTIME_ENABLED
            ?? ''
        ).trim()
        === '1'
    );
}

function validarRoundTipMinerRuntime(
    mesa,
    env = process.env
) {
    const roundId = String(
        env?.TIPMINER_BACBO_ROUND_ID
        ?? ''
    ).trim();

    if (!roundId) {
        throw criarErroMesaRuntime(
            mesa,
            'MESA_RUNTIME_FONTE_AUSENTE',
            'TIPMINER_BACBO_ROUND_ID obrigatorio para runtime explicito'
        );
    }

    if (
        !TIPMINER_ROUND_ID_PATTERN.test(
            roundId
        )
    ) {
        throw criarErroMesaRuntime(
            mesa,
            'MESA_RUNTIME_FONTE_INVALIDA',
            'TIPMINER_BACBO_ROUND_ID invalido para runtime'
        );
    }

    if (
        normalizarCodigoMesa(mesa?.codigo)
            !== MESA_PADRAO_CODIGO
        && roundId.toLowerCase()
            === TIPMINER_ROUND_ID_INT_CONHECIDO
                .toLowerCase()
    ) {
        throw criarErroMesaRuntime(
            mesa,
            'MESA_RUNTIME_FONTE_CRUZADA',
            'Mesa nao padrao nao pode reutilizar round TipMiner da INT'
        );
    }

    return roundId;
}

function afirmarMesaRuntimeHabilitada(
    mesa,
    env = process.env
) {
    if (!mesa) {
        throw criarErroMesaRuntime(
            mesa,
            'MESA_RUNTIME_NAO_HABILITADA',
            'Mesa nao habilitada no runtime'
        );
    }

    if (
        mesa.runtime_habilitado === true
    ) {
        return mesa;
    }

    if (
        mesa.runtime_ativacao_explicita
            === true
    ) {
        if (
            !runtimeAtivacaoExplicitaSolicitada(
                env
            )
        ) {
            throw criarErroMesaRuntime(
                mesa,
                'MESA_RUNTIME_ATIVACAO_EXPLICITA_AUSENTE',
                'Runtime da mesa exige BACBO_MESA_RUNTIME_ENABLED=1'
            );
        }

        validarRoundTipMinerRuntime(
            mesa,
            env
        );

        return mesa;
    }

    throw criarErroMesaRuntime(
        mesa,
        'MESA_RUNTIME_NAO_HABILITADA',
        'Mesa conhecida, mas nao habilitada no runtime'
    );
}

function codigoMesaConfigurada() {
    const codigo = normalizarCodigoMesa(
        process.env.BACBO_MESA_CODIGO
        || MESA_PADRAO_CODIGO
    );

    return codigo || MESA_PADRAO_CODIGO;
}

function mesaConfigurada() {
    return afirmarMesaRuntimeHabilitada(
        resolverMesaConhecida(
            codigoMesaConfigurada()
        )
    );
}

function mesaPadrao() {
    return MESAS_CONHECIDAS[MESA_PADRAO_CODIGO];
}

module.exports = {
    TIPO_JOGO_BACBO,
    MESA_PADRAO_CODIGO,
    MESA_BR_CODIGO,
    TIPMINER_ROUND_ID_INT_CONHECIDO,
    MESAS_CONHECIDAS,
    normalizarCodigoMesa,
    resolverMesaConhecida,
    runtimeAtivacaoExplicitaSolicitada,
    validarRoundTipMinerRuntime,
    afirmarMesaRuntimeHabilitada,
    codigoMesaConfigurada,
    mesaConfigurada,
    mesaPadrao
};
