'use strict';

const path = require('node:path');
const {
    MESA_PADRAO_CODIGO,
    normalizarCodigoMesa
} = require('./mesa_context');

const REGEX_CODIGO_MESA_OPERACIONAL =
    /^[A-Z0-9_]+$/;

function codigoMesaOperacional(
    env = process.env
) {
    const codigo = normalizarCodigoMesa(
        env?.BACBO_MESA_CODIGO
        || MESA_PADRAO_CODIGO
    );

    if (
        !codigo
        || !REGEX_CODIGO_MESA_OPERACIONAL.test(
            codigo
        )
    ) {
        const erro = new Error(
            `Codigo operacional de mesa invalido: `
            + `${codigo || '<vazio>'}`
        );

        erro.code =
            'MESA_OPERACIONAL_CODIGO_INVALIDO';

        throw erro;
    }

    return codigo;
}

function nomeArquivoEscopadoPorMesa(
    nomeBruto,
    env = process.env
) {
    const nome = path.basename(
        String(nomeBruto || '').trim()
    );

    if (!nome) {
        const erro = new Error(
            'Nome de arquivo operacional ausente'
        );

        erro.code =
            'MESA_OPERACIONAL_ARQUIVO_INVALIDO';

        throw erro;
    }

    const codigo =
        codigoMesaOperacional(env);

    // Compatibilidade total com a instalacao atual.
    if (codigo === MESA_PADRAO_CODIGO) {
        return nome;
    }

    const extensao = path.extname(nome);
    const base = extensao
        ? nome.slice(0, -extensao.length)
        : nome;

    const sufixo = `.${codigo}`;

    // Idempotencia para override que ja contenha
    // explicitamente o codigo da mesa.
    if (
        base.toUpperCase().endsWith(
            sufixo.toUpperCase()
        )
    ) {
        return nome;
    }

    return `${base}${sufixo}${extensao}`;
}

function nomeCookieEscopadoPorMesa(
    nomeBase,
    env = process.env
) {
    const base =
        String(nomeBase || '').trim();

    if (
        !base
        || !/^[A-Za-z0-9_-]+$/.test(base)
    ) {
        const erro = new Error(
            'Nome base de cookie operacional invalido'
        );

        erro.code =
            'MESA_OPERACIONAL_COOKIE_INVALIDO';

        throw erro;
    }

    const codigo =
        codigoMesaOperacional(env);

    // Preserva sessoes/cookies da mesa atual.
    if (codigo === MESA_PADRAO_CODIGO) {
        return base;
    }

    const sufixo = `_${codigo}`;

    if (
        base.toUpperCase().endsWith(
            sufixo.toUpperCase()
        )
    ) {
        return base;
    }

    return `${base}${sufixo}`;
}

module.exports = {
    REGEX_CODIGO_MESA_OPERACIONAL,
    codigoMesaOperacional,
    nomeArquivoEscopadoPorMesa,
    nomeCookieEscopadoPorMesa
};
