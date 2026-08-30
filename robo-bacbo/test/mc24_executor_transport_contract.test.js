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

test('MC24-A: Redis encaminha identidade e pernas compostas ao executor', () => {
    assert.match(
        redisRuntime,
        /action:\s*'place_bet',\s*order_id:\s*orderId,\s*alvo:\s*dados\.alvo,\s*valor:\s*dados\.valor/s
    );

    assert.match(
        redisRuntime,
        /if\s*\(Array\.isArray\(dados\.apostas\).*comando\.apostas\s*=\s*dados\.apostas/s
    );
});
