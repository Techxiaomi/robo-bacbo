'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { aplicarPhase3AoPatchPhase1 } = require('./signal_cycle_phase3_patch');

const MARCADOR_FINAL_PHASE1 = "if (!source.includes('ciclo_id') || !source.includes('aguardandoRecuperacao')) {";

function contarOcorrencias(source, trecho) {
    if (!trecho) return 0;
    let total = 0;
    let cursor = 0;
    while (true) {
        const indice = source.indexOf(trecho, cursor);
        if (indice < 0) return total;
        total++;
        cursor = indice + trecho.length;
    }
}

function aplicarReplaceExato(sourceAtual, label, before, after) {
    const total = contarOcorrencias(sourceAtual, before);
    if (total !== 1) {
        throw new Error(`SIGNAL-CYCLE-01: ${label} esperava 1 ocorrência e encontrou ${total}`);
    }
    return sourceAtual.replace(before, after);
}

function extrairTransformacoesPhase1(patchBruto) {
    const texto = String(patchBruto || '').replace(/\r\n/g, '\n');
    const inicios = [];
    const regexInicio = /^replaceExactly\(/gm;
    let matchInicio = null;
    while ((matchInicio = regexInicio.exec(texto)) !== null) {
        inicios.push(matchInicio.index);
    }

    if (inicios.length === 0) {
        throw new Error('SIGNAL-CYCLE-01: nenhuma transformação encontrada no patch base');
    }

    const marcadorFinal = texto.indexOf(`\n${MARCADOR_FINAL_PHASE1}`, inicios[inicios.length - 1]);
    if (marcadorFinal < 0) {
        throw new Error('SIGNAL-CYCLE-01: marcador final do patch base não encontrado');
    }

    const transformacoes = [];
    for (let i = 0; i < inicios.length; i++) {
        const inicio = inicios[i];
        const fim = i + 1 < inicios.length ? inicios[i + 1] : marcadorFinal;
        const bloco = texto.slice(inicio, fim).trim();
        const match = bloco.match(/^replaceExactly\(\s*'([^']+)'\s*,\s*`([\s\S]*?)`,\s*`([\s\S]*)`\s*\);$/);
        if (!match) {
            throw new Error(`SIGNAL-CYCLE-01: bloco de transformação inválido na posição ${i + 1}`);
        }
        transformacoes.push({ label: match[1], before: match[2], after: match[3] });
    }

    const labels = new Set();
    for (const item of transformacoes) {
        if (labels.has(item.label)) {
            throw new Error(`SIGNAL-CYCLE-01: transformação duplicada: ${item.label}`);
        }
        labels.add(item.label);
    }

    return transformacoes;
}

function aplicarTransformacoesPhase3(sourceInicial) {
    let sourceAtual = sourceInicial;
    const patchSintetico = aplicarPhase3AoPatchPhase1(MARCADOR_FINAL_PHASE1);
    const posicaoMarcador = patchSintetico.lastIndexOf(MARCADOR_FINAL_PHASE1);
    if (posicaoMarcador < 0) {
        throw new Error('SIGNAL-CYCLE-03: não foi possível materializar as transformações da Fase 3');
    }

    const programaPhase3 = patchSintetico.slice(0, posicaoMarcador);
    const replaceExactly = (label, before, after) => {
        sourceAtual = aplicarReplaceExato(sourceAtual, label, before, after);
    };

    const executorPhase3 = new Function(
        'replaceExactly',
        `'use strict';\n${programaPhase3}`
    );
    executorPhase3(replaceExactly);
    return sourceAtual;
}

let source = fs.readFileSync(path.join(__dirname, 'bot2_coletor.phase0.js'), 'utf8');
const patchPhase1Bruto = fs.readFileSync(path.join(__dirname, 'bot2_coletor.phase1_base.txt'), 'utf8');

for (const transformacao of extrairTransformacoesPhase1(patchPhase1Bruto)) {
    source = aplicarReplaceExato(
        source,
        transformacao.label,
        transformacao.before,
        transformacao.after
    );
}

if (!source.includes('ciclo_id') || !source.includes('aguardandoRecuperacao')) {
    throw new Error('SIGNAL-CYCLE-01: validação final da Fase 1 falhou');
}

source = aplicarTransformacoesPhase3(source);

if (/```/.test(source)) {
    throw new Error('SIGNAL-CYCLE-03: marcador Markdown detectado no código gerado');
}
if (/^\s*`\s*(?:async\s+)?function\s+/m.test(source)) {
    throw new Error('SIGNAL-CYCLE-03: backtick inválido antes de declaração de função');
}
if (/^\s*`\s*(?:const|let|var|class)\s+/m.test(source)) {
    throw new Error('SIGNAL-CYCLE-03: backtick inválido antes de declaração JavaScript');
}

new vm.Script(source, { filename: __filename });
module._compile(source, __filename);
