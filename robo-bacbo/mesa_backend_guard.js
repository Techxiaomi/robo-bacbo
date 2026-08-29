'use strict';

const crypto = require('crypto');
const express = require('express');
const { obterMesaRuntime } = require('./mesa_runtime_context');

let instalado = false;
let postOriginal = null;

function objeto(valor) {
    return valor && typeof valor === 'object' && !Array.isArray(valor) ? valor : null;
}

function normalizar(valor) {
    return String(valor ?? '').trim().toUpperCase();
}

function tokenInternoConfere(req) {
    const esperado = String(process.env.INTERNAL_API_TOKEN || '');
    const recebido = String(req?.get?.('X-Internal-Token') || '');
    if (!esperado || !recebido) return false;

    const a = Buffer.from(esperado);
    const b = Buffer.from(recebido);
    if (a.length !== b.length) return false;
    try {
        return crypto.timingSafeEqual(a, b);
    } catch (_) {
        return false;
    }
}

function payloadRepresentaResultado(dados) {
    const body = objeto(dados) || {};
    return [body.vencedor, body.resultado, body.winner]
        .some(valor => String(valor ?? '').trim() !== '');
}

function validarMesaResultado(dados) {
    const body = objeto(dados) || {};
    const mesa = obterMesaRuntime();
    const mesaId = Number(body.mesa_id);
    const mesaCodigo = normalizar(body.mesa_codigo);
    const tipoJogo = normalizar(body.tipo_jogo);

    if (!Number.isInteger(mesaId) || mesaId <= 0 || !mesaCodigo || !tipoJogo) {
        return {
            ok: false,
            status: 400,
            codigo: 'MESA_RESULTADO_AUSENTE',
            detalhe: 'resultado live sem identidade completa de mesa'
        };
    }

    if (
        mesaId !== mesa.id
        || mesaCodigo !== mesa.codigo
        || tipoJogo !== mesa.tipo_jogo
    ) {
        return {
            ok: false,
            status: 409,
            codigo: 'MESA_RESULTADO_INCOMPATIVEL',
            detalhe: `recebida=${mesaCodigo}/${tipoJogo}/id=${mesaId}; runtime=${mesa.codigo}/${mesa.tipo_jogo}/id=${mesa.id}`
        };
    }

    return { ok: true, mesa };
}

function guardarMesaReceberSinal(req, res, next) {
    // Preserva a semantica de autenticacao existente: requisicoes sem token valido
    // seguem para o handler original, que continua responsavel pelo HTTP 401.
    if (!tokenInternoConfere(req)) return next();

    const dados = objeto(req.body) || {};
    // /receber-sinal tambem recebe sincronizacao isolada de saldo. MC22-K protege
    // somente mensagens que realmente carregam resultado de rodada.
    if (!payloadRepresentaResultado(dados)) return next();

    const validacao = validarMesaResultado(dados);
    if (!validacao.ok) {
        console.error(`🚫 MC22-K | Resultado rejeitado antes do motor: ${validacao.detalhe}.`);
        return res.status(validacao.status).json({
            recebido: false,
            erro: validacao.codigo
        });
    }

    req.mesaRuntime = validacao.mesa;
    return next();
}

function instalarGuardaMesaBackend() {
    if (instalado) return true;

    const proto = express.application;
    if (!proto || typeof proto.post !== 'function') {
        throw new Error('MC22-K: Express sem application.post para instalar guarda de mesa');
    }

    postOriginal = proto.post;
    proto.post = function postComGuardaMesa(path, ...handlers) {
        if (path === '/receber-sinal') {
            return postOriginal.call(this, path, guardarMesaReceberSinal, ...handlers);
        }
        return postOriginal.call(this, path, ...handlers);
    };

    instalado = true;
    const mesa = obterMesaRuntime();
    console.log(`🧭 MC22-K | Receptor live protegido para ${mesa.codigo} (${mesa.tipo_jogo}) | mesa_id=${mesa.id}.`);
    return true;
}

module.exports = {
    payloadRepresentaResultado,
    validarMesaResultado,
    guardarMesaReceberSinal,
    instalarGuardaMesaBackend
};
