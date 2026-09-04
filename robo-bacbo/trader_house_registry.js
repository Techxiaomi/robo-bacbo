'use strict';

const CASAS_HOMOLOGADAS = Object.freeze({
    APOSTASONLINE: Object.freeze({
        codigo: 'APOSTASONLINE',
        nome: 'Apostasonline',
        adapter: 'APOSTASONLINE'
    }),
    BRASIL_DA_SORTE: Object.freeze({
        codigo: 'BRASIL_DA_SORTE',
        nome: 'Brasil da Sorte',
        adapter: 'BRASIL_DA_SORTE'
    })
});

function normalizarCodigoCasa(valor) {
    return String(valor ?? '').trim().toUpperCase();
}

function resolverCasaHomologada(valor) {
    const codigo = normalizarCodigoCasa(valor);
    const casa = CASAS_HOMOLOGADAS[codigo];

    if (!casa) {
        const erro = new Error(
            `Casa de apostas nao homologada: ${codigo || '<vazia>'}`
        );
        erro.code = 'CASA_APOSTAS_NAO_HOMOLOGADA';
        throw erro;
    }

    return casa;
}

function listarCasasHomologadas() {
    return Object.values(CASAS_HOMOLOGADAS).map(casa => ({
        codigo: casa.codigo,
        nome: casa.nome
    }));
}

module.exports = {
    CASAS_HOMOLOGADAS,
    normalizarCodigoCasa,
    resolverCasaHomologada,
    listarCasasHomologadas
};
