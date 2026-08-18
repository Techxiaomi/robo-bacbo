'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backendPath = path.join(__dirname, '..', 'bot2_coletor.js');
const src = fs.readFileSync(backendPath, 'utf8');

test('BUG-020: insertId persistido sobrevive ao escopo do try e alimenta a IA', () => {
    assert.match(src, /let\s+giroIdPersistidoParaIA\s*=\s*0\s*;/);
    assert.match(
        src,
        /giroIdPersistidoParaIA\s*=\s*Number\s*\(\s*resultadoInsertGiro\.insertId\s*\)\s*\|\|\s*0\s*;/
    );
    assert.match(src, /id\s*:\s*giroIdPersistidoParaIA\s*,/);
    assert.match(
        src,
        /if\s*\(\s*giroPersistidoParaIA\s*&&\s*giroIdPersistidoParaIA\s*>\s*0\s*\)/
    );
    assert.match(
        src,
        /autoPilotIA\.registrarNovoGiro\s*\(\s*\{\s*giro_id\s*:\s*giroIdPersistidoParaIA\s*\}\s*\)/
    );
});

test('BUG-020: callback periódico não referencia resultadoInsertGiro fora do try', () => {
    const chamadas = [
        ...src.matchAll(/autoPilotIA\.registrarNovoGiro\s*\(\s*\{[\s\S]{0,300}?\}\s*\)/g)
    ].map((match) => match[0]);

    assert.ok(chamadas.length >= 1, 'registrarNovoGiro deve existir no backend');

    const chamadaComGiroPersistido = chamadas.find((chamada) =>
        chamada.includes('giro_id: giroIdPersistidoParaIA')
    );

    assert.ok(chamadaComGiroPersistido, 'callback deve usar giroIdPersistidoParaIA');
    assert.equal(chamadaComGiroPersistido.includes('resultadoInsertGiro'), false);
});
