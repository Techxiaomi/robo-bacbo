'use strict';

// MC22-A — contrato de identidade de mesa.
// Esta primeira etapa não altera o runtime atual: apenas define uma identidade
// canônica e fail-closed para a mesa já existente, preparando a migração multi-mesa.

const TIPO_JOGO_BACBO = 'BACBO';
const MESA_PADRAO_CODIGO = 'BACBO_INT';

const MESAS_CONHECIDAS = Object.freeze({
    [MESA_PADRAO_CODIGO]: Object.freeze({
        codigo: MESA_PADRAO_CODIGO,
        nome: 'Bac Bo Live Internacional',
        tipo_jogo: TIPO_JOGO_BACBO
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

function mesaPadrao() {
    return MESAS_CONHECIDAS[MESA_PADRAO_CODIGO];
}

module.exports = {
    TIPO_JOGO_BACBO,
    MESA_PADRAO_CODIGO,
    MESAS_CONHECIDAS,
    normalizarCodigoMesa,
    resolverMesaConhecida,
    mesaPadrao
};
