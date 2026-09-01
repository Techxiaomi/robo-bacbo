'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mesaContext = require('../mesa_context');
const financeiro = require('../mesa_financial_scope');
const root = path.join(__dirname, '..');

function comMesaEnv(valor, executar) {
    const anteriores = {
        BACBO_MESA_CODIGO: process.env.BACBO_MESA_CODIGO,
        BACBO_MESA_RUNTIME_ENABLED: process.env.BACBO_MESA_RUNTIME_ENABLED,
        TIPMINER_BACBO_ROUND_ID: process.env.TIPMINER_BACBO_ROUND_ID
    };

    try {
        process.env.BACBO_MESA_CODIGO = valor;
        delete process.env.BACBO_MESA_RUNTIME_ENABLED;
        delete process.env.TIPMINER_BACBO_ROUND_ID;
        return executar();
    } finally {
        for (const [chave, valorAnterior] of Object.entries(anteriores)) {
            if (valorAnterior === undefined) delete process.env[chave];
            else process.env[chave] = valorAnterior;
        }
    }
}

test('MC22-Z-E: BACBO_BR e identidade conhecida em pre-ativacao', () => {
    const br = mesaContext.resolverMesaConhecida('bacbo_br');
    assert.equal(br.codigo, 'BACBO_BR');
    assert.equal(br.tipo_jogo, 'BACBO');
    assert.equal(br.runtime_habilitado, false);
    assert.equal(br.runtime_ativacao_explicita, true);
    assert.equal(br.ativo_persistido, false);
});

test('MC22-Z-E: selecionar BACBO_BR continua fail-closed sem opt-in de runtime', () => {
    comMesaEnv('BACBO_BR', () => {
        assert.throws(
            () => mesaContext.mesaConfigurada(),
            erro => erro && erro.code === 'MESA_RUNTIME_ATIVACAO_EXPLICITA_AUSENTE'
        );
    });
});

test('MC22-Z-E: BACBO_INT continua runtime padrao e BR exige ativacao explicita', () => {
    assert.equal(mesaContext.MESAS_CONHECIDAS.BACBO_INT.runtime_habilitado, true);
    assert.equal(mesaContext.MESAS_CONHECIDAS.BACBO_BR.runtime_habilitado, false);
    assert.equal(mesaContext.MESAS_CONHECIDAS.BACBO_BR.runtime_ativacao_explicita, true);
    assert.equal(mesaContext.mesaPadrao().codigo, 'BACBO_INT');
});

test('MC22-Z-E: schema cadastra catalogo e preserva gate de ativacao BR', () => {
    const source = fs.readFileSync(path.join(root, 'mesa_schema.js'), 'utf8');
    assert.match(source, /Object\.values\(MESAS_CONHECIDAS\)/);
    assert.match(source, /ativo_persistido === true/);
    assert.match(source, /runtime_ativacao_explicita !== true/);
    assert.match(source, /SET ativo=false/);
    assert.match(source, /MESA_PERSISTIDA_INATIVA/);
});

test('MC22-Z-E: contrato financeiro reconhece INT e BR, sem liberar mesa desconhecida', () => {
    assert.equal(financeiro.mesaFinanceiraPermitida('BACBO_INT'), true);
    assert.equal(financeiro.mesaFinanceiraPermitida('BACBO_BR'), true);
    assert.equal(financeiro.mesaFinanceiraPermitida('BACBO_DESCONHECIDA'), false);

    const erro = financeiro.criarErroMesaFinanceira(
        'BACBO_DESCONHECIDA',
        'place_bet'
    );
    assert.equal(erro.code, 'MESA_FINANCEIRA_NAO_AUTORIZADA');
});
