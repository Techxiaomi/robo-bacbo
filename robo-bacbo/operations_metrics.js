"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { performance } = require("node:perf_hooks");
const {
    nomeArquivoEscopadoPorMesa
} = require("./mesa_operational_scope");

let instalado = false;
let intervaloAtivo = null;
let configAtiva = null;
let ultimoAvisoFalhaEm = 0;
let serverEmitOriginal = null;
let serverEmitInstrumentado = null;
let fetchOriginal = null;
let fetchInstrumentado = null;

const STATUS_KEYS = ["2xx", "3xx", "4xx", "5xx", "outros"];

function novoContadorOperacao() {
    return {
        total: 0,
        sucesso: 0,
        falha: 0,
        status: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, outros: 0 },
        latencias_ms: []
    };
}

function novoEstado(iniciadoEm = Date.now()) {
    return {
        iniciadoEm: Number(iniciadoEm) || Date.now(),
        http: {
            total: 0,
            em_andamento: 0,
            status: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, outros: 0 },
            latencias_ms: [],
            rotas: {}
        },
        outbound: {
            executor: novoContadorOperacao(),
            telegram: novoContadorOperacao(),
            other: novoContadorOperacao()
        },
        operacional: {
            ultimo_resultado_em: null,
            ultimo_saldo_em: null
        },
        sinks: {
            falhas_persistencia: 0,
            ultima_falha_em: null
        }
    };
}

let estado = novoEstado();

function booleanoConfig(valor, padrao = true) {
    if (valor === undefined || valor === null || String(valor).trim() === "") return padrao;
    const normalizado = String(valor).trim().toLowerCase();
    if (["1", "true", "yes", "on", "sim"].includes(normalizado)) return true;
    if (["0", "false", "no", "off", "nao", "não"].includes(normalizado)) return false;
    return padrao;
}

function inteiroConfig(valor, padrao, minimo, maximo) {
    const numero = Number(valor);
    if (!Number.isFinite(numero)) return padrao;
    const inteiro = Math.floor(numero);
    return Math.min(maximo, Math.max(minimo, inteiro));
}

function configMetricasOperacionais(opcoes = {}) {
    const env = opcoes.env || process.env;
    const baseDir = opcoes.baseDir || process.cwd();
    const dirInformado = String(
        env.OPERATIONS_METRICS_DIR || env.METRICS_DIR || env.LOG_DIR || ""
    ).trim();
    const metricsDir = dirInformado
        ? (path.isAbsolute(dirInformado) ? dirInformado : path.resolve(baseDir, dirInformado))
        : path.join(baseDir, "logs");
    const nomeBruto = String(
        env.OPERATIONS_METRICS_FILE_NAME || "backend.operations.json"
    ).trim() || "backend.operations.json";

    return {
        enabled: booleanoConfig(env.OPERATIONS_METRICS_ENABLED, true),
        filePath: path.join(
            metricsDir,
            nomeArquivoEscopadoPorMesa(
                nomeBruto,
                env
            )
        ),
        intervalMs: inteiroConfig(env.OPERATIONS_METRICS_INTERVAL_SECONDS, 15, 5, 300) * 1000,
        maxSamples: inteiroConfig(env.OPERATIONS_METRICS_MAX_SAMPLES, 2048, 128, 10000),
        maxRoutes: inteiroConfig(env.OPERATIONS_METRICS_MAX_ROUTES, 64, 16, 256),
        executorUrl: String(env.EXECUTOR_URL || "http://127.0.0.1:5000/apostar").trim()
    };
}

function isoDoAgora(agora = Date.now()) {
    const numero = Number(agora);
    return new Date(Number.isFinite(numero) ? numero : Date.now()).toISOString();
}

function classeStatus(status) {
    const numero = Number(status);
    if (!Number.isFinite(numero)) return "outros";
    if (numero >= 200 && numero < 300) return "2xx";
    if (numero >= 300 && numero < 400) return "3xx";
    if (numero >= 400 && numero < 500) return "4xx";
    if (numero >= 500 && numero < 600) return "5xx";
    return "outros";
}

