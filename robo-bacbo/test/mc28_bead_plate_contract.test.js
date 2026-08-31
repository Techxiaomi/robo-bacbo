const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
    path.join(
        __dirname,
        '..',
        'public',
        'bacbo-result-map.js'
    ),
    'utf8'
);

test('MC28: bead plate usa seis linhas e limites de colunas completas', () => {
    const rowsMatch =
        source.match(/const ROWS = (\d+);/);

    assert.ok(rowsMatch);
    assert.equal(Number(rowsMatch[1]), 6);

    const limitsMatch =
        source.match(/const LIMITS = \[([^\]]+)\];/);

    assert.ok(limitsMatch);

    const limits =
        limitsMatch[1]
            .split(',')
            .map(valor => Number(valor.trim()));

    assert.deepEqual(
        limits,
        [120, 300, 600, 1002]
    );

    for (const limit of limits) {
        assert.equal(
            limit % 6,
            0,
            `limite ${limit} quebra a grade de 6 linhas`
        );
    }
});

test('MC28: preferencia legada 1000 migra para 1002', () => {
    assert.match(
        source,
        /limiteSalvo === 1000[\s\S]*?\? 1002/
    );

    assert.match(
        source,
        /localStorage\.setItem\([\s\S]*?STORAGE_LIMIT,[\s\S]*?'1002'/
    );

    assert.match(
        source,
        /limit:\s*limiteInicial/
    );
});

test('MC28: renderer continua vertical em seis linhas', () => {
    assert.match(
        source,
        /grid-template-rows:repeat\(\$\{ROWS\}, 28px\)/
    );

    assert.match(
        source,
        /grid-auto-flow:column/
    );

    assert.match(
        source,
        /grid-auto-columns:28px/
    );
});