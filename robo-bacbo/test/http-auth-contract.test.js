"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

const backendPath = path.join(__dirname, "..", "bot2_coletor.js");
const source = fs.readFileSync(backendPath, "utf8").replace(/\r\n/g, "\n");

function trechoEntre(inicio, fim) {
    const posInicio = source.indexOf(inicio);
    if (posInicio < 0) throw new Error(`Marcador inicial nao encontrado: ${inicio}`);
    const posFim = source.indexOf(fim, posInicio);
    if (posFim < 0) throw new Error(`Marcador final nao encontrado: ${fim}`);
    return source.slice(posInicio, posFim);
}

function criarAppFake() {
    const handlers = {
        get: new Map(),
        post: new Map(),
        use: []
    };

    return {
        handlers,
        get(rota, handler) {
            handlers.get.set(rota, handler);
        },
        post(rota, handler) {
            handlers.post.set(rota, handler);
        },
        use(handler) {
            handlers.use.push(handler);
        }
    };
}

function carregarContratoAuth() {
    const helpers = trechoEntre(
        "function compararTextoSeguro",
        "const app = express();"
    );
    const rotas = trechoEntre(
        "app.get('/login'",
        "app.use((req, res, next) => {\n    const rotaDependeDeInicializacao"
    );

    const app = criarAppFake();
    const contexto = {
        module: { exports: {} },
        exports: {},
        app,
        crypto,
        Buffer,
        decodeURIComponent,
        encodeURIComponent,
        Date,
        Number,
        String,
        Map,
        Math,
        path,
        __dirname: path.join(__dirname, ".."),
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD: "senha-forte",
        ADMIN_SESSION_TTL_MS: 60_000,
        ADMIN_SESSION_COOKIE: "bacbo_admin_session",
        ADMIN_COOKIE_SECURE: false,
        ADMIN_AUTH_REQUIRED: true,
        SESSOES_ADMIN: new Map()
    };

    vm.createContext(contexto);
    vm.runInContext(
        `${helpers}\n${rotas}\nmodule.exports = {\n    compararTextoSeguro,\n    criarSessaoAdmin,\n    sessaoAdminValidaCookie,\n    tokenSessaoAdminDoCookie,\n    cookieSessaoAdmin\n};`,
        contexto,
        { filename: "http-auth-contract-from-backend.js" }
    );

    return {
        handlers: app.handlers,
        helpers: contexto.module.exports
    };
}

function criarReq(caminho, { headers = {}, body = {} } = {}) {
    const headersNormalizados = Object.fromEntries(
        Object.entries(headers).map(([chave, valor]) => [chave.toLowerCase(), valor])
    );
    return {
        path: caminho,
        body,
        get(nome) {
            return headersNormalizados[String(nome).toLowerCase()];
        }
    };
}

function criarRes() {
    return {
        statusCode: 200,
        jsonBody: undefined,
        redirectTo: undefined,
        sentFile: undefined,
        headers: {},
        status(codigo) {
            this.statusCode = codigo;
            return this;
        },
        json(payload) {
            this.jsonBody = payload;
            return this;
        },
        redirect(destino) {
            this.redirectTo = destino;
            return this;
        },
        sendFile(arquivo) {
            this.sentFile = arquivo;
            return this;
        },
        setHeader(nome, valor) {
            this.headers[nome.toLowerCase()] = valor;
        }
    };
}

function executar(handler, req, res) {
    let nextCalled = false;
    handler(req, res, () => {
        nextCalled = true;
    });
    return { nextCalled, res };
}

function cookieDeSetCookie(setCookie) {
    return String(setCookie || "").split(";")[0];
}

test("GET /login sem sessao entrega a pagina de login", () => {
    const contrato = carregarContratoAuth();
    const handler = contrato.handlers.get.get("/login");
    assert.equal(typeof handler, "function");

    const res = criarRes();
    executar(handler, criarReq("/login"), res);

    assert.equal(res.redirectTo, undefined);
    assert.match(res.sentFile, /public[\\/]login\.html$/);
});

