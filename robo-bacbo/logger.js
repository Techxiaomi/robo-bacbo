"use strict";

const fs = require("fs");
const path = require("path");
const util = require("util");

let instalado = false;
let ultimoAvisoFalhaEm = 0;

const consoleOriginal = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
};

const CHAVE_SENSIVEL = /(password|passwd|pwd|token|secret|authorization|cookie|api[_-]?key|credential)/i;

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

function segredosDoAmbiente(env = process.env) {
    const chaves = [
        "DB_PASSWORD",
        "CASINO_PASSWORD",
        "INTERNAL_API_TOKEN",
        "ADMIN_PASSWORD"
    ];

    return chaves
        .map(chave => String(env[chave] || ""))
        .filter(valor => valor.length >= 4);
}

function ocultarSegredosTexto(valor, segredos = []) {
    let texto = String(valor);
    for (const segredo of segredos) {
        if (!segredo) continue;
        texto = texto.split(segredo).join("[REDACTED]");
    }

    texto = texto.replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]{8,}/gi, "$1[REDACTED]");
    return texto;
}

function sanitizarValor(valor, segredos = [], vistos = new WeakSet(), chave = "") {
    if (CHAVE_SENSIVEL.test(String(chave || ""))) return "[REDACTED]";

    if (valor === null || valor === undefined) return valor;
    if (typeof valor === "string") return ocultarSegredosTexto(valor, segredos);
    if (typeof valor === "number" || typeof valor === "boolean") return valor;
    if (typeof valor === "bigint") return valor.toString();
    if (typeof valor === "symbol") return valor.toString();
    if (typeof valor === "function") return `[Function ${valor.name || "anonymous"}]`;

    if (valor instanceof Error) {
        return {
            name: valor.name,
            message: ocultarSegredosTexto(valor.message || "", segredos),
            stack: ocultarSegredosTexto(valor.stack || "", segredos)
        };
    }

    if (Buffer.isBuffer(valor)) return `<Buffer ${valor.length} bytes>`;
    if (valor instanceof Date) return valor.toISOString();

    if (typeof valor === "object") {
        if (vistos.has(valor)) return "[Circular]";
        vistos.add(valor);

        if (Array.isArray(valor)) {
            return valor.map(item => sanitizarValor(item, segredos, vistos, ""));
        }

        const saida = {};
        for (const [nome, conteudo] of Object.entries(valor)) {
            saida[nome] = sanitizarValor(conteudo, segredos, vistos, nome);
        }
        return saida;
    }

    return ocultarSegredosTexto(String(valor), segredos);
}

function mensagemDosArgs(argsSanitizados) {
    return argsSanitizados.map(arg => {
        if (typeof arg === "string") return arg;
        return util.inspect(arg, { depth: 5, breakLength: Infinity, compact: true });
    }).join(" ");
}

function criarRegistro(level, args, opcoes = {}) {
    const agora = opcoes.agora instanceof Date ? opcoes.agora : new Date();
    const segredos = opcoes.segredos || [];
    const argsSanitizados = Array.from(args || []).map(arg => sanitizarValor(arg, segredos));

    return {
        timestamp: agora.toISOString(),
        level: String(level || "log"),
        pid: Number(process.pid),
        message: mensagemDosArgs(argsSanitizados),
        args: argsSanitizados
    };
}

function caminhoRotacionado(filePath, indice) {
    return `${filePath}.${indice}`;
}

function rotacionarArquivos(filePath, maxArquivos, fsImpl = fs) {
    const total = Math.max(1, Number(maxArquivos) || 1);

    const maisAntigo = caminhoRotacionado(filePath, total);
    if (fsImpl.existsSync(maisAntigo)) fsImpl.unlinkSync(maisAntigo);

    for (let indice = total - 1; indice >= 1; indice--) {
        const origem = caminhoRotacionado(filePath, indice);
        const destino = caminhoRotacionado(filePath, indice + 1);
        if (fsImpl.existsSync(origem)) fsImpl.renameSync(origem, destino);
    }

    if (fsImpl.existsSync(filePath)) {
        fsImpl.renameSync(filePath, caminhoRotacionado(filePath, 1));
    }
}

