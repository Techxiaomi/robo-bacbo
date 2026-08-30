'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ENV_REDIS_MESA = [
    'REDIS_BACBO_EVENTS_CHANNEL',
    'REDIS_BACBO_HISTORY_KEY',
    'REDIS_BACBO_LATEST_ROUND_KEY',
    'REDIS_BACBO_HISTORY_ACK_KEY',
    'REDIS_BACBO_ROAD_SNAPSHOT_KEY',
    'REDIS_BACBO_RECENT_ROUNDS_KEY'
];

// O teste deve provar os defaults can?nicos, independentemente
// de customiza??es existentes no ambiente do desenvolvedor.
for (const chave of ENV_REDIS_MESA) {
    delete process.env[chave];
}

const {
    definirMesaRuntime
} = require('../mesa_runtime_context');

definirMesaRuntime({
    id: 991,
    codigo: 'BACBO_INT',
    nome: 'Mesa Gate MC22',
    tipo_jogo: 'BACBO'
});

const {
    obterEscopoRedisMesa
} = require('../mesa_redis_scope');

const redisRuntimeV3 =
    require('../redis_runtime_v3');

const root = path.join(__dirname, '..');

test('MC22-Y-B: nomes Redis can?nicos s?o isolados pela mesa runtime', () => {
    const escopo = obterEscopoRedisMesa();

    assert.equal(escopo.mesaId, 991);
    assert.equal(escopo.codigo, 'BACBO_INT');

    assert.equal(
        escopo.eventsChannel,
        'bacbo_events:BACBO_INT'
    );

    assert.equal(
        escopo.historyKey,
        'bacbo_history:BACBO_INT'
    );

    assert.equal(
        escopo.latestRoundKey,
        'bacbo_latest_round:BACBO_INT'
    );

    assert.equal(
        escopo.historyAckKey,
        'robo_bacbo:history_applied_signature:BACBO_INT'
    );

    assert.equal(
        escopo.roadSnapshotKey,
        'robo_bacbo:last_road_snapshot:BACBO_INT'
    );

    assert.equal(
        escopo.recentRoundsKey,
        'robo_bacbo:recent_rounds_v3:BACBO_INT'
    );
});

test('MC22-Y-B: base j? escopada n?o recebe sufixo duplicado', () => {
    process.env.REDIS_BACBO_EVENTS_CHANNEL =
        'canal_custom:BACBO_INT';

    try {
        const escopo = obterEscopoRedisMesa();

        assert.equal(
            escopo.eventsChannel,
            'canal_custom:BACBO_INT'
        );

        assert.doesNotMatch(
            escopo.eventsChannel,
            /:BACBO_INT:BACBO_INT$/i
        );
    } finally {
        delete process.env.REDIS_BACBO_EVENTS_CHANNEL;
    }
});

test('MC22-Y-B: Runtime V3 rejeita evento sem mesa ou de outra mesa', async () => {
    const base = {
        action: 'live_round',
        data: {
            uuid: 'mc22-yb-gate-round',
            type: 'PLAYER',
            result: 7,
            instant: '2026-08-30T00:00:00.000Z'
        }
    };

    assert.equal(
        await redisRuntimeV3.processarBacbo(
            JSON.stringify(base)
        ),
        false
    );

    assert.equal(
        await redisRuntimeV3.processarBacbo(
            JSON.stringify({
                ...base,
                mesa_codigo: 'MESA_TESTE_2'
            })
        ),
        false
    );
});

test('MC22-Y-B: payload entregue ao backend carrega identidade da mesa', () => {
    const payload = redisRuntimeV3.payloadNode({
        uuid: 'mc22-yb-payload',
        type: 'PLAYER',
        result: 8,
        instant: '2026-08-30T00:00:00.000Z',
        timestamp_ms: 1788048000000,
        winner_legacy: 'PlayerWon',
        winner: 'Player',
        winner_symbol: 'P'
    });

    assert.equal(payload.mesa_id, 991);
    assert.equal(payload.mesa_codigo, 'BACBO_INT');

    assert.equal(
        payload.redis_channel,
        'bacbo_events:BACBO_INT'
    );
});

test('MC22-Y-B: history, ACK, mapa e ROAD usam escopo de mesa', () => {
    const historySource = fs.readFileSync(
        path.join(root, 'tipminer_history_sync.js'),
        'utf8'
    );

    const mapSource = fs.readFileSync(
        path.join(root, 'bacbo_map_snapshot.js'),
        'utf8'
    );

    assert.match(
        historySource,
        /ESCOPO_REDIS_MESA\.eventsChannel/
    );

    assert.match(
        historySource,
        /ESCOPO_REDIS_MESA\.historyKey/
    );

    assert.match(
        historySource,
        /ESCOPO_REDIS_MESA\.historyAckKey/
    );

    assert.match(
        historySource,
        /mesa_codigo:\s*ESCOPO_REDIS_MESA\.codigo/
    );

    assert.match(
        historySource,
        /mesaCodigo\s*!==\s*ESCOPO_REDIS_MESA\.codigo/
    );

    assert.match(
        mapSource,
        /ESCOPO_REDIS_MESA\.recentRoundsKey/
    );

    assert.match(
        mapSource,
        /ESCOPO_REDIS_MESA\.historyKey/
    );

    assert.match(
        mapSource,
        /ESCOPO_REDIS_MESA\.eventsChannel/
    );

    assert.match(
        mapSource,
        /FROM bacbo_rounds[\s\S]{0,120}WHERE mesa_id=\?/
    );

    assert.match(
        mapSource,
        /mesaCodigo\s*!==\s*ESCOPO_REDIS_MESA\.codigo/
    );
});

test('MC22-Y-B: Redis financeiro do executor permanece global', () => {
    const source = fs.readFileSync(
        path.join(root, 'redis_runtime_v3.js'),
        'utf8'
    );

    assert.match(
        source,
        /const REDIS_COMMAND_CHANNEL = 'auto_trader_commands';/
    );

    assert.match(
        source,
        /const REDIS_RESPONSE_CHANNEL = 'auto_trader_responses';/
    );

    assert.doesNotMatch(
        source,
        /REDIS_COMMAND_CHANNEL\s*=\s*ESCOPO_REDIS_MESA/
    );

    assert.doesNotMatch(
        source,
        /REDIS_RESPONSE_CHANNEL\s*=\s*ESCOPO_REDIS_MESA/
    );
});