test("POST /auth/login rejeita credencial invalida sem criar cookie", () => {
    const contrato = carregarContratoAuth();
    const handler = contrato.handlers.post.get("/auth/login");
    const res = criarRes();

    executar(handler, criarReq("/auth/login", {
        body: { usuario: "admin", senha: "errada" }
    }), res);

    assert.equal(res.redirectTo, "/login?erro=1");
    assert.equal(res.headers["set-cookie"], undefined);
});

test("POST /auth/login valido cria cookie HttpOnly SameSite e redireciona ao painel", () => {
    const contrato = carregarContratoAuth();
    const handler = contrato.handlers.post.get("/auth/login");
    const res = criarRes();

    executar(handler, criarReq("/auth/login", {
        body: { usuario: "admin", senha: "senha-forte" }
    }), res);

    const setCookie = res.headers["set-cookie"];
    assert.equal(res.redirectTo, "/");
    assert.match(setCookie, /^bacbo_admin_session=[0-9a-f]{64};/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Max-Age=60/);
});

test("middleware administrativo retorna 401 na API sem sessao e libera com cookie valido", () => {
    const contrato = carregarContratoAuth();
    const login = contrato.handlers.post.get("/auth/login");
    const middleware = contrato.handlers.use[0];

    const semAuth = criarRes();
    const execSemAuth = executar(
        middleware,
        criarReq("/api/estrategias"),
        semAuth
    );
    assert.equal(execSemAuth.nextCalled, false);
    assert.equal(semAuth.statusCode, 401);
    assert.deepEqual(
        JSON.parse(JSON.stringify(semAuth.jsonBody)),
        { erro: "autenticacao_administrativa_necessaria" }
    );

    const loginRes = criarRes();
    executar(login, criarReq("/auth/login", {
        body: { usuario: "admin", senha: "senha-forte" }
    }), loginRes);
    const cookie = cookieDeSetCookie(loginRes.headers["set-cookie"]);

    const comAuth = criarRes();
    const execComAuth = executar(
        middleware,
        criarReq("/api/estrategias", {
            headers: { Cookie: cookie }
        }),
        comAuth
    );
    assert.equal(execComAuth.nextCalled, true);
    assert.equal(comAuth.statusCode, 200);
});

test("middleware administrativo preserva /receber-sinal sem exigir cookie de usuario", () => {
    const contrato = carregarContratoAuth();
    const middleware = contrato.handlers.use[0];
    const res = criarRes();

    const execucao = executar(
        middleware,
        criarReq("/receber-sinal"),
        res
    );

    assert.equal(execucao.nextCalled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.redirectTo, undefined);
});

test("POST /auth/logout invalida a sessao e expira o cookie", () => {
    const contrato = carregarContratoAuth();
    const login = contrato.handlers.post.get("/auth/login");
    const logout = contrato.handlers.post.get("/auth/logout");
    const middleware = contrato.handlers.use[0];

    const loginRes = criarRes();
    executar(login, criarReq("/auth/login", {
        body: { usuario: "admin", senha: "senha-forte" }
    }), loginRes);
    const cookie = cookieDeSetCookie(loginRes.headers["set-cookie"]);

    const antes = criarRes();
    assert.equal(
        executar(middleware, criarReq("/api/estrategias", {
            headers: { Cookie: cookie }
        }), antes).nextCalled,
        true
    );

    const logoutRes = criarRes();
    executar(logout, criarReq("/auth/logout", {
        headers: { Cookie: cookie }
    }), logoutRes);

    assert.equal(logoutRes.redirectTo, "/login");
    assert.match(logoutRes.headers["set-cookie"], /Max-Age=0/);

    const depois = criarRes();
    executar(middleware, criarReq("/api/estrategias", {
        headers: { Cookie: cookie }
    }), depois);
    assert.equal(depois.statusCode, 401);
});
