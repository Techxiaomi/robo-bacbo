'use strict';

const { mesaPadrao } = require('./mesa_context');
const { obterMesaRuntime } = require('./mesa_runtime_context');

let instalado = false;
let fetchAnterior = null;
let contratoRuntimeConfirmado = false;

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

function mesaCanonicaRuntime() {
    const declarada = mesaPadrao();
    const runtime = obterMesaRuntime();

    if (runtime.codigo !== declarada.codigo || runtime.tipo_jogo !== declarada.tipo_jogo) {
        const erro = new Error(
            `MC22-J: identidade do runtime ${runtime.codigo}/${runtime.tipo_jogo} `
            + `diverge do contrato ${declarada.codigo}/${declarada.tipo_jogo}`
        );
        erro.code = 'MESA_RUNTIME_CONTRATO_DIVERGENTE';
        throw erro;
    }

    return runtime;
}

function validarMesaIdRecebida(valor, mesaId) {
    if (valor === undefined || valor === null || valor === '') return;
    const recebido = Number(valor);
    if (!Number.isInteger(recebido) || recebido <= 0 || recebido !== mesaId) {
        const erro = new Error(
            `MC22-J: mesa_id ${String(valor)} incompatível com runtime mesa_id=${mesaId}`
        );
        erro.code = 'MESA_ID_TRANSPORTE_INCOMPATIVEL';
        throw erro;
    }
}

function anexarMesaCanonica(dados) {
    const mesa = mesaCanonicaRuntime();
    const codigoRecebido = normalizar(dados.mesa_codigo);
    const jogoRecebido = normalizar(dados.tipo_jogo);

    validarMesaIdRecebida(dados.mesa_id, mesa.id);

    if (codigoRecebido && codigoRecebido !== mesa.codigo) {
        const erro = new Error(
            `MC22-J: payload live pertence a ${codigoRecebido}, runtime atual=${mesa.codigo}`
        );
        erro.code = 'MESA_TRANSPORTE_INCOMPATIVEL';
        throw erro;
    }
    if (jogoRecebido && jogoRecebido !== mesa.tipo_jogo) {
        const erro = new Error(
            `MC22-J: tipo_jogo ${jogoRecebido} incompatível com ${mesa.tipo_jogo}`
        );
        erro.code = 'JOGO_TRANSPORTE_INCOMPATIVEL';
        throw erro;
    }

    return {
        ...dados,
        mesa_id: mesa.id,
        mesa_codigo: mesa.codigo,
        tipo_jogo: mesa.tipo_jogo
    };
}

function confirmarContratoMesaTransporteRuntime() {
    const mesa = mesaCanonicaRuntime();
    if (!contratoRuntimeConfirmado) {
        console.log(
            `🧭 MC22-J | Contrato live validado contra runtime ${mesa.codigo} `
            + `(${mesa.tipo_jogo}) | mesa_id=${mesa.id}.`
        );
        contratoRuntimeConfirmado = true;
    }
    return mesa;
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
            const erro = new Error('MC22-J: /receber-sinal sem payload JSON identificável');
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
    confirmarContratoMesaTransporteRuntime,
    instalarMesaNoTransporteLive
};
