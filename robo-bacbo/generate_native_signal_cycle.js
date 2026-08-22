'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname);

function contarOcorrencias(source, trecho) {
    let total = 0;
    let cursor = 0;
    while (trecho && (cursor = source.indexOf(trecho, cursor)) >= 0) {
        total++;
        cursor += trecho.length;
    }
    return total;
}

function substituirExatamente(source, label, before, after) {
    const total = contarOcorrencias(source, before);
    if (total !== 1) {
        throw new Error(`MATERIALIZE: ${label} esperava 1 ocorrência e encontrou ${total}`);
    }
    return source.replace(before, after);
}

function extrairTransformacoesRaw(textoBruto, endMarker) {
    const texto = String(textoBruto || '').replace(/\r\n/g, '\n');
    const inicios = [];
    const reInicio = /^replaceExactly\(/gm;
    let match = null;
    while ((match = reInicio.exec(texto)) !== null) inicios.push(match.index);
    if (inicios.length === 0) throw new Error('MATERIALIZE: patch sem replaceExactly');

    const fimGlobal = texto.indexOf(endMarker, inicios[inicios.length - 1]);
    if (fimGlobal < 0) throw new Error(`MATERIALIZE: marcador final ausente: ${endMarker}`);

    const transforms = [];
    for (let i = 0; i < inicios.length; i++) {
        const inicio = inicios[i];
        const fim = i + 1 < inicios.length ? inicios[i + 1] : fimGlobal;
        const bloco = texto.slice(inicio, fim).trim();
        const labelMatch = bloco.match(/^replaceExactly\(\s*'([^']+)'\s*,/);
        if (!labelMatch) throw new Error(`MATERIALIZE: label inválido no bloco ${i + 1}`);
        const label = labelMatch[1];
        const posDepoisLabel = labelMatch[0].length;
        const inicioBefore = bloco.indexOf('`', posDepoisLabel);
        if (inicioBefore < 0) throw new Error(`MATERIALIZE: before ausente em ${label}`);
        const separador = /`,\s*\n\s*`/g;
        separador.lastIndex = inicioBefore + 1;
        const sep = separador.exec(bloco);
        if (!sep) throw new Error(`MATERIALIZE: separador before/after ausente em ${label}`);
        const before = bloco.slice(inicioBefore + 1, sep.index);
        const inicioAfter = sep.index + sep[0].lastIndexOf('`');
        const fechamento = /`\s*\);\s*$/;
        const close = fechamento.exec(bloco);
        if (!close) throw new Error(`MATERIALIZE: fechamento after ausente em ${label}`);
        const after = bloco.slice(inicioAfter + 1, close.index);
        transforms.push({ label, before, after });
    }
    return transforms;
}

function aplicarTransformacoesRaw(source, patchText, endMarker) {
    let atual = source;
    for (const t of extrairTransformacoesRaw(patchText, endMarker)) {
        atual = substituirExatamente(atual, t.label, t.before, t.after);
    }
    return atual;
}

function aplicarPhase3Estatica(sourceInicial) {
    const { aplicarPhase3AoPatchPhase1 } = require('./signal_cycle_phase3_patch');
    const marker = "if (!source.includes('ciclo_id') || !source.includes('aguardandoRecuperacao')) {";
    const sintetico = aplicarPhase3AoPatchPhase1(marker);
    const pos = sintetico.lastIndexOf(marker);
    if (pos < 0) throw new Error('MATERIALIZE: programa Phase3 não materializado');
    const programa = sintetico.slice(0, pos);
    let source = sourceInicial;
    const replaceExactly = (label, before, after) => {
        source = substituirExatamente(source, label, before, after);
    };
    const executar = new Function('replaceExactly', `'use strict';\n${programa}`);
    executar(replaceExactly);
    return source;
}

function validarFonteFinal(nome, source) {
    const proibidos = [
        'signal_cycle_phase2_patch',
        'signal_cycle_phase3_patch',
        'substituirUnico(',
        'replaceExactly(',
        'module._compile(',
        'fs.readFileSync = function readFileSyncPhase2'
    ];
    for (const termo of proibidos) {
        if (source.includes(termo)) throw new Error(`${nome}: dependência de patch residual: ${termo}`);
    }
    if (/```/.test(source)) throw new Error(`${nome}: markdown residual detectado`);
    new vm.Script(source, { filename: nome });
}

const { aplicarBotPhase2, aplicarRoadPhase2 } = require('./signal_cycle_phase2_patch');

const botBase = fs.readFileSync(path.join(ROOT, 'bot2_coletor.phase0.js'), 'utf8');
const phase1Patch = fs.readFileSync(path.join(ROOT, 'bot2_coletor.phase1_base.txt'), 'utf8');
let bot = aplicarBotPhase2(botBase);
bot = aplicarTransformacoesRaw(
    bot,
    phase1Patch,
    "if (!source.includes('ciclo_id') || !source.includes('aguardandoRecuperacao')) {"
);
bot = aplicarPhase3Estatica(bot);

const obrigatoriosBot = [
    'const watermarkRecuperacaoPorRobo = new Map();',
    'function enfileirarTrabalhoFinanceiroAutoTrader(',
    'aguardandoRecuperacao',
    'ciclo_id',
    'coletor_seq_entrada',
    'seqTurnoDeteccao',
    'robosBloqueadosNoTurno',
    'async function recuperarSinaisAguardandoRecuperacao('
];
for (const termo of obrigatoriosBot) {
    if (!bot.includes(termo)) throw new Error(`bot2_coletor.js: estrutura obrigatória ausente: ${termo}`);
}
validarFonteFinal('bot2_coletor.js', bot);

const roadBase = fs.readFileSync(path.join(ROOT, 'bug051b_integration.phase0.js'), 'utf8');
const roadPhase1Patch = fs.readFileSync(path.join(ROOT, 'bug051b_integration.js'), 'utf8');
let road = aplicarRoadPhase2(roadBase);
road = aplicarTransformacoesRaw(
    road,
    roadPhase1Patch,
    'module._compile(source, __filename);'
);
const obrigatoriosRoad = [
    'function obterHistoricoCanonicoLive(limiteSolicitado = LIMITE_HISTORY_CANONICO, coletorSeqMax = null)',
    'ultimo_coletor_seq:',
    'global.__signalCycleRecoveryFromRoad',
    'seqItem <= seqMax'
];
for (const termo of obrigatoriosRoad) {
    if (!road.includes(termo)) throw new Error(`bug051b_integration.js: estrutura obrigatória ausente: ${termo}`);
}
validarFonteFinal('bug051b_integration.js', road);

fs.writeFileSync(path.join(ROOT, 'bot2_coletor.js'), bot.endsWith('\n') ? bot : `${bot}\n`, 'utf8');
fs.writeFileSync(path.join(ROOT, 'bug051b_integration.js'), road.endsWith('\n') ? road : `${road}\n`, 'utf8');

console.log(`MATERIALIZE OK | bot=${bot.length} chars | road=${road.length} chars`);
