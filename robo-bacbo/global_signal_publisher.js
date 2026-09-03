'use strict';

const crypto = require('crypto');
const { createClient } = require('redis');

const CHANNEL_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;
const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const SIGNAL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const BET_TARGETS = new Set(['PlayerWon', 'BankerWon', 'Tie']);

function redisUrl() {
    return String(process.env.REDIS_URL || 'redis://127.0.0.1:6379').trim()
        || 'redis://127.0.0.1:6379';
}

function globalChannel() {
    const channel = String(process.env.SIGNAL_ROUTER_GLOBAL_CHANNEL || 'global_signals').trim();
    if (!CHANNEL_PATTERN.test(channel)) throw new Error('GLOBAL_SIGNAL_CHANNEL_INVALID');
    return channel;
}

function normalizeStableText(value, field, maxLength = 256) {
    const text = String(value ?? '').trim();
    if (!text || text.length > maxLength) throw new Error(`GLOBAL_SIGNAL_${field.toUpperCase()}_INVALID`);
    return text;
}

function normalizeTableKey(value) {
    const key = String(value || '').trim().toLowerCase();
    if (!KEY_PATTERN.test(key)) throw new Error('GLOBAL_SIGNAL_TABLE_KEY_INVALID');
    return key;
}

function normalizeMoney(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0 || number > 1000000) {
        throw new Error('GLOBAL_SIGNAL_VALUE_INVALID');
    }
    return Math.round(number * 100) / 100;
}

function normalizeTarget(value) {
    const target = String(value || '').trim();
    if (!BET_TARGETS.has(target)) throw new Error('GLOBAL_SIGNAL_TARGET_INVALID');
    return target;
}

function createStableSignalId({ source, eventId, tableKey }) {
    const normalizedSource = normalizeStableText(source, 'source', 80).toLowerCase();
    const normalizedEventId = normalizeStableText(eventId, 'event_id');
    const normalizedTableKey = normalizeTableKey(tableKey);
    const digest = crypto.createHash('sha256')
        .update(`global-signal-v1|${normalizedSource}|${normalizedEventId}|${normalizedTableKey}`)
        .digest('hex')
        .slice(0, 40);
    const signalId = `sig-${digest}`;
    if (!SIGNAL_ID_PATTERN.test(signalId)) throw new Error('GLOBAL_SIGNAL_ID_INVALID');
    return signalId;
}

function buildPlaceBetSignal(input = {}) {
    const tableKey = normalizeTableKey(input.table_key ?? input.tableKey);
    const signalId = String(input.signal_id || '').trim() || createStableSignalId({
        source: input.source,
        eventId: input.event_id ?? input.eventId,
        tableKey
    });
    if (!SIGNAL_ID_PATTERN.test(signalId)) throw new Error('GLOBAL_SIGNAL_ID_INVALID');

    const payload = {
        signal_id: signalId,
        action: 'place_bet',
        table_key: tableKey,
        alvo: normalizeTarget(input.alvo),
        valor_base: normalizeMoney(input.valor_base ?? input.valor)
    };

    if (Array.isArray(input.apostas) && input.apostas.length > 0) {
        if (input.apostas.length > 4) throw new Error('GLOBAL_SIGNAL_BET_PLAN_TOO_LARGE');
        payload.apostas = input.apostas.map(leg => ({
            alvo: normalizeTarget(leg?.alvo),
            valor: normalizeMoney(leg?.valor)
        }));
    }

    return Object.freeze(payload);
}

function buildSyncBalanceSignal(input = {}) {
    const tableKey = normalizeTableKey(input.table_key ?? input.tableKey);
    const signalId = String(input.signal_id || '').trim() || createStableSignalId({
        source: input.source,
        eventId: input.event_id ?? input.eventId,
        tableKey
    });
    if (!SIGNAL_ID_PATTERN.test(signalId)) throw new Error('GLOBAL_SIGNAL_ID_INVALID');

    return Object.freeze({
        signal_id: signalId,
        action: 'sync_balance',
        table_key: tableKey
    });
}

async function publishGlobalSignal(payload, { client = null, channel = globalChannel() } = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('GLOBAL_SIGNAL_PAYLOAD_INVALID');
    }
    const ownedClient = client == null;
    const redis = client || createClient({ url: redisUrl() });
    if (!redis || typeof redis.publish !== 'function') throw new Error('GLOBAL_SIGNAL_REDIS_CLIENT_INVALID');

    if (ownedClient) {
        redis.on('error', error => {
            console.error(`GLOBAL_SIGNAL_REDIS_ERROR: ${error?.message || error}`);
        });
        await redis.connect();
    }

    try {
        const subscribers = await redis.publish(channel, JSON.stringify(payload));
        console.log(
            `GLOBAL_SIGNAL_PUBLISHED signal=${payload.signal_id} action=${payload.action} ` +
            `table=${payload.table_key} subscribers=${subscribers}`
        );
        return { signal_id: payload.signal_id, subscribers: Number(subscribers) || 0 };
    } finally {
        if (ownedClient && redis.isOpen) await redis.quit();
    }
}

module.exports = {
    createStableSignalId,
    buildPlaceBetSignal,
    buildSyncBalanceSignal,
    publishGlobalSignal
};