function escreverLinhaJson(filePath, registro, opcoes = {}) {
    const fsImpl = opcoes.fsImpl || fs;
    const maxBytes = Math.max(1024, Number(opcoes.maxBytes) || (5 * 1024 * 1024));
    const maxArquivos = Math.max(1, Number(opcoes.maxArquivos) || 3);
    const linha = `${JSON.stringify(registro)}\n`;
    const bytesLinha = Buffer.byteLength(linha, "utf8");

    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });

    if (fsImpl.existsSync(filePath)) {
        const tamanhoAtual = Number(fsImpl.statSync(filePath).size) || 0;
        if (tamanhoAtual > 0 && (tamanhoAtual + bytesLinha) > maxBytes) {
            rotacionarArquivos(filePath, maxArquivos, fsImpl);
        }
    }

    fsImpl.appendFileSync(filePath, linha, "utf8");
}

function configLogging(opcoes = {}) {
    const env = opcoes.env || process.env;
    const baseDir = opcoes.baseDir || process.cwd();
    const dirInformado = String(env.LOG_DIR || "").trim();
    const logDir = dirInformado
        ? (path.isAbsolute(dirInformado) ? dirInformado : path.resolve(baseDir, dirInformado))
        : path.join(baseDir, "logs");

    const nomeArquivoBruto = String(env.LOG_FILE_NAME || "backend.jsonl").trim() || "backend.jsonl";
    const nomeArquivo = path.basename(nomeArquivoBruto);

    return {
        enabled: booleanoConfig(env.LOG_FILE_ENABLED, true),
        filePath: path.join(logDir, nomeArquivo),
        maxBytes: inteiroConfig(env.LOG_MAX_BYTES, 5 * 1024 * 1024, 64 * 1024, 100 * 1024 * 1024),
        maxArquivos: inteiroConfig(env.LOG_MAX_FILES, 3, 1, 10),
        segredos: segredosDoAmbiente(env)
    };
}

function instalarLoggingEstruturado(opcoes = {}) {
    if (instalado) return { installed: true, reused: true };

    const config = configLogging(opcoes);
    if (!config.enabled) return { installed: false, enabled: false };

    const escrever = (level, args) => {
        try {
            const registro = criarRegistro(level, args, { segredos: config.segredos });
            escreverLinhaJson(config.filePath, registro, {
                maxBytes: config.maxBytes,
                maxArquivos: config.maxArquivos
            });
        } catch (e) {
            const agora = Date.now();
            if ((agora - ultimoAvisoFalhaEm) >= 30000) {
                ultimoAvisoFalhaEm = agora;
                consoleOriginal.error("Falha ao persistir log estruturado; console preservado:", e.message);
            }
        }
    };

    const envolver = (nivel) => {
        const saidaConsole = consoleOriginal[nivel] || consoleOriginal.log;
        console[nivel] = (...args) => {
            saidaConsole(...args);
            escrever(nivel, args);
        };
    };

    envolver("log");
    envolver("info");
    envolver("warn");
    envolver("error");

    instalado = true;
    console.log(`Logging estruturado ativo em ${config.filePath}`);

    return {
        installed: true,
        enabled: true,
        filePath: config.filePath,
        maxBytes: config.maxBytes,
        maxArquivos: config.maxArquivos
    };
}

module.exports = {
    booleanoConfig,
    inteiroConfig,
    segredosDoAmbiente,
    ocultarSegredosTexto,
    sanitizarValor,
    criarRegistro,
    rotacionarArquivos,
    escreverLinhaJson,
    configLogging,
    instalarLoggingEstruturado
};
