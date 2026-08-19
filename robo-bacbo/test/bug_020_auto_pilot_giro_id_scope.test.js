'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backendPath = path.join(__dirname, '..', 'bot2_coletor.js');
const src = fs.readFileSync(backendPath, 'utf8');

test('BUG-020: insertId do giro sobrevive ao try e alimenta registrarNovoGiro', () => {
    const declaracaoFlag = src.indexOf('let giroPersistidoParaIA = false;');
    const declaracaoId = src.indexOf('let giroIdPersistidoParaIA = 0;', declaracaoFlag);
    const capturaId = src.indexOf(
        'giroIdPersistidoParaIA = Number(resultadoInsertGiro.insertId) || 0;',
        declaracaoId
    );
    const historicoId = src.indexOf('id: giroIdPersistidoParaIA,', capturaId);
    const registrar = src.indexOf(
        'if (giroPersistidoParaIA && giroIdPersistidoParaIA > 0)',
        historicoId
    );
    const callbackId = src.indexOf('giro_id: giroIdPersistidoParaIA', registrar);

    assert.ok(declaracaoFlag >= 0, 'flag de persistência precisa existir antes do INSERT');
    assert.ok(declaracaoId > declaracaoFlag, 'ID persistido precisa ser declarado fora do try do INSERT');
    assert.ok(capturaId > declaracaoId, 'insertId deve ser copiado para a variável externa após o INSERT');
    assert.ok(historicoId > capturaId, 'histórico em memória deve usar o mesmo ID persistido');
    assert.ok(registrar > historicoId, 'Auto Pilot só deve rodar após o giro ser persistido');
    assert.ok(callbackId > registrar, 'registrarNovoGiro deve receber o mesmo ID persistido');
});

test('BUG-020: callback periódico não referencia resultadoInsertGiro fora do bloco de persistência', () => {
    const marcador = 'if (giroPersistidoParaIA && giroIdPersistidoParaIA > 0)';
    const inicioCallback = src.indexOf(marcador);

    assert.ok(inicioCallback >= 0, 'guard do callback periódico precisa existir');

    const trechoCallback = src.slice(inicioCallback, inicioCallback + 700);
    assert.ok(
        trechoCallback.includes('giro_id: giroIdPersistidoParaIA'),
        'callback periódico precisa usar o ID persistido fora do try'
    );
    assert.ok(
        !trechoCallback.includes('resultadoInsertGiro.insertId'),
        'callback periódico não pode depender da variável block-scoped resultadoInsertGiro'
    );
});
