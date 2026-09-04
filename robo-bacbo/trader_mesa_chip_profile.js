'use strict';

const {
    MESA_PADRAO_CODIGO,
    MESA_BR_CODIGO,
    normalizarCodigoMesa
} = require('./mesa_context');

const PERFIS_FICHAS_CENTAVOS = Object.freeze({
    [MESA_PADRAO_CODIGO]: Object.freeze([
        500000,
        250000,
        50000,
        12500,
        2500,
        1000,
        500
    ]),
    [MESA_BR_CODIGO]: Object.freeze([
        250000,
        50000,
        12500,
        2500,
        500,
        250
    ])
});

function erroPerfilFichas(mesaCodigo) {
    const erro = new Error(
        `Perfil de fichas nao homologado para mesa ${
            normalizarCodigoMesa(mesaCodigo) || '<vazia>'
        }`
    );
    erro.code = 'MESA_FICHAS_NAO_HOMOLOGADA';
    return erro;
}

function obterPerfilFichasCentavos(mesaCodigo) {
    const codigo = normalizarCodigoMesa(mesaCodigo);
    const perfil = PERFIS_FICHAS_CENTAVOS[codigo];

    if (!perfil) {
        throw erroPerfilFichas(codigo);
    }

    return [...perfil];
}

function obterPerfilFichasReais(mesaCodigo) {
    return obterPerfilFichasCentavos(mesaCodigo)
        .map(valor => valor / 100);
}

function reaisParaCentavos(valor) {
    if (typeof valor === 'boolean' || valor === null || valor === '') {
        return null;
    }

    const numero = Number(valor);
    if (!Number.isFinite(numero) || numero <= 0) {
        return null;
    }

    const centavos = Math.round(numero * 100);

    if (
        !Number.isSafeInteger(centavos)
        || centavos <= 0
        || Math.abs((numero * 100) - centavos) > 1e-7
    ) {
        return null;
    }

    return centavos;
}

function decomporValorEmFichas(mesaCodigo, valorReais) {
    const valorCentavos = reaisParaCentavos(valorReais);

    if (valorCentavos === null) {
        return {
            representavel: false,
            motivo: 'VALOR_INVALIDO',
            valor_centavos: null,
            cliques_necessarios: []
        };
    }

    const perfil = obterPerfilFichasCentavos(mesaCodigo);
    let restante = valorCentavos;
    const cliques = [];

    for (const fichaCentavos of perfil) {
        const quantidade = Math.floor(restante / fichaCentavos);

        if (quantidade > 0) {
            cliques.push({
                ficha_centavos: fichaCentavos,
                ficha: fichaCentavos / 100,
                quantidade
            });
            restante -= quantidade * fichaCentavos;
        }
    }

    if (restante !== 0) {
        return {
            representavel: false,
            motivo: 'VALOR_NAO_REPRESENTAVEL',
            valor_centavos: valorCentavos,
            restante_centavos: restante,
            cliques_necessarios: []
        };
    }

    return {
        representavel: true,
        motivo: null,
        valor_centavos: valorCentavos,
        cliques_necessarios: cliques
    };
}

module.exports = {
    PERFIS_FICHAS_CENTAVOS,
    obterPerfilFichasCentavos,
    obterPerfilFichasReais,
    reaisParaCentavos,
    decomporValorEmFichas
};
