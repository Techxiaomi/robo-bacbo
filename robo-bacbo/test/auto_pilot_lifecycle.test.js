'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { criarAutoPilotService } = require('../auto_pilot_ia');
const { definirMesaRuntime } = require('../mesa_runtime_context');

definirMesaRuntime({
    id: 1,
    codigo: 'BACBO_INT',
    nome: 'Bac Bo Internacional',
    tipo_jogo: 'BACBO'
});

function criarDbRoboDesativado() {
    const chamadas = [];
    return {
        chamadas,
        async query(sql, params) {
            chamadas.push({ sql: String(sql), params });
            if (String(sql).includes('SELECT * FROM robos_canais WHERE id=? AND mesa_id=? LIMIT 1')) {
                return [[{
                    id: 1,
                    nome: 'IA teste',
                    ativo: 1,
                    config_json: JSON.stringify({ auto_tuning: { ativo: false } })
                }]];
            }
            if (String(sql).includes('UPDATE estrategias SET ativo=false')) {
                return [{ affectedRows: 2 }];
            }
            if (String(sql).includes('SELECT id, config_json FROM robos_canais WHERE mesa_id=? AND ativo=true')) {
                return [[]];
            }
            throw new Error(`SQL inesperado no fake: ${sql}`);
        }
    };
}

test('desligar Auto Pilot desativa padrões IA filhos já ativos', async () => {
    const dbPool = criarDbRoboDesativado();
    let recargas = 0;
    let notificacoes = 0;
    const service = criarAutoPilotService({
        dbPool,
        estaOcupado: () => false,
        recarregarMemoria: async () => { recargas++; },
        notificar: () => { notificacoes++; },
        log: { log() {}, warn() {}, error() {} }
    });

    const resultado = await service.executarRobo(1, { forcar: true, motivo: 'teste' });
    assert.equal(resultado.executado, true);
    assert.equal(resultado.desativado, true);
    assert.equal(resultado.desativados, 2);
    assert.equal(recargas, 1);
    assert.equal(notificacoes, 1);
    assert.ok(dbPool.chamadas.some(c => c.sql.includes('UPDATE estrategias SET ativo=false')));
});

test('mudança forçada durante sinal fica pendente e é aplicada no próximo giro seguro', async () => {
    const dbPool = criarDbRoboDesativado();
    let ocupado = true;
    const service = criarAutoPilotService({
        dbPool,
        estaOcupado: () => ocupado,
        recarregarMemoria: async () => {},
        notificar: () => {},
        log: { log() {}, warn() {}, error() {} }
    });

    const adiado = await service.executarRobo(1, { forcar: true, motivo: 'config_edicao' });
    assert.equal(adiado.adiado, true);
    assert.equal(dbPool.chamadas.length, 0);

    ocupado = false;
    await service.registrarNovoGiro();
    assert.ok(dbPool.chamadas.some(c => c.sql.includes('UPDATE estrategias SET ativo=false')));
});

test('backend reavalia descarte live depois de finalizar padrão dinâmico', () => {
    const backend = fs.readFileSync(path.join(__dirname, '..', 'bot2_coletor.js'), 'utf8');
    assert.match(backend, /est\.is_dinamico[\s\S]{0,400}autoPilotIA\.reavaliarDescarteEstrategia\(est\.id\)/);
    assert.match(backend, /DELETE FROM historico_resultados\s+WHERE mesa_id=\?\s+AND LEFT\(estrategia_id, \?\) = \?/);
});

test('motor preserva reputação live ao expirar definição do padrão', () => {
    const engine = fs.readFileSync(path.join(__dirname, '..', 'auto_pilot_ia.js'), 'utf8');
    const inicio = engine.indexOf('for (const existente of existentes)');
    const fim = engine.indexOf('await conexao.commit()', inicio);
    assert.ok(inicio >= 0 && fim > inicio);
    const bloco = engine.slice(inicio, fim);
    assert.doesNotMatch(bloco, /DELETE FROM historico_resultados/);
    assert.match(bloco, /DELETE FROM estrategias/);
});
