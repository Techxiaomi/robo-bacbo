'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    auditarEstruturas
} = require('../scripts/audit_strategy_profiles');

test('auditoria detecta origem e robô misturados', () => {
    const report =
        auditarEstruturas({
            origens: [
                {
                    id: 10,
                    mesa_id: 1,
                    nome: 'A'
                }
            ],

            estrategias: [
                {
                    id: 'p1',
                    mesa_id: 1,
                    nome: 'P1',
                    origem: 'A',
                    gales: 2,
                    proteger_empate: false,
                    is_dinamico: false
                },
                {
                    id: 'p2',
                    mesa_id: 1,
                    nome: 'P2',
                    origem: 'A',
                    gales: 1,
                    proteger_empate: false,
                    is_dinamico: false
                }
            ],

            robos: [
                {
                    id: 7,
                    mesa_id: 1,
                    nome: 'R7',
                    ativo: true,

                    config_json:
                        JSON.stringify({
                            origens: ['A'],
                            avulsos: [],
                            excecoes: []
                        })
                }
            ]
        });

    assert.equal(report.ok, false);

    assert.equal(
        report.origins[0].status,
        'INCONSISTENT'
    );

    assert.equal(
        report.robots[0].status,
        'INCONSISTENT'
    );
});

test('auditoria respeita exceção na sintonia do robô', () => {
    const report =
        auditarEstruturas({
            origens: [
                {
                    id: 10,
                    mesa_id: 1,
                    nome: 'A'
                }
            ],

            estrategias: [
                {
                    id: 'g2',
                    mesa_id: 1,
                    origem: 'A',
                    gales: 2,
                    proteger_empate: false,
                    is_dinamico: false
                },
                {
                    id: 'g1',
                    mesa_id: 1,
                    origem: 'A',
                    gales: 1,
                    proteger_empate: false,
                    is_dinamico: false
                }
            ],

            robos: [
                {
                    id: 7,
                    mesa_id: 1,
                    nome: 'R7',
                    ativo: true,

                    config_json:
                        JSON.stringify({
                            origens: ['A'],
                            avulsos: [],
                            excecoes: ['g1']
                        })
                }
            ]
        });

    assert.equal(
        report.origins[0].status,
        'INCONSISTENT'
    );

    assert.equal(
        report.robots[0].status,
        'CONSISTENT'
    );

    assert.equal(
        report.robots[0]
            .canonical_profile,
        'G2_SEM_EMPATE'
    );
});

test('auditor importa a política SSOT em vez de duplicá-la', () => {
    const source =
        fs.readFileSync(
            path.join(
                __dirname,
                '..',
                'scripts',
                'audit_strategy_profiles.js'
            ),
            'utf8'
        );

    assert.match(
        source,
        /require\('\.\.\/strategy_profile_policy'\)/
    );

    assert.doesNotMatch(
        source,
        /function\s+perfilDaEstrategia\s*\(/
    );

    assert.doesNotMatch(
        source,
        /function\s+roboSintonizaEstrategia\s*\(/
    );
});

test('auditor permanece estritamente read-only', () => {
    const source =
        fs.readFileSync(
            path.join(
                __dirname,
                '..',
                'scripts',
                'audit_strategy_profiles.js'
            ),
            'utf8'
        );

    assert.doesNotMatch(
        source,
        /\b(?:INSERT\s+INTO|UPDATE\s+\w+|DELETE\s+FROM|ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+TABLE|TRUNCATE\s+TABLE|REPLACE\s+INTO)\b/i
    );

    assert.match(
        source,
        /FROM origens/
    );

    assert.match(
        source,
        /FROM estrategias/
    );

    assert.match(
        source,
        /FROM robos_canais/
    );
});
