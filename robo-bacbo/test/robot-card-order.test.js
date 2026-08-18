const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const uiJs = fs.readFileSync(path.join(root, 'public', 'ui-enhancements.js'), 'utf8');

function carregarUI() {
    const sandbox = {
        window: {},
        document: {},
        Number,
        Object,
        Array,
        String,
        Math,
        Date,
        console
    };
    vm.runInNewContext(uiJs, sandbox, { filename: 'ui-enhancements.js' });
    return sandbox.window;
}

function detalhes({ green = 0, g1 = 0, g2 = 0, red = 0, tie = 0, maxGreen = 0, maxRed = 0 } = {}) {
    return {
        green_direto: green,
        gale1: g1,
        gale2: g2,
        red,
        ties: { direto: tie ? { '4x': tie } : {}, gale1: {}, gale2: {} },
        max_green_seq: maxGreen,
        max_red_seq: maxRed
    };
}

function robo(id, nome, ativo, h24, geral = h24) {
    return {
        id,
        nome,
        ativo,
        detalhes: { '24h': h24, hoje: h24, semana: h24, mes: h24, geral }
    };
}

const base = [
    robo(7, 'Bravo', true, detalhes({ green: 3, red: 1, maxGreen: 3, maxRed: 1 }), detalhes({ green: 5, red: 5, maxGreen: 3, maxRed: 4 })),
    robo(8, 'Alpha', false, detalhes({ green: 2, red: 0, maxGreen: 2, maxRed: 0 }), detalhes({ green: 8, red: 2, maxGreen: 6, maxRed: 1 })),
    robo(9, 'Charlie', true, detalhes({ green: 2, red: 4, maxGreen: 2, maxRed: 3 }), detalhes({ green: 9, red: 1, maxGreen: 7, maxRed: 1 }))
];

test('UX-006B: Ativos primeiro é estável e não modifica a lista original', () => {
    const ui = carregarUI();
    const original = base.map(r => r.id);
    const ordenados = ui.ux006OrdenarRobos(base, 'status', '24h');

    assert.deepEqual(Array.from(ordenados, r => r.nome), ['Bravo', 'Charlie', 'Alpha']);
    assert.deepEqual(base.map(r => r.id), original);
});

test('UX-006B: ordena por nome e ordem de cadastro via id', () => {
    const ui = carregarUI();
    assert.deepEqual(Array.from(ui.ux006OrdenarRobos(base, 'nome', '24h'), r => r.nome), ['Alpha', 'Bravo', 'Charlie']);
    assert.deepEqual(Array.from(ui.ux006OrdenarRobos(base, 'recentes', '24h'), r => r.id), [9, 8, 7]);
    assert.deepEqual(Array.from(ui.ux006OrdenarRobos(base, 'antigos', '24h'), r => r.id), [7, 8, 9]);
});

test('UX-006B: critérios estatísticos usam o período informado', () => {
    const ui = carregarUI();

    assert.deepEqual(Array.from(ui.ux006OrdenarRobos(base, 'assert', '24h'), r => r.nome), ['Alpha', 'Bravo', 'Charlie']);
    assert.deepEqual(Array.from(ui.ux006OrdenarRobos(base, 'entradas', '24h'), r => r.nome), ['Charlie', 'Bravo', 'Alpha']);
    assert.deepEqual(Array.from(ui.ux006OrdenarRobos(base, 'max_green', '24h'), r => r.nome), ['Bravo', 'Alpha', 'Charlie']);
    assert.deepEqual(Array.from(ui.ux006OrdenarRobos(base, 'max_red', '24h'), r => r.nome), ['Charlie', 'Bravo', 'Alpha']);

    assert.deepEqual(Array.from(ui.ux006OrdenarRobos(base, 'assert', 'geral'), r => r.nome), ['Charlie', 'Alpha', 'Bravo']);
    assert.deepEqual(Array.from(ui.ux006OrdenarRobos(base, 'max_green', 'geral'), r => r.nome), ['Charlie', 'Alpha', 'Bravo']);
});

test('UX-006B: critério desconhecido cai com segurança em Ativos primeiro', () => {
    const ui = carregarUI();
    assert.deepEqual(Array.from(ui.ux006OrdenarRobos(base, 'inexistente', '24h'), r => r.nome), ['Bravo', 'Charlie', 'Alpha']);
});
