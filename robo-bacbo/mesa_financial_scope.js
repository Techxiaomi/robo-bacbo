'use strict';

const {
    MESA_PADRAO_CODIGO,
    normalizarCodigoMesa
} = require('./mesa_context');

const {
    obterMesaRuntime
} = require('./mesa_runtime_context');

function mesaFinanceiraPermitida(
    codigo
) {
    return (
        normalizarCodigoMesa(codigo)
        === MESA_PADRAO_CODIGO
    );
}

function criarErroMesaFinanceira(
    codigo,
    operacao
) {
    const erro = new Error(
        `Operacao financeira ${String(operacao || 'desconhecida')} `
        + `nao autorizada para mesa `
        + `${normalizarCodigoMesa(codigo) || '<vazia>'}`
    );

    erro.code =
        'MESA_FINANCEIRA_NAO_AUTORIZADA';

    return erro;
}

function afirmarMesaFinanceiraAutorizada(
    operacao
) {
    const mesa = obterMesaRuntime();

    if (
        !mesa
        || !mesaFinanceiraPermitida(
            mesa.codigo
        )
    ) {
        throw criarErroMesaFinanceira(
            mesa?.codigo,
            operacao
        );
    }

    return mesa;
}

module.exports = {
    mesaFinanceiraPermitida,
    criarErroMesaFinanceira,
    afirmarMesaFinanceiraAutorizada
};
