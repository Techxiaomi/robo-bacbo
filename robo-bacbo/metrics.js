"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { monitorEventLoopDelay } = require("node:perf_hooks");

let instalado = false;
let intervaloAtivo = null;
let histogramaEventLoop = null;
let configAtiva = null;
let ultimoAvisoFalhaEm = 0;

function novoEstado(iniciadoEm = Date.now()) {
    return {
        iniciadoEm: Number(iniciadoEm) || Date.now(),
        logs: {
            total: 0,
            log: 0,
            info: 0,
            warn: 0,
            error: 0,
            ultimo_warn_em: null,
            ultimo_error_em: null
        },
        sinks: {
            falhas_log: 0,
            falhas_metricas: 0,
            ultima_falha_log_em: null,
            ultima_falha_metricas_em: null
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

function configMetricas(opcoes = {}) {
    const env = opcoes.env || process.env;
    const baseDir = opcoes.baseDir || process.cwd();
    const dirInformado = String(env.METRICS_DIR || env.LOG_DIR || "").trim();
    const metricsDir = dirInformado
        ? (path.isAbsolute(dirInformado) ? dirInformado : path.resolve(baseDir, dirInformado))
        : path.join(baseDir, "logs");
    const nomeBruto = String(env.METRICS_FILE_NAME || "backend.metrics.json").trim()
        || "backend.metrics.json";

    return {
        enabled: booleanoConfig(env.METRICS_ENABLED, true),
        filePath: path.join(metricsDir, path.basename(nomeBruto)),
        intervalMs: inteiroConfig(env.METRICS_INTERVAL_SECONDS, 15, 5, 300) * 1000
    };
}

function isoDoAgora(agora = Date.now()) {
    const numero = Number(agora);
    return new Date(Number.isFinite(numero) ? numero : Date.now()).toISOString();
}

function registrarLog(nivel, agora = Date.now()) {
    const normalizado = String(nivel || "log").toLowerCase();
    const chave = ["log", "info", "warn", "error"].includes(normalizado) ? normalizado : "log";
    estado.logs.total += 1;
    estado.logs[chave] += 1;

    if (chave === "warn") estado.logs.ultimo_warn_em = isoDoAgora(agora);
    if (chave === "error") estado.logs.ultimo_error_em = isoDoAgora(agora);
}

function registrarFalhaSinkLog(agora = Date.now()) {
    estado.sinks.falhas_log += 1;
    estado.sinks.ultima_falha_log_em = isoDoAgora(agora);
}

function registrarFalhaSinkMetricas(agora = Date.now()) {
    estado.sinks.falhas_metricas += 1;
    estado.sinks.ultima_falha_metricas_em = isoDoAgora(agora);
}

function megabytes(bytes) {
    const numero = Number(bytes);
    if (!Number.isFinite(numero) || numero < 0) return 0;
    return Number((numero / (1024 * 1024)).toFixed(2));
}

function nanosParaMs(valor) {
    const numero = Number(valor);
    if (!Number.isFinite(numero) || numero < 0) return 0;
    return Number((numero / 1e6).toFixed(3));
}

function lerPercentil(histograma, percentil) {
    if (!histograma || typeof histograma.percentile !== "function") return 0;
    try {
        return nanosParaMs(histograma.percentile(percentil));
    } catch (e) {
        return 0;
    }
}

function snapshotMetricas(opcoes = {}) {
    const agoraMs = Number.isFinite(Number(opcoes.agoraMs)) ? Number(opcoes.agoraMs) : Date.now();
    const memoria = opcoes.memoria || process.memoryUsage();
    const uptimeSeconds = Number.isFinite(Number(opcoes.uptimeSeconds))
        ? Number(opcoes.uptimeSeconds)
        : process.uptime();
    const histograma = opcoes.histograma === undefined ? histogramaEventLoop : opcoes.histograma;

    return {
        timestamp: isoDoAgora(agoraMs),
        pid: Number(process.pid),
        iniciado_em: new Date(estado.iniciadoEm).toISOString(),
        uptime_seconds: Number(Math.max(0, uptimeSeconds).toFixed(3)),
        memoria_mb: {
            rss: megabytes(memoria.rss),
            heap_total: megabytes(memoria.heapTotal),
            heap_usado: megabytes(memoria.heapUsed),
            external: megabytes(memoria.external),
            array_buffers: megabytes(memoria.arrayBuffers)
        },
        event_loop_delay_ms: {
            p50: lerPercentil(histograma, 50),
            p95: lerPercentil(histograma, 95),
            p99: lerPercentil(histograma, 99),
            max: nanosParaMs(histograma && histograma.max),
            media: nanosParaMs(histograma && histograma.mean)
        },
        logs: { ...estado.logs },
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

function persistirSnapshot(filePath, opcoes = {}) {
    const snapshot = snapshotMetricas(opcoes);
    escreverJsonAtomico(filePath, snapshot, opcoes);
    return snapshot;
}

function instalarMetricasRuntime(opcoes = {}) {
    if (instalado) {
        return {
            installed: true,
            reused: true,
            filePath: configAtiva && configAtiva.filePath
        };
    }

    const config = configMetricas(opcoes);
    if (!config.enabled) return { installed: false, enabled: false };

    estado = novoEstado(Date.now());
    const monitorImpl = opcoes.monitorEventLoopDelayImpl || monitorEventLoopDelay;
    histogramaEventLoop = monitorImpl({ resolution: 10 });
    if (histogramaEventLoop && typeof histogramaEventLoop.enable === "function") {
        histogramaEventLoop.enable();
    }

    const gravar = () => {
        try {
            persistirSnapshot(config.filePath);
        } catch (e) {
            const agora = Date.now();
            registrarFalhaSinkMetricas(agora);
            if ((agora - ultimoAvisoFalhaEm) >= 30000) {
                ultimoAvisoFalhaEm = agora;
                try {
                    process.stderr.write(`Falha ao persistir metricas runtime: ${e.message}\n`);
                } catch (stderrError) {}
            }
        }
    };

    gravar();
    const setIntervalImpl = opcoes.setIntervalImpl || setInterval;
    intervaloAtivo = setIntervalImpl(gravar, config.intervalMs);
    if (intervaloAtivo && typeof intervaloAtivo.unref === "function") intervaloAtivo.unref();

    configAtiva = config;
    instalado = true;

    return {
        installed: true,
        enabled: true,
        filePath: config.filePath,
        intervalMs: config.intervalMs
    };
}

function encerrarMetricasRuntime() {
    if (intervaloAtivo) {
        try { clearInterval(intervaloAtivo); } catch (e) {}
    }
    intervaloAtivo = null;

    if (histogramaEventLoop && typeof histogramaEventLoop.disable === "function") {
        try { histogramaEventLoop.disable(); } catch (e) {}
    }
    histogramaEventLoop = null;
    configAtiva = null;
    instalado = false;
}

function resetMetricasParaTeste(iniciadoEm = Date.now()) {
    encerrarMetricasRuntime();
    estado = novoEstado(iniciadoEm);
    ultimoAvisoFalhaEm = 0;
}

module.exports = {
    booleanoConfig,
    inteiroConfig,
    configMetricas,
    registrarLog,
    registrarFalhaSinkLog,
    registrarFalhaSinkMetricas,
    snapshotMetricas,
    escreverJsonAtomico,
    persistirSnapshot,
    instalarMetricasRuntime,
    encerrarMetricasRuntime,
    resetMetricasParaTeste
};
