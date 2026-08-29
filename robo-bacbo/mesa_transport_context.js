'use strict';

const { mesaPadrao } = require('./mesa_context');

let instalado = false;
let fetchAnterior = null;

function alvoReceberSinal(input) {
    const bruto = typeof input === 'string' || input instanceof URL
        ? String(input)
        : String(input?.url || '');
    try {
        const url = new URL(bruto);
        return url.pathname === '/receber-sinal';
    } catch (_) {
        return false;
    }
}

function metodoPost(input, init) {
    return String(init?.method || input?.method || 'GET').trim().toUpperCase() === 'POST';
}

function lerCorpoJson(init) {
    if (!init || typeof init.body !== 'string') return null;
    try {
        const parsed = JSON.parse(init.body);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (_) {
        return null;
    }
}

function normalizar(valor) {
    return String(valor || '').trim().toUpperCase();
}

function anexarMesaCanonica(dados) {
    const mesa = mesaPadrao();
    const codigoRecebido = normalizar(dados.mesa_codigo);
    const jogoRecebido = normalizar(dados.tipo_jogo);

    if (codigoRecebido && codigoRecebido !== mesa.codigo) {
        const erro = new Error(
            `MC22-I: payload live pertence a ${codigoRecebido}, runtime atual=${mesa.codigo}`
        );
        erro.code = 'MESA_TRANSPORTE_INCOMPATIVEL';
        throw erro;
    }
    if (jogoRecebido && jogoRecebido !== mesa.tipo_jogo) {
        const erro = new Error(
            `MC22-I: tipo_jogo ${jogoRecebido} incompatível com ${mesa.tipo_jogo}`
        );
        erro.code = 'JOGO_TRANSPORTE_INCOMPATIVEL';
        throw erro;
    }

    return {
        ...dados,
        mesa_codigo: mesa.codigo,
        tipo_jogo: mesa.tipo_jogo
    };
}

function instalarMesaNoTransporteLive() {
    if (instalado) return true;
    if (typeof globalThis.fetch !== 'function') {
        throw new Error('MC22-I: runtime Node sem fetch nativo para contrato de mesa');
    }

    fetchAnterior = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async function fetchComMesaCanonica(input, init = {}) {
        if (!alvoReceberSinal(input) || !metodoPost(input, init)) {
            return fetchAnterior(input, init);
        }

        const dados = lerCorpoJson(init);
        if (!dados) {
            const erro = new Error('MC22-I: /receber-sinal sem payload JSON identificável');
            erro.code = 'MESA_TRANSPORTE_PAYLOAD_INVALIDO';
            throw erro;
        }

        const identificado = anexarMesaCanonica(dados);
        return fetchAnterior(input, {
            ...init,
            body: JSON.stringify(identificado)
        });
    };

    instalado = true;
    const mesa = mesaPadrao();
    console.log(`🧭 MC22-I | Transporte live identificado como ${mesa.codigo} (${mesa.tipo_jogo}).`);
    return true;
}

module.exports = {
    anexarMesaCanonica,
    instalarMesaNoTransporteLive
};
