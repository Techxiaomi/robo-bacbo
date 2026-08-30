'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    numeroSoma,
    somaLegadaComprovavel,
    parearGirosCanonicos,
    construirReparos
} = require('../mc27_result_sum_integrity');

const ROOT = path.join(__dirname, '..');

function iso(ms) {
    return new Date(ms).toISOString();
}

test('MC27: soma desconhecida nunca vira zero', () => {
    assert.equal(numeroSoma(null), null);
    assert.equal(numeroSoma(undefined), null);
    assert.equal(numeroSoma(''), null);
    assert.equal(numeroSoma(false), null);
    assert.equal(numeroSoma(0), null);
    assert.equal(numeroSoma('0'), null);
    assert.equal(numeroSoma(1), null);
    assert.equal(numeroSoma(13), null);
    assert.equal(numeroSoma(2), 2);
    assert.equal(numeroSoma('8'), 8);
    assert.equal(numeroSoma(12), 12);
});

test('MC27: legado so recupera soma demonstravel pelo vencedor', () => {
    assert.equal(
        somaLegadaComprovavel({
            resultado: 'Player',
            p_d1: 3,
            p_d2: 4,
            b_d1: 6,
            b_d2: 6
        }),
        7
    );

    assert.equal(
        somaLegadaComprovavel({
            resultado: 'Banker',
            p_d1: 6,
            p_d2: 6,
            b_d1: 2,
            b_d2: 5
        }),
        7
    );

    assert.equal(
        somaLegadaComprovavel({
            resultado: 'Tie',
            p_d1: 0,
            p_d2: 0,
            b_d1: 0,
            b_d2: 0,
            numero_empate: 8
        }),
        8
    );

    assert.equal(
        somaLegadaComprovavel({
            resultado: 'Player',
            p_d1: 0,
            p_d2: 0
        }),
        null
    );
});

test('MC27: pareamento canonico exige vencedor e janela temporal segura', () => {
    const base = Date.parse('2026-08-30T20:00:00.000Z');

    const giros = [
        {
            id: 101,
            resultado: 'Player',
            data_hora: new Date(base)
        },
        {
            id: 102,
            resultado: 'Banker',
            data_hora: new Date(base + 10000)
        }
    ];

    const canonicos = [
        {
            uuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            winner: 'Player',
            result: 8,
            instant: iso(base + 250)
        },
        {
            uuid: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
            winner: 'Banker',
            result: 5,
            instant: iso(base + 10200)
        }
    ];

    const pares = parearGirosCanonicos(giros, canonicos);

    assert.equal(pares.size, 2);
    assert.deepEqual(pares.get(101), {
        soma: 8,
        round_uuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        distancia_ms: 250
    });
    assert.equal(pares.get(102).soma, 5);
});

test('MC27: pareamento ambiguo fica sem prova e nao grava soma', () => {
    const base = Date.parse('2026-08-30T20:00:00.000Z');

    const giros = [{
        id: 501,
        resultado: 'Player',
        data_hora: new Date(base)
    }];

    const canonicos = [
        {
            uuid: '11111111-1111-1111-1111-111111111111',
            winner: 'Player',
            result: 4,
            instant: iso(base - 300)
        },
        {
            uuid: '22222222-2222-2222-2222-222222222222',
            winner: 'Player',
            result: 9,
            instant: iso(base + 300)
        }
    ];

    const pares = parearGirosCanonicos(giros, canonicos);
    assert.equal(pares.size, 0);

    const reparos = construirReparos(giros, canonicos);
    assert.deepEqual(reparos, []);
});

test('MC27: bootstrap e UI carregam as protecoes novas', () => {
    const start = fs.readFileSync(
        path.join(ROOT, 'start.js'),
        'utf8'
    );

    const index = fs.readFileSync(
        path.join(ROOT, 'public', 'index.html'),
        'utf8'
    );

    const ui = fs.readFileSync(
        path.join(ROOT, 'public', 'bacbo-result-sum-integrity.js'),
        'utf8'
    );

    assert.match(
        start,
        /await instalarIntegridadeSomaResultados\(\)/
    );

    assert.ok(
        start.indexOf('definirMesaRuntime(mesaAtual)')
        < start.indexOf('await instalarIntegridadeSomaResultados()'),
        'MC27 so pode iniciar depois de fixar a mesa runtime'
    );

    assert.match(
        index,
        /<script src="\/bacbo-result-map\.js"><\/script>\s*<script src="\/bacbo-result-sum-integrity\.js"><\/script>/
    );

    assert.match(
        index,
        /__mc27ResultSumIntegrityReady/
    );

    assert.match(
        ui,
        /n >= 2 && n <= 12/
    );

    assert.match(
        ui,
        /cell\.textContent = '—'/
    );

    assert.match(
        ui,
        /sequenciaExata/
    );

    assert.match(
        ui,
        /partes\[1\] = soma === null \? 'N\/D'/
    );
});

test('MC27: persistencia e backfill sao fail-closed', () => {
    const fonte = fs.readFileSync(
        path.join(ROOT, 'mc27_result_sum_integrity.js'),
        'utf8'
    );

    assert.match(
        fonte,
        /resultado_soma TINYINT UNSIGNED NULL/
    );

    assert.match(
        fonte,
        /round_uuid CHAR\(36\) NULL/
    );

    assert.match(
        fonte,
        /AND resultado_soma IS NULL/
    );

    assert.match(
        fonte,
        /FROM bacbo_rounds/
    );

    assert.doesNotMatch(
        fonte,
        /SET\s+p_d1\s*=/
    );

    assert.doesNotMatch(
        fonte,
        /SET\s+p_d2\s*=/
    );

    assert.doesNotMatch(
        fonte,
        /SET\s+b_d1\s*=/
    );

    assert.doesNotMatch(
        fonte,
        /SET\s+b_d2\s*=/
    );
});
