"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { spawn } = require("node:child_process");
const mysql = require("mysql2/promise");
const { io } = require("socket.io-client");

const HOST = "127.0.0.1";
const PORT = Number(process.env.INTEGRATION_NODE_PORT || 3117);
const BASE_URL = `http://${HOST}:${PORT}`;
const ADMIN_USERNAME = "integration-admin";
const ADMIN_PASSWORD = String(process.env.E2E_ADMIN_PASSWORD ||
    crypto.randomBytes(24).toString("hex"));
const INTERNAL_API_TOKEN = String(process.env.E2E_INTERNAL_API_TOKEN ||
    `e2e-${crypto.randomUUID()}-${crypto.randomBytes(16).toString("hex")}`);
const DB_PASSWORD = String(process.env.E2E_DB_PASSWORD || "");

if (!DB_PASSWORD) {
    throw new Error("E2E_DB_PASSWORD é obrigatório para o teste de integração.");
}

const backendPath = path.join(__dirname, "..", "bot2_coletor.js");
let backendSaida = "";

function registrarSaida(chunk, stream) {
    const texto = String(chunk || "");
    backendSaida += texto;
    stream.write(texto);
}

function dormir(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function requisicao(caminho, opcoes = {}) {
    return fetch(`${BASE_URL}${caminho}`, {
        redirect: "manual",
        ...opcoes
    });
}

function cookiePrincipal(setCookie) {
    return String(setCookie || "").split(";")[0];
}

function conectarSocket(cookie = "") {
    return new Promise((resolve, reject) => {
        const extraHeaders = { Origin: BASE_URL };
        if (cookie) extraHeaders.Cookie = cookie;

        const socket = io(BASE_URL, {
            transports: ["websocket"],
            forceNew: true,
            reconnection: false,
            timeout: 3000,
            extraHeaders
        });

        let finalizado = false;
        const finalizar = (erro, socketConectado = null) => {
            if (finalizado) return;
            finalizado = true;
            clearTimeout(timer);
            socket.off("connect", aoConectar);
            socket.off("connect_error", aoErro);
            if (erro) {
                socket.close();
                reject(erro);
            } else {
                resolve(socketConectado);
            }
        };

        const aoConectar = () => finalizar(null, socket);
        const aoErro = erro => finalizar(erro || new Error("Socket.IO connect_error"));
        const timer = setTimeout(
            () => finalizar(new Error("Timeout aguardando handshake Socket.IO")),
            5000
        );

        socket.once("connect", aoConectar);
        socket.once("connect_error", aoErro);
    });
}

async function confirmarSocketRejeitado(cookie = "") {
    let rejeitado = false;
    let conectado = null;

    try {
        conectado = await conectarSocket(cookie);
    } catch (e) {
        rejeitado = true;
    } finally {
        if (conectado) conectado.close();
    }

    assert.equal(rejeitado, true, "Handshake Socket.IO deveria ter sido rejeitado");
}

async function aguardarBackendPronto(cookie, processo, timeoutMs = 30000) {
    const inicio = Date.now();

    while ((Date.now() - inicio) < timeoutMs) {
        if (processo.exitCode !== null) {
            throw new Error(`Backend encerrou antes de ficar pronto (exit=${processo.exitCode}).`);
        }

        try {
            const resposta = await requisicao("/api/dashboard-stats", {
                headers: { Cookie: cookie }
            });

            if (resposta.status === 200) return;
            if (resposta.status !== 503) {
                throw new Error(`Status inesperado durante bootstrap: HTTP ${resposta.status}`);
            }
        } catch (erro) {
            if (processo.exitCode !== null) throw erro;
        }

        await dormir(250);
    }

    throw new Error("Timeout aguardando backendPronto=true.");
}

async function main() {
    const childEnv = {
        ...process.env,
        DB_HOST: "127.0.0.1",
        DB_PORT: "3306",
        DB_USER: "root",
        DB_PASSWORD,
        DB_NAME: "bacbo_integration",
        NODE_HOST: HOST,
        NODE_PORT: String(PORT),
        INTERNAL_API_TOKEN,
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
        ADMIN_SESSION_TTL_MINUTES: "30",
        ADMIN_COOKIE_SECURE: "false",
        EXECUTOR_URL: "http://127.0.0.1:5999/apostar",
        LOG_FILE_ENABLED: "false"
    };

    const backend = spawn(process.execPath, [backendPath], {
        cwd: path.join(__dirname, ".."),
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"]
    });

    backend.stdout.on("data", chunk => registrarSaida(chunk, process.stdout));
    backend.stderr.on("data", chunk => registrarSaida(chunk, process.stderr));

    let conexao = null;
    let socketAutorizado = null;

    try {
        let loginDisponivel = false;
        for (let tentativa = 0; tentativa < 80; tentativa++) {
            if (backend.exitCode !== null) {
                throw new Error(`Backend encerrou durante startup (exit=${backend.exitCode}).`);
            }
            try {
                const resposta = await requisicao("/login");
                if (resposta.status === 200) {
                    loginDisponivel = true;
                    const html = await resposta.text();
                    assert.match(html, /<form/i);
                    break;
                }
            } catch (e) {}
            await dormir(100);
        }
        assert.equal(loginDisponivel, true, "GET /login nao ficou disponivel");

        const origemInvalida = await requisicao("/login", {
            headers: { Origin: "http://origem-invalida.example" }
        });
        assert.equal(origemInvalida.status, 403);
        assert.deepEqual(await origemInvalida.json(), { erro: "Origem ou host nao permitido" });

        const apiSemSessao = await requisicao("/api/dashboard-stats");
        assert.equal(apiSemSessao.status, 401);
        assert.deepEqual(
            await apiSemSessao.json(),
            { erro: "autenticacao_administrativa_necessaria" }
        );

        const loginInvalido = await requisicao("/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                usuario: ADMIN_USERNAME,
                senha: "senha-incorreta"
            })
        });
        assert.equal(loginInvalido.status, 302);
        assert.equal(loginInvalido.headers.get("location"), "/login?erro=1");
        assert.equal(loginInvalido.headers.get("set-cookie"), null);

        const loginValido = await requisicao("/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                usuario: ADMIN_USERNAME,
                senha: ADMIN_PASSWORD
            })
        });
        assert.equal(loginValido.status, 302);
        assert.equal(loginValido.headers.get("location"), "/");

        const setCookie = loginValido.headers.get("set-cookie");
        assert.match(String(setCookie), /bacbo_admin_session=[0-9a-f]{64}/);
        assert.match(String(setCookie), /HttpOnly/i);
        assert.match(String(setCookie), /SameSite=Strict/i);
        const cookie = cookiePrincipal(setCookie);

        await aguardarBackendPronto(cookie, backend);

        await confirmarSocketRejeitado();

        socketAutorizado = await conectarSocket(cookie);
        assert.equal(socketAutorizado.connected, true);
        socketAutorizado.close();
        socketAutorizado = null;

        const painel = await requisicao("/", {
            headers: { Cookie: cookie }
        });
        assert.equal(painel.status, 200);
        assert.match(await painel.text(), /<!DOCTYPE html>/i);

        const dashboard = await requisicao("/api/dashboard-stats", {
            headers: { Cookie: cookie }
        });
        assert.equal(dashboard.status, 200);
        assert.deepEqual(await dashboard.json(), {
            sinais: 0,
            greens: 0,
            reds: 0,
            ties: 0,
            max_green_seq: 0,
            max_red_seq: 0,
            assertividade: "0%"
        });

        const webhookSemToken = await requisicao("/receber-sinal", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}"
        });
        assert.equal(webhookSemToken.status, 401);
        assert.deepEqual(await webhookSemToken.json(), { erro: "Nao autorizado" });

        const webhookComToken = await requisicao("/receber-sinal", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Internal-Token": INTERNAL_API_TOKEN
            },
            body: "{}"
        });
        assert.equal(webhookComToken.status, 200);
        assert.deepEqual(await webhookComToken.json(), {
            recebido: true,
            saldo_atual: null
        });

        conexao = await mysql.createConnection({
            host: "127.0.0.1",
            port: 3306,
            user: "root",
            password: DB_PASSWORD,
            database: "bacbo_integration"
        });

        const [tabelasRows] = await conexao.query("SHOW TABLES");
        const tabelas = new Set(
            tabelasRows.map(row => String(Object.values(row)[0]))
        );
        const esperadas = [
            "origens",
            "estrategias",
            "historico_resultados",
            "giros_recentes",
            "robos_canais",
            "destinatarios_robo",
            "historico_disparos_robos",
            "auto_traders",
            "auditoria_ordens"
        ];
        for (const tabela of esperadas) {
            assert.equal(tabelas.has(tabela), true, `Tabela ausente: ${tabela}`);
        }

        const [[contagemGiros]] = await conexao.query(
            "SELECT COUNT(*) AS total FROM giros_recentes"
        );
        const [[contagemOrdens]] = await conexao.query(
            "SELECT COUNT(*) AS total FROM auditoria_ordens"
        );
        assert.equal(Number(contagemGiros.total), 0);
        assert.equal(Number(contagemOrdens.total), 0);

        const logout = await requisicao("/auth/logout", {
            method: "POST",
            headers: { Cookie: cookie }
        });
        assert.equal(logout.status, 302);
        assert.equal(logout.headers.get("location"), "/login");
        assert.match(String(logout.headers.get("set-cookie")), /Max-Age=0/i);

        const apiDepoisLogout = await requisicao("/api/dashboard-stats", {
            headers: { Cookie: cookie }
        });
        assert.equal(apiDepoisLogout.status, 401);

        await confirmarSocketRejeitado(cookie);

        console.log("OBS-003F integration smoke: PASS");
    } catch (erro) {
        console.error("OBS-003F integration smoke: FAIL", erro);
        console.error("--- Saida acumulada do backend ---");
        console.error(backendSaida);
        process.exitCode = 1;
    } finally {
        if (socketAutorizado) {
            try { socketAutorizado.close(); } catch (e) {}
        }

        if (conexao) {
            try { await conexao.end(); } catch (e) {}
        }

        if (backend.exitCode === null) {
            backend.kill("SIGTERM");
            await Promise.race([
                new Promise(resolve => backend.once("exit", resolve)),
                dormir(3000)
            ]);
            if (backend.exitCode === null) backend.kill("SIGKILL");
        }
    }
}

main().catch(erro => {
    console.error("OBS-003F integration smoke: FAIL fatal", erro);
    process.exitCode = 1;
});
