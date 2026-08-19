'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const backend = fs.readFileSync(path.join(root, 'bot2_coletor.js'), 'utf8');
const motor = fs.readFileSync(path.join(root, 'auto_pilot_ia.js'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'public', 'dashboard-app.html'), 'utf8');

function blocoEntre(fonte, inicioTexto, fimTexto) {
    const inicio = fonte.indexOf(inicioTexto);
    assert.notEqual(inicio, -1, `marcador inicial ausente: ${inicioTexto}`);
    const fim = fonte.indexOf(fimTexto, inicio + inicioTexto.length);
    assert.notEqual(fim, -1, `marcador final ausente: ${fimTexto}`);
    return fonte.slice(inicio, fim);
}

test('Shadow Live possui histórico próprio e idempotente no MySQL', () => {
    assert.match(backend, /CREATE TABLE IF NOT EXISTS historico_shadow_ia/);
    assert.match(backend, /UNIQUE KEY uq_shadow_estrategia_giro \(estrategia_id, giro_resultado_id\)/);
    assert.match(backend, /ALTER TABLE estrategias ADD COLUMN ia_status VARCHAR\(30\) DEFAULT NULL/);
    assert.match(backend, /DELETE FROM historico_shadow_ia WHERE robo_id=\?/);
});

test('giro persistido entrega seu ID ao paper trading antes da próxima decisão', () => {
    assert.match(
        backend,
        /autoPilotIA\.registrarNovoGiro\(\{\s*giro_id:\s*giroIdPersistidoParaIA\s*\}\)/
    );
});

test('paper trading acompanha somente SHADOW_LIVE inativo e não chama canais ou executor', () => {
    const bloco = blocoEntre(
        motor,
        'async function registrarResultadosShadowLive(giroId)',
        'async function reconciliar(robo, config, candidatos)'
    );

    assert.match(bloco, /e\.ativo=false/);
    assert.match(bloco, /e\.ia_status='SHADOW_LIVE'/);
    assert.match(bloco, /INSERT IGNORE INTO historico_shadow_ia/);
    assert.match(bloco, /ia_status='REJEITADO'/);
    assert.doesNotMatch(bloco, /enviarMensagemTelegram|enviarOrdemAoExecutor|alerta_painel|historico_disparos_robos/);
});

test('checkpoint live encerra em APROVADO ou REJEITADO e libera reavaliação', () => {
    const avaliacao = blocoEntre(
        motor,
        'function avaliarShadowLive(metricasBrutas, configBruta = {})',
        'function combinarScoreShadowLive'
    );
    assert.match(avaliacao, /const concluido = metricas\.ocorrencias >= minimo/);
    assert.match(avaliacao, /const aprovado = concluido && metricas\.assertividade >= limiar/);
    assert.match(avaliacao, /const rejeitado = concluido && !aprovado/);

    const registro = blocoEntre(
        motor,
        'async function registrarResultadosShadowLive(giroId)',
        'async function reconciliar(robo, config, candidatos)'
    );
    assert.match(registro, /if \(avaliacao\.concluido\) robosReavaliacao\.add\(item\.robo_id\)/);
});

test('UI diferencia validação histórica de Shadow Live e persiste novos campos', () => {
    assert.match(ui, /Validação histórica \(últimos X giros\)/);
    assert.match(ui, /id="robo-ia-shadow-live"/);
    assert.match(ui, /id="robo-ia-shadow-live-max"/);
    assert.match(ui, /shadow_live_ocorrencias:/);
    assert.match(ui, /shadow_live_max_candidatos:/);
});
