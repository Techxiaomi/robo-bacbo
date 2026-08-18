'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backendPath = path.join(__dirname, '..', 'bot2_coletor.js');
const src = fs.readFileSync(backendPath, 'utf8');

test('BUG-020: insertId do giro sobrevive ao try e alimenta registrarNovoGiro', () => {
    assert.ok(src.includes('let giroPersistidoParaIA = false;'));
    assert.ok(src.includes('let giroIdPersistidoParaIA = 0;'));
    assert.ok(src.includes('const [resultadoInsertGiro] = await dbPool.query('));
    assert.ok(src.includes('giroIdPersistidoParaIA = Number(resultadoInsertGiro.insertId) || 0;'));
    assert.ok(src.includes('id: giroIdPersistidoParaIA,'));
    assert.ok(src.includes('if (giroPersistidoParaIA && giroIdPersistidoParaIA > 0) {'));
    assert.ok(src.includes('await autoPilotIA.registrarNovoGiro({ giro_id: giroIdPersistidoParaIA });'));
});

test('BUG-020: resultadoInsertGiro não é referenciado no bloco periódico fora do try', () => {
    const marcador = 'if (giroPersistidoParaIA && giroIdPersistidoParaIA > 0)';
    const inicio = src.indexOf(marcador);
    assert.ok(inicio >= 0);
    const trecho = src.slice(inicio, inicio + 500);
    assert.equal(trecho.includes('resultadoInsertGiro'), false);
});
