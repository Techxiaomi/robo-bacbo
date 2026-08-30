const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

const appHtml = fs.readFileSync(
    path.join(root, 'public', 'dashboard-app.html'),
    'utf8'
);

const backend = fs.readFileSync(
    path.join(root, 'bot2_coletor.js'),
    'utf8'
);

test('MC20: toggle de padrão serializa o formato da API corretamente', () => {
    assert.match(
        appHtml,
        /function serializarPadraoEstrategiaParaApi\(est\)/
    );

    assert.match(
        appHtml,
        /const convertido = JSON\.parse\(texto\)/
    );

    assert.match(
        appHtml,
        /protegerEmpate:\s*estrategiaProtegeEmpate\(/
    );

    assert.doesNotMatch(
        appHtml,
        /padrao:\s*e\.padrao\.join\(/
    );

    assert.match(
        appHtml,
        /await inicializarSistema\(\)/
    );
});

test('MC20: lixeira possui ação frontend real', () => {
    assert.match(
        appHtml,
        /async function excluirEstrategia\(id\)/
    );

    assert.match(
        appHtml,
        /method:\s*'DELETE'/
    );

    assert.match(
        appHtml,
        /Padrões dinâmicos pertencem ao Robô IA/
    );
});

test('MC20: backend impede exclusão individual de padrão dinâmico', () => {
    assert.match(
        backend,
        /SELECT id, nome, is_dinamico FROM estrategias WHERE id=\? AND mesa_id=\? LIMIT 1/
    );

    assert.match(
        backend,
        /padrao_dinamico_gerenciado_pelo_robo/
    );

    assert.match(
        backend,
        /return res\.status\(409\)/
    );
});

test('MC20: religamento de robô gera log operacional explícito', () => {
    assert.match(
        backend,
        /if \(reativando\)/
    );

    assert.match(
        backend,
        /Robô\/Canal \$\{id\} — \$\{nome\}: reativado/
    );

    assert.match(
        backend,
        /padrão\(ões\) dinâmico\(s\) ativo\(s\) liberado\(s\)/
    );
});
