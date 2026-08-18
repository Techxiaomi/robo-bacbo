"use strict";

const fs = require("node:fs");
const path = require("node:path");

// A suíte legada valida vários contratos visuais lendo public/index.html.
// Desde o BUG-016, index.html é apenas o bootstrap; a UI preservada vive em dashboard-app.html.
// Redirecionamos somente essa leitura durante o carregamento da suíte, sem alterar nenhuma asserção.
const readFileSyncOriginal = fs.readFileSync;
const indexPath = path.resolve(__dirname, "..", "public", "index.html");
const appPath = path.resolve(__dirname, "..", "public", "dashboard-app.html");

fs.readFileSync = function readFileSyncFrontendCanonico(arquivo, ...args) {
    const alvo = path.resolve(String(arquivo));
    if (alvo === indexPath) {
        return readFileSyncOriginal.call(fs, appPath, ...args);
    }
    return readFileSyncOriginal.call(fs, arquivo, ...args);
};

try {
    require("../support/pure-logic-suite.js");
} finally {
    fs.readFileSync = readFileSyncOriginal;
}
