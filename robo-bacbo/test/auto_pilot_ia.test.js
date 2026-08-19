'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizarConfigAutoTuning,
    wilsonLowerBound,
    minerarCandidatos,
    selecionarPortfolio,
    similaridadePadroes,
    avaliarDescarteLive,
    formatarLogDesativacaoAutoPilot,
    idCandidato
} = require('../auto_pilot_ia');

function giro(resultado, id, sessao = 1) {
    return { id, resultado, id_sessao: sessao, timestamp_ms: id * 1000, multiplicador: '' };
}

function repetir(bloco, vezes, inicio = 1) {
    const arr = [];
    let id = inicio;
    for (let n = 0; n < vezes; n++) {
        for (const resultado of bloco) arr.push(giro(resultado, id++));
    }
    return arr;
}

test('Wilson penaliza amostra perfeita pequena', () => {
    const pequeno = wilsonLowerBound(10, 10);
    const robusto = wilsonLowerBound(190, 200);
    assert.ok(pequeno < robusto);
    assert.ok(pequeno < 0.80);
    assert.ok(robusto > 0.90);
});

test('configuração mantém limites seguros e defaults compatíveis com a UI', () => {
    const cfg = normalizarConfigAutoTuning({ tam_min: 5, tam_max: 2, max_padroes: 0, perfil_selecao: 'x' });
    assert.equal(cfg.tam_min, 5);
    assert.equal(cfg.tam_max, 5);
    assert.equal(cfg.max_padroes, 1);
    assert.equal(cfg.perfil_selecao, 'BALANCEADO');
});

test('minerador identifica padrão recorrente e prefere o alvo sustentado pelos dados', () => {
    const historico = repetir(['Player', 'Banker', 'Player'], 40);
    const cfg = {
        ativo: true,
        range: 1000,
        tam_min: 2,
        tam_max: 2,
        assert_min: 90,
        ocorr_min: 20,
        gales: 0,
        proteger_empate: false,
        max_padroes: 4,
        shadow_giros: 0
    };
    const candidatos = minerarCandidatos(historico, cfg, { robo_id: 7 });
    const alvo = candidatos.find(c => c.padrao.join('|') === 'Player|Banker' && c.entrada === 'Player');
    assert.ok(alvo);
    assert.ok(alvo.ocorrencias >= 20);
    assert.equal(alvo.assertividade, 100);
    assert.ok(alvo.wilson > 80);
});

test('shadow impede promoção quando a janela recente contradiz o treino', () => {
    const treino = repetir(['Player', 'Banker', 'Player'], 35);
    const sombra = repetir(['Player', 'Banker', 'Banker'], 10, treino.length + 1);
    const historico = treino.concat(sombra);
    const cfg = {
        ativo: true,
        range: historico.length,
        tam_min: 2,
        tam_max: 2,
        assert_min: 90,
        ocorr_min: 15,
        gales: 0,
        proteger_empate: false,
        shadow_giros: sombra.length,
        drop_assert: 80
    };
    const candidatos = minerarCandidatos(historico, cfg, { robo_id: 3 });
    const alvo = candidatos.find(c => c.padrao.join('|') === 'Player|Banker' && c.entrada === 'Player');
    assert.ok(alvo);
    assert.equal(alvo.shadow_ok, false);
    assert.ok(alvo.shadow.ocorrencias >= 2);
    assert.ok(alvo.shadow.assertividade < 80);
});

test('portfolio respeita máximo e evita família redundante quando há alternativa', () => {
    const candidatos = [
        { id: 'a', score: 99, ocorrencias: 100, entrada: 'Player', padrao: ['Player','Banker','Player'] },
        { id: 'b', score: 98, ocorrencias: 120, entrada: 'Player', padrao: ['Banker','Player'] },
        { id: 'c', score: 97, ocorrencias: 90, entrada: 'Banker', padrao: ['Player','Player','Banker'] }
    ];
    assert.ok(similaridadePadroes(candidatos[0], candidatos[1]) >= 0.78);
    const portfolio = selecionarPortfolio(candidatos, 2, 'BALANCEADO');
    assert.equal(portfolio.length, 2);
    assert.equal(portfolio[0].id, 'a');
    assert.equal(portfolio[1].id, 'c');
});

test('ID do candidato é estável e muda quando muda a regra financeira', () => {
    const cfg = normalizarConfigAutoTuning({ gales: 2, proteger_empate: true });
    const a = idCandidato(1, ['Player','Banker'], 'Player', cfg);
    const b = idCandidato(1, ['Player','Banker'], 'Player', cfg);
    const c = idCandidato(1, ['Player','Banker'], 'Banker', cfg);
    assert.equal(a, b);
    assert.notEqual(a, c);
});

test('descarte live considera streak de RED e assertividade mínima', () => {
    const porReds = avaliarDescarteLive([
        { tipo_resultado: 'GREEN' },
        { tipo_resultado: 'RED' },
        { tipo_resultado: 'RED' }
    ], normalizarConfigAutoTuning({ drop_reds: 2, drop_assert: 0 }));
    assert.equal(porReds.descartar, true);
    assert.equal(porReds.motivo, 'DROP_REDS');

    const porAssert = avaliarDescarteLive([
        { tipo_resultado: 'GREEN' },
        { tipo_resultado: 'GREEN' },
        { tipo_resultado: 'RED' },
        { tipo_resultado: 'RED' },
        { tipo_resultado: 'RED' },
        { tipo_resultado: 'RED' }
    ], normalizarConfigAutoTuning({ ocorr_min: 5, drop_reds: 0, drop_assert: 70 }));
    assert.equal(porAssert.descartar, true);
    assert.equal(porAssert.motivo, 'DROP_ASSERT');
});


test('log de startup distingue Robô/Canal de Auto Pilot IA desativado', () => {
    const iaDesativada = formatarLogDesativacaoAutoPilot(
        { id: 1, nome: 'Bacbo Club' },
        'IA_DESATIVADA',
        0
    );
    assert.equal(
        iaDesativada,
        '🤖 Robô/Canal 1 — Bacbo Club: Auto Pilot IA desativado na configuração; '
            + '0 padrão(ões) dinâmico(s) ativo(s) desativado(s).'
    );
    assert.doesNotMatch(iaDesativada, /Auto Pilot IA 1:/);

    const roboDesativado = formatarLogDesativacaoAutoPilot(
        { id: 2, nome: 'Neurobet\nCanal' },
        'ROBO_DESATIVADO',
        3
    );
    assert.equal(
        roboDesativado,
        '🤖 Robô/Canal 2 — Neurobet Canal: Robô/Canal desativado; '
            + '3 padrão(ões) dinâmico(s) ativo(s) desativado(s).'
    );
});
