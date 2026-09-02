'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

const bot2 = fs.readFileSync(
    path.join(root, 'bot2_coletor.js'),
    'utf8'
);

const redisRuntime = fs.readFileSync(
    path.join(root, 'redis_runtime_v3.js'),
    'utf8'
);

test('MC24-A: plano composto preserva identidade alvo/valor no transporte', () => {
    assert.match(
        bot2,
        /body:\s*JSON\.stringify\(\{\s*order_id:\s*orderId,\s*alvo,\s*valor,/s
    );

    assert.doesNotMatch(
        bot2,
        /JSON\.stringify\(Array\.isArray\(apostas\)/
    );
});

test('MC24-A: Signal Router recebe identidade e pernas compostas do runtime', () => {
    assert.match(
        redisRuntime,
        /const signal = buildPlaceBetSignal\(\{\s*signal_id:\s*orderId,\s*source:\s*'bot2_coletor',\s*event_id:\s*orderId,\s*table_key:\s*tableKey,\s*alvo:\s*dados\.alvo,\s*valor_base:\s*dados\.valor,/s
    );

    assert.match(
        redisRuntime,
        /\.\.\.\(Array\.isArray\(dados\.apostas\)\s*&&\s*dados\.apostas\.length\s*>\s*0\s*\?\s*\{\s*apostas:\s*dados\.apostas\s*\}\s*:\s*\{\}\)/
    );

    assert.match(
        redisRuntime,
        /publisher\.publish\(GLOBAL_SIGNAL_CHANNEL,\s*JSON\.stringify\(signal\)\)/
    );

    assert.doesNotMatch(
        redisRuntime,
        /REDIS_COMMAND_CHANNEL/
    );
});
