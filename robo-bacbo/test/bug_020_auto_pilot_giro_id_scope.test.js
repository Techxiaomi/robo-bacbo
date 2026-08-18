'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backendPath = path.join(__dirname, '..', 'bot2_coletor.js');
const src = fs.readFileSync(backendPath, 'utf8');

test('BUG-020: insertId é capturado fora do try e reutilizado no ciclo IA', () => {
    const idxFlag = src.indexOf('let giroPersistidoParaIA = false;');
    const idxId = src.indexOf('let giroIdPersistidoParaIA = 0;', idxFlag);
    const idxCapture = src.indexOf(
        'giroIdPersistidoParaIA = Number(resultadoInsertGiro.insertId) || 0;',
        idxId
    );
    const idxHistory = src.indexOf('id: giroIdPersistidoParaIA', idxCapture);
    const idxIf = src.indexOf(
        'if (giroPersistidoParaIA && giroIdPersistidoParaIA > 0)',
        idxHistory
    );
    const idxCall = src.indexOf('autoPilotIA.registrarNovoGiro', idxIf);

    assert.ok(idxFlag >= 0);
    assert.ok(idxId > idxFlag);
    assert.ok(idxCapture > idxId);
    assert.ok(idxHistory > idxCapture);
    assert.ok(idxIf > idxHistory);
    assert.ok(idxCall > idxIf);
});

test('BUG-020: resultadoInsertGiro não vaza para o bloco periódico', () => {
    const idxIf = src.indexOf(
        'if (giroPersistidoParaIA && giroIdPersistidoParaIA > 0)'
    );
    const idxFim = src.indexOf('let sinalFinalizadoAgora = false;', idxIf);

    assert.ok(idxIf >= 0);
    assert.ok(idxFim > idxIf);

    const trecho = src.slice(idxIf, idxFim);
    assert.equal(trecho.includes('resultadoInsertGiro'), false);
    assert.equal(trecho.includes('giro_id: giroIdPersistidoParaIA'), true);
});
