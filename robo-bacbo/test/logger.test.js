"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const logger = require("../logger");

test("config booleana e inteira aplica defaults e limites", () => {
    assert.equal(logger.booleanoConfig(undefined, true), true);
    assert.equal(logger.booleanoConfig("false", true), false);
    assert.equal(logger.booleanoConfig("SIM", false), true);
    assert.equal(logger.booleanoConfig("valor-invalido", false), false);

    assert.equal(logger.inteiroConfig("500", 10, 1, 1000), 500);
    assert.equal(logger.inteiroConfig("0", 10, 1, 1000), 1);
    assert.equal(logger.inteiroConfig("9999", 10, 1, 1000), 1000);
    assert.equal(logger.inteiroConfig("abc", 10, 1, 1000), 10);
});

test("redaction remove segredos do ambiente e bearer tokens", () => {
    const env = {
        DB_PASSWORD: "senha-db-123",
        CASINO_PASSWORD: "senha-casino-456",
        INTERNAL_API_TOKEN: "token-interno-789",
        ADMIN_PASSWORD: "senha-admin-000"
    };
    const segredos = logger.segredosDoAmbiente(env);
    const texto = logger.ocultarSegredosTexto(
        "db=senha-db-123 admin=senha-admin-000 Authorization: Bearer abcdefghijklmnop",
        segredos
    );

    assert.equal(texto.includes("senha-db-123"), false);
    assert.equal(texto.includes("senha-admin-000"), false);
    assert.equal(texto.includes("abcdefghijklmnop"), false);
    assert.match(texto, /\[REDACTED\]/);
});

test("sanitizacao mascara chaves sensiveis, Error e referencias circulares", () => {
    const objeto = {
        usuario: "fernando",
        password: "segredo-em-objeto",
        nested: {
            telegram_token: "123456:ABCDEF",
            valor: 42
        },
        erro: new Error("falhou com token-interno-789")
    };
    objeto.self = objeto;

    const sanitizado = logger.sanitizarValor(objeto, ["token-interno-789"]);

    assert.equal(sanitizado.usuario, "fernando");
    assert.equal(sanitizado.password, "[REDACTED]");
    assert.equal(sanitizado.nested.telegram_token, "[REDACTED]");
    assert.equal(sanitizado.nested.valor, 42);
    assert.equal(sanitizado.erro.message.includes("token-interno-789"), false);
    assert.equal(sanitizado.self, "[Circular]");
});

test("registro JSON inclui metadados e nunca repete segredo sanitizado", () => {
    const registro = logger.criarRegistro(
        "error",
        ["Falha", { INTERNAL_API_TOKEN: "nao-pode-vazar", codigo: 500 }],
        { agora: new Date("2026-08-17T18:00:00.000Z"), segredos: ["nao-pode-vazar"] }
    );

    assert.equal(registro.timestamp, "2026-08-17T18:00:00.000Z");
    assert.equal(registro.level, "error");
    assert.equal(Number.isInteger(registro.pid), true);
    assert.equal(JSON.stringify(registro).includes("nao-pode-vazar"), false);
    assert.match(registro.message, /\[REDACTED\]/);
});

test("escrita cria JSONL e rotaciona preservando arquivos anteriores", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bacbo-logger-"));
    const filePath = path.join(dir, "backend.jsonl");

    try {
        logger.escreverLinhaJson(filePath, { n: 1, texto: "A".repeat(900) }, {
            maxBytes: 1024,
            maxArquivos: 2
        });
        logger.escreverLinhaJson(filePath, { n: 2, texto: "B".repeat(900) }, {
            maxBytes: 1024,
            maxArquivos: 2
        });
        logger.escreverLinhaJson(filePath, { n: 3, texto: "C".repeat(900) }, {
            maxBytes: 1024,
            maxArquivos: 2
        });

        assert.equal(fs.existsSync(filePath), true);
        assert.equal(fs.existsSync(`${filePath}.1`), true);
        assert.equal(fs.existsSync(`${filePath}.2`), true);

        assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8").trim()).n, 3);
        assert.equal(JSON.parse(fs.readFileSync(`${filePath}.1`, "utf8").trim()).n, 2);
        assert.equal(JSON.parse(fs.readFileSync(`${filePath}.2`, "utf8").trim()).n, 1);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("configLogging resolve diretorio relativo e impede path traversal no nome", () => {
    const baseDir = path.resolve(path.sep, "tmp", "bacbo-base");
    const config = logger.configLogging({
        baseDir,
        env: {
            LOG_FILE_ENABLED: "true",
            LOG_DIR: "logs-custom",
            LOG_FILE_NAME: "../fora.jsonl",
            LOG_MAX_BYTES: "131072",
            LOG_MAX_FILES: "4",
            INTERNAL_API_TOKEN: "123456789"
        }
    });

    assert.equal(config.enabled, true);
    assert.equal(config.filePath, path.join(baseDir, "logs-custom", "fora.jsonl"));
    assert.equal(config.maxBytes, 131072);
    assert.equal(config.maxArquivos, 4);
    assert.deepEqual(config.segredos, ["123456789"]);
});

test("logging pode ser desativado explicitamente sem envolver console", () => {
    const resultado = logger.instalarLoggingEstruturado({
        baseDir: process.cwd(),
        env: { LOG_FILE_ENABLED: "false" }
    });

    assert.deepEqual(resultado, { installed: false, enabled: false });
});
