'use strict';

const fs = require('fs');
const path = require('path');
const {
    aplicarBotPhase2,
    aplicarRoadPhase2
} = require('./signal_cycle_phase2_patch');

const readFileSyncOriginal = fs.readFileSync;

fs.readFileSync = function readFileSyncPhase2(filePath, ...args) {
    const conteudo = readFileSyncOriginal.call(fs, filePath, ...args);
    const caminho = path.resolve(String(filePath));

    if (caminho.endsWith(path.join('robo-bacbo', 'bot2_coletor.phase0.js'))) {
        return aplicarBotPhase2(String(conteudo));
    }
    if (caminho.endsWith(path.join('robo-bacbo', 'bug051b_integration.phase0.js'))) {
        return aplicarRoadPhase2(String(conteudo));
    }
    return conteudo;
};

try {
    require('./bot2_coletor.phase1.js');
} finally {
    fs.readFileSync = readFileSyncOriginal;
}
