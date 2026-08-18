'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizarConfigAutoTuning,
    avaliarShadowLive,
    combinarScoreShadowLive
} = require('../auto_pilot_ia');

test('shadow live permanece compatível quando configuração não existe', () => {
    const cfg = normalizarConfigAutoTuning({});
    assert.equal(cfg.shadow_live_ocorrencias, 0);
    assert.equal(cfg.shadow_live_max_candidatos, 10);
    const r = avaliarShadowLive({ ocorrencias: 0, greens: 0, ties: 0, reds: 0 }, cfg);
    assert.equal(r.ativo, false);
    assert.equal(r.ok, true);
    assert.equal(r.aprovado, true);
    assert.equal(r.rejeitado, false);
});

test('shadow live usa mínimo de ocorrências como checkpoint definitivo', () => {
    const cfg = normalizarConfigAutoTuning({
        assert_min: 95,
        drop_assert: 85,
        shadow_live_ocorrencias: 10,
        shadow_live_max_candidatos: 10
    });

    const pendente = avaliarShadowLive({ ocorrencias: 9, greens: 9, ties: 0, reds: 0 }, cfg);
    assert.equal(pendente.ok, false);
    assert.equal(pendente.concluido, false);
    assert.equal(pendente.aprovado, false);
    assert.equal(pendente.rejeitado, false);
    assert.equal(pendente.restantes, 1);

    const aprovado = avaliarShadowLive({ ocorrencias: 10, greens: 9, ties: 0, reds: 1 }, cfg);
    assert.equal(aprovado.ok, true);
    assert.equal(aprovado.concluido, true);
    assert.equal(aprovado.aprovado, true);
    assert.equal(aprovado.rejeitado, false);
    assert.equal(aprovado.assertividade, 90);
    assert.ok(aprovado.wilson > 0 && aprovado.wilson < 90);

    const rejeitado = avaliarShadowLive({ ocorrencias: 10, greens: 8, ties: 0, reds: 2 }, cfg);
    assert.equal(rejeitado.ok, false);
    assert.equal(rejeitado.concluido, true);
    assert.equal(rejeitado.aprovado, false);
    assert.equal(rejeitado.rejeitado, true);
    assert.equal(rejeitado.restantes, 0);
});

test('score após shadow live incorpora Wilson e penaliza degradação relevante', () => {
    const bom = combinarScoreShadowLive(92, {
        ocorrencias: 12, greens: 11, ties: 0, reds: 1,
        assertividade: (11 / 12) * 100,
        wilson: 64.6
    }, 96);
    const ruim = combinarScoreShadowLive(92, {
        ocorrencias: 12, greens: 9, ties: 0, reds: 3,
        assertividade: 75,
        wilson: 46.8
    }, 96);
    assert.ok(bom > ruim);
    assert.ok(bom <= 100 && ruim >= 0);
});