function normalizarRota(urlBruta) {
    let pathname = "/";
    try {
        pathname = new URL(String(urlBruta || "/"), "http://localhost").pathname || "/";
    } catch (e) {
        pathname = String(urlBruta || "/").split("?")[0] || "/";
    }

    const segmentos = pathname.split("/").map(segmento => {
        if (!segmento) return segmento;
        if (/^\d+$/.test(segmento)) return ":id";
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(segmento)) {
            return ":id";
        }
        if (/^[0-9a-f]{24,}$/i.test(segmento)) return ":id";
        return segmento.length > 64 ? ":valor" : segmento;
    });

    const rota = segmentos.join("/") || "/";
    return rota.length > 160 ? rota.slice(0, 160) : rota;
}

function adicionarAmostra(lista, valor, maxSamples) {
    const numero = Number(valor);
    if (!Number.isFinite(numero) || numero < 0) return;
    lista.push(Number(numero.toFixed(3)));
    const limite = Math.max(1, Number(maxSamples) || 2048);
    if (lista.length > limite) lista.splice(0, lista.length - limite);
}

function percentilOrdenado(ordenados, percentil) {
    if (!Array.isArray(ordenados) || ordenados.length === 0) return 0;
    const p = Math.min(100, Math.max(0, Number(percentil) || 0));
    const indice = Math.max(0, Math.ceil((p / 100) * ordenados.length) - 1);
    return Number((ordenados[indice] || 0).toFixed(3));
}

