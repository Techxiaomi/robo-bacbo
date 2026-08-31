const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

const botSource = fs.readFileSync(
    path.join(root, 'bot2_coletor.js'),
    'utf8'
);

const presenterSource = fs.readFileSync(
    path.join(root, 'telegram_signal_presenter.js'),
    'utf8'
);

test('MC29: nivel final e fotografado antes do envio async', () => {
    const snapshot =
        'const nivelResultadoTelegram = st.galeAtual;';

    const envio =
        "void enviarTelegramParaInscritos('GREEN', est, st, extrasFinal)";

    assert.equal(
        (botSource.match(
            /const nivelResultadoTelegram = st\.galeAtual;/g
        ) || []).length,
        1
    );

    assert.ok(botSource.includes(snapshot));
    assert.ok(botSource.includes(envio));

    assert.ok(
        botSource.indexOf(snapshot) <
        botSource.indexOf(envio)
    );
});

test('MC29: payload final carrega o nivel fotografado', () => {
    assert.match(
        botSource,
        /const extrasFinal = \{[\s\S]*?nivel_resultado: nivelResultadoTelegram,[\s\S]*?resultado: isTie \? 'TIE' : 'GREEN'/
    );
});

test('MC29: formatter prefere snapshot em vez do estado mutavel', () => {
    assert.ok(
        botSource.includes(
            'rotuloNivelTelegram(extras.nivel_resultado ?? estado.galeAtual)'
        )
    );

    assert.equal(
        botSource.includes(
            'rotuloNivelTelegram(estado.galeAtual)'
        ),
        false
    );
});

test('MC29: reset do ciclo nao consegue mais rebaixar Gale para Direto', () => {
    assert.match(
        botSource,
        /function finalizarEstadoSinal[\s\S]*?estado\.galeAtual = 0;/
    );

    assert.ok(
        botSource.includes(
            'nivel_resultado: nivelResultadoTelegram'
        )
    );
});

test('MC29: presenter conserva semantica Principal Gale 1 Gale 2', () => {
    assert.match(
        presenterSource,
        /etapa === 'DIRETO'[\s\S]*?Entrada: Principal/
    );

    assert.match(
        presenterSource,
        /Entrada: Gale \$\{nivel\}/
    );

    assert.match(
        presenterSource,
        /GALE\\s\*\(\\d\+\)/
    );
});

test('MC29: Telegram continua fire-and-forget no resultado', () => {
    assert.match(
        botSource,
        /void enviarTelegramParaInscritos\('GREEN', est, st, extrasFinal\)\.catch/
    );
});