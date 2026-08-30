'use strict';

const {
    obterMesaRuntime
} = require('./mesa_runtime_context');

function codigoMesaRedis(valor) {
    const codigo =
        String(valor || '')
            .trim()
            .toUpperCase();

    if (
        !codigo
        || !/^[A-Z0-9_]+$/.test(codigo)
    ) {
        throw new Error(
            `MC22-Y-B: codigo de mesa Redis invalido: ${codigo || '<vazio>'}`
        );
    }

    return codigo;
}

function nomeRedisEscopado(base, codigo) {
    const nome =
        String(base || '').trim();

    if (!nome) {
        throw new Error(
            'MC22-Y-B: nome Redis base vazio'
        );
    }

    const sufixo = `:${codigo}`;

    if (
        nome.toUpperCase().endsWith(
            sufixo.toUpperCase()
        )
    ) {
        return nome;
    }

    return `${nome}${sufixo}`;
}

function obterEscopoRedisMesa() {
    const runtime = obterMesaRuntime();

    const codigo =
        codigoMesaRedis(runtime.codigo);

    const mesaId =
        Number(runtime.id);

    if (
        !Number.isInteger(mesaId)
        || mesaId <= 0
    ) {
        throw new Error(
            'MC22-Y-B: mesa_id Redis invalido'
        );
    }

    return Object.freeze({
        mesaId,
        codigo,

        eventsChannel: nomeRedisEscopado(
            process.env.REDIS_BACBO_EVENTS_CHANNEL
                || 'bacbo_events',
            codigo
        ),

        historyKey: nomeRedisEscopado(
            process.env.REDIS_BACBO_HISTORY_KEY
                || 'bacbo_history',
            codigo
        ),

        latestRoundKey: nomeRedisEscopado(
            process.env.REDIS_BACBO_LATEST_ROUND_KEY
                || 'bacbo_latest_round',
            codigo
        ),

        historyAckKey: nomeRedisEscopado(
            process.env.REDIS_BACBO_HISTORY_ACK_KEY
                || 'robo_bacbo:history_applied_signature',
            codigo
        ),

        roadSnapshotKey: nomeRedisEscopado(
            process.env.REDIS_BACBO_ROAD_SNAPSHOT_KEY
                || 'robo_bacbo:last_road_snapshot',
            codigo
        ),

        recentRoundsKey: nomeRedisEscopado(
            process.env.REDIS_BACBO_RECENT_ROUNDS_KEY
                || 'robo_bacbo:recent_rounds_v3',
            codigo
        )
    });
}

module.exports = {
    obterEscopoRedisMesa
};