function resumoLatencias(lista) {
    if (!Array.isArray(lista) || lista.length === 0) {
        return { amostras: 0, media: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    }

    const validos = lista.map(Number).filter(numero => Number.isFinite(numero) && numero >= 0);
    if (validos.length === 0) {
        return { amostras: 0, media: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    }

    const ordenados = [...validos].sort((a, b) => a - b);
    const soma = validos.reduce((acc, numero) => acc + numero, 0);
    return {
        amostras: validos.length,
        media: Number((soma / validos.length).toFixed(3)),
        p50: percentilOrdenado(ordenados, 50),
        p95: percentilOrdenado(ordenados, 95),
        p99: percentilOrdenado(ordenados, 99),
        max: Number(ordenados[ordenados.length - 1].toFixed(3))
    };
}

function contadorRota(method, rota, maxRoutes) {
    const metodo = String(method || "GET").toUpperCase();
    const rotaNormalizada = normalizarRota(rota);
    let chave = `${metodo} ${rotaNormalizada}`;

    if (!estado.http.rotas[chave] && Object.keys(estado.http.rotas).length >= maxRoutes) {
        chave = "__outras__";
    }

    if (!estado.http.rotas[chave]) {
        estado.http.rotas[chave] = {
            total: 0,
            status: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, outros: 0 },
            latencias_ms: []
        };
    }

    return estado.http.rotas[chave];
}

function registrarHttp(method, rota, status, duracaoMs, opcoes = {}) {
    const maxSamples = Number(opcoes.maxSamples || configAtiva?.maxSamples || 2048);
    const maxRoutes = Number(opcoes.maxRoutes || configAtiva?.maxRoutes || 64);
    const classe = classeStatus(status);

    estado.http.total += 1;
    estado.http.status[classe] += 1;
    adicionarAmostra(estado.http.latencias_ms, duracaoMs, maxSamples);

    const contador = contadorRota(method, rota, maxRoutes);
    contador.total += 1;
    contador.status[classe] += 1;
    adicionarAmostra(contador.latencias_ms, duracaoMs, maxSamples);
}

function classificarDestino(urlBruta, executorUrl = configAtiva?.executorUrl) {
    try {
        const url = new URL(String(urlBruta || ""));
        const executor = new URL(String(executorUrl || "http://127.0.0.1:5000/apostar"));
        if (url.origin === executor.origin && url.pathname === executor.pathname) return "executor";
        if (url.hostname.toLowerCase() === "api.telegram.org") return "telegram";
    } catch (e) {}
    return "other";
}

function registrarOutbound(categoria, status, duracaoMs, erro = false, opcoes = {}) {
    const nome = ["executor", "telegram", "other"].includes(categoria) ? categoria : "other";
    const contador = estado.outbound[nome];
    const maxSamples = Number(opcoes.maxSamples || configAtiva?.maxSamples || 2048);
    const classe = classeStatus(status);

    contador.total += 1;
    contador.status[classe] += 1;
    if (erro || classe === "4xx" || classe === "5xx" || classe === "outros") contador.falha += 1;
    else contador.sucesso += 1;
    adicionarAmostra(contador.latencias_ms, duracaoMs, maxSamples);
}

function registrarFreshnessReq(req, status, agora = Date.now()) {
    const numeroStatus = Number(status);
    if (!Number.isFinite(numeroStatus) || numeroStatus >= 400) return;
    if (normalizarRota(req && req.url) !== "/receber-sinal") return;

    const corpo = req && req.body && typeof req.body === "object" ? req.body : {};
    const temSaldo = corpo.saldo_atual !== undefined && corpo.saldo_atual !== null;
    const vencedor = String(corpo.vencedor || corpo.resultado || corpo.winner || "").trim();

    if (temSaldo) estado.operacional.ultimo_saldo_em = isoDoAgora(agora);
    if (vencedor) estado.operacional.ultimo_resultado_em = isoDoAgora(agora);
}

function idadeSegundos(iso, agoraMs) {
    if (!iso) return null;
    const timestamp = Date.parse(iso);
    if (!Number.isFinite(timestamp)) return null;
    return Number((Math.max(0, agoraMs - timestamp) / 1000).toFixed(3));
}

function snapshotContador(contador) {
    const status = {};
    for (const chave of STATUS_KEYS) status[chave] = Number(contador.status[chave]) || 0;
    return {
        total: Number(contador.total) || 0,
        sucesso: Number(contador.sucesso) || 0,
        falha: Number(contador.falha) || 0,
        status,
        latencia_ms: resumoLatencias(contador.latencias_ms)
    };
}

function snapshotMetricasOperacionais(opcoes = {}) {
    const agoraMs = Number.isFinite(Number(opcoes.agoraMs)) ? Number(opcoes.agoraMs) : Date.now();
    const rotas = {};

    for (const [chave, contador] of Object.entries(estado.http.rotas)) {
        rotas[chave] = {
            total: contador.total,
            status: { ...contador.status },
            latencia_ms: resumoLatencias(contador.latencias_ms)
        };
    }

    return {
        timestamp: isoDoAgora(agoraMs),
        pid: Number(process.pid),
        iniciado_em: new Date(estado.iniciadoEm).toISOString(),
        http: {
            total: estado.http.total,
            em_andamento: Math.max(0, estado.http.em_andamento),
            status: { ...estado.http.status },
            latencia_ms: resumoLatencias(estado.http.latencias_ms),
            rotas
        },
        outbound_http: {
            executor: snapshotContador(estado.outbound.executor),
            telegram: snapshotContador(estado.outbound.telegram),
            other: snapshotContador(estado.outbound.other)
        },
        freshness: {
            ultimo_resultado_em: estado.operacional.ultimo_resultado_em,
            idade_ultimo_resultado_seconds: idadeSegundos(estado.operacional.ultimo_resultado_em, agoraMs),
            ultimo_saldo_em: estado.operacional.ultimo_saldo_em,
            idade_ultimo_saldo_seconds: idadeSegundos(estado.operacional.ultimo_saldo_em, agoraMs)
        },
        sinks: { ...estado.sinks }
    };
}

function escreverJsonAtomico(filePath, payload, opcoes = {}) {
    const fsImpl = opcoes.fsImpl || fs;
    const dir = path.dirname(filePath);
    const temporario = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    let fd = null;

    fsImpl.mkdirSync(dir, { recursive: true });
    try {
        fd = fsImpl.openSync(temporario, "w");
        fsImpl.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
        if (typeof fsImpl.fsyncSync === "function") fsImpl.fsyncSync(fd);
        fsImpl.closeSync(fd);
        fd = null;
        fsImpl.renameSync(temporario, filePath);
    } catch (e) {
        if (fd !== null) {
            try { fsImpl.closeSync(fd); } catch (closeError) {}
        }
        try {
            if (fsImpl.existsSync(temporario)) fsImpl.unlinkSync(temporario);
        } catch (cleanupError) {}
        throw e;
    }
}

function urlDoFetch(input) {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    if (input && typeof input.url === "string") return input.url;
    return String(input || "");
}

function instalarHookHttp() {
    if (serverEmitInstrumentado) return;
    serverEmitOriginal = http.Server.prototype.emit;

    serverEmitInstrumentado = function(evento, ...args) {
        if (evento === "request" && args.length >= 2) {
            const req = args[0];
            const res = args[1];
            const inicio = performance.now();
            estado.http.em_andamento += 1;
            let finalizado = false;

            const finalizar = () => {
                if (finalizado) return;
                finalizado = true;
                estado.http.em_andamento = Math.max(0, estado.http.em_andamento - 1);
                const duracaoMs = Math.max(0, performance.now() - inicio);
                registrarHttp(req && req.method, req && req.url, res && res.statusCode, duracaoMs);
                registrarFreshnessReq(req, res && res.statusCode);
            };

            if (res && typeof res.once === "function") {
                res.once("finish", finalizar);
                res.once("close", finalizar);
            }
        }

        return serverEmitOriginal.call(this, evento, ...args);
    };

    http.Server.prototype.emit = serverEmitInstrumentado;
}

function instalarHookFetch() {
    if (fetchInstrumentado || typeof globalThis.fetch !== "function") return;
    fetchOriginal = globalThis.fetch;

    fetchInstrumentado = async function(input, init) {
        const url = urlDoFetch(input);
        const categoria = classificarDestino(url);
        const inicio = performance.now();

        try {
            const resposta = await fetchOriginal.call(this, input, init);
            registrarOutbound(categoria, resposta && resposta.status, Math.max(0, performance.now() - inicio), false);
            return resposta;
        } catch (e) {
            registrarOutbound(categoria, 0, Math.max(0, performance.now() - inicio), true);
            throw e;
        }
    };

    globalThis.fetch = fetchInstrumentado;
}

function persistirSnapshot() {
    const snapshot = snapshotMetricasOperacionais();
    escreverJsonAtomico(configAtiva.filePath, snapshot);
    return snapshot;
}

function instalarMetricasOperacionais(opcoes = {}) {
    if (instalado) {
        return {
            installed: true,
            reused: true,
            filePath: configAtiva && configAtiva.filePath
        };
    }

    const config = configMetricasOperacionais(opcoes);
    if (!config.enabled) return { installed: false, enabled: false };

    estado = novoEstado(Date.now());
    configAtiva = config;
    instalarHookHttp();
    instalarHookFetch();

    const gravar = () => {
        try {
            persistirSnapshot();
        } catch (e) {
            const agora = Date.now();
            estado.sinks.falhas_persistencia += 1;
            estado.sinks.ultima_falha_em = isoDoAgora(agora);
            if ((agora - ultimoAvisoFalhaEm) >= 30000) {
                ultimoAvisoFalhaEm = agora;
                try {
                    process.stderr.write(`Falha ao persistir metricas operacionais: ${e.message}\n`);
                } catch (stderrError) {}
            }
        }
    };

    gravar();
    const setIntervalImpl = opcoes.setIntervalImpl || setInterval;
    intervaloAtivo = setIntervalImpl(gravar, config.intervalMs);
    if (intervaloAtivo && typeof intervaloAtivo.unref === "function") intervaloAtivo.unref();
    instalado = true;

    return {
        installed: true,
        enabled: true,
        filePath: config.filePath,
        intervalMs: config.intervalMs
    };
}

function encerrarMetricasOperacionais() {
    if (intervaloAtivo) {
        try { clearInterval(intervaloAtivo); } catch (e) {}
    }
    intervaloAtivo = null;

    if (serverEmitInstrumentado && http.Server.prototype.emit === serverEmitInstrumentado && serverEmitOriginal) {
        http.Server.prototype.emit = serverEmitOriginal;
    }
    serverEmitOriginal = null;
    serverEmitInstrumentado = null;

    if (fetchInstrumentado && globalThis.fetch === fetchInstrumentado && fetchOriginal) {
        globalThis.fetch = fetchOriginal;
    }
    fetchOriginal = null;
    fetchInstrumentado = null;

    configAtiva = null;
    instalado = false;
}

function resetMetricasOperacionaisParaTeste(iniciadoEm = Date.now()) {
    encerrarMetricasOperacionais();
    estado = novoEstado(iniciadoEm);
    ultimoAvisoFalhaEm = 0;
}

module.exports = {
    booleanoConfig,
    inteiroConfig,
    configMetricasOperacionais,
    classeStatus,
    normalizarRota,
    resumoLatencias,
    registrarHttp,
    classificarDestino,
    registrarOutbound,
    registrarFreshnessReq,
    snapshotMetricasOperacionais,
    escreverJsonAtomico,
    instalarMetricasOperacionais,
    encerrarMetricasOperacionais,
    resetMetricasOperacionaisParaTeste
};
