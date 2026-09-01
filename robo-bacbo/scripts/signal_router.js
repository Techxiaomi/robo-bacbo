'use strict';

const path = require('path');
const mysql = require('mysql2/promise');
const { createClient } = require('redis');

require('../env_loader').loadEnvFile(path.join(__dirname, '..', '..', '.env'));

const { createBettingHouseService } = require('../betting_house_service');

const DEFAULT_GLOBAL_CHANNEL = 'global_signals';
const DEFAULT_TARGET_CACHE_TTL_MS = 5000;
const DEFAULT_DEDUP_TTL_MS = 60000;
const DEFAULT_DEDUP_PREFIX = 'signal_router:dedup';
const MAX_SIGNAL_BYTES = 32 * 1024;
const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const SIGNAL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_ACTIONS = new Set(['sync_balance']);

function positiveIntEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    const raw = String(process.env[name] || '').trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`SIGNAL_ROUTER_INVALID_${name}: ${raw}`);
    }
    return value;
}

function globalChannel() {
    const channel = String(process.env.SIGNAL_ROUTER_GLOBAL_CHANNEL || DEFAULT_GLOBAL_CHANNEL).trim();
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(channel)) {
        throw new Error('SIGNAL_ROUTER_GLOBAL_CHANNEL_INVALID');
    }
    return channel;
}

function dedupPrefix() {
    const prefix = String(process.env.SIGNAL_ROUTER_DEDUP_PREFIX || DEFAULT_DEDUP_PREFIX).trim();
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(prefix)) {
        throw new Error('SIGNAL_ROUTER_DEDUP_PREFIX_INVALID');
    }
    return prefix;
}

function createDbPool() {
    return mysql.createPool({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        waitForConnections: true,
        connectionLimit: 2,
        queueLimit: 0
    });
}

function redisUrl() {
    return String(process.env.REDIS_URL || 'redis://127.0.0.1:6379').trim()
        || 'redis://127.0.0.1:6379';
}

function plainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function normalizeSignal(raw, nextGeneratedId = () => `router-${process.pid}-${Date.now()}`) {
    const source = typeof raw === 'string' ? raw : String(raw ?? '');
    if (!source || Buffer.byteLength(source, 'utf8') > MAX_SIGNAL_BYTES) {
        throw new Error('SIGNAL_ROUTER_SIGNAL_SIZE_INVALID');
    }

    let parsed;
    try {
        parsed = JSON.parse(source);
    } catch (_) {
        throw new Error('SIGNAL_ROUTER_INVALID_JSON');
    }

    const input = plainObject(parsed);
    if (!input) throw new Error('SIGNAL_ROUTER_INVALID_PAYLOAD');

    const action = String(input.action || '').trim().toLowerCase();
    if (!SAFE_ACTIONS.has(action)) {
        if (action === 'place_bet') throw new Error('SIGNAL_ROUTER_FINANCIAL_ACTION_BLOCKED');
        throw new Error(`SIGNAL_ROUTER_ACTION_UNSUPPORTED: ${action || '<empty>'}`);
    }

    const tableKey = String(input.table_key || input.table || '').trim().toLowerCase();
    if (!KEY_PATTERN.test(tableKey)) {
        throw new Error('SIGNAL_ROUTER_TABLE_KEY_INVALID');
    }

    let signalId = String(input.signal_id || '').trim();
    if (!signalId) signalId = String(nextGeneratedId()).trim();
    if (!SIGNAL_ID_PATTERN.test(signalId)) {
        throw new Error('SIGNAL_ROUTER_SIGNAL_ID_INVALID');
    }

    return Object.freeze({
        signal_id: signalId,
        action,
        table_key: tableKey
    });
}

function buildTargetIndex(houses) {
    const index = new Map();
    for (const house of Array.isArray(houses) ? houses : []) {
        if (!house || house.enabled !== true) continue;
        const accountId = Number(house.id);
        if (!Number.isSafeInteger(accountId) || accountId <= 0) continue;

        for (const table of Array.isArray(house.tables) ? house.tables : []) {
            if (!table || table.enabled !== true) continue;
            const tableKey = String(table.table_key || '').trim().toLowerCase();
            if (!KEY_PATTERN.test(tableKey)) continue;

            if (!index.has(tableKey)) index.set(tableKey, []);
            index.get(tableKey).push(Object.freeze({
                account_id: accountId,
                account_name: String(house.name || `Conta ${accountId}`),
                table_key: tableKey,
                table_name: String(table.display_name || tableKey),
                session_id: `account-${accountId}:${tableKey}`,
                command_channel: `auto_trader_commands:${accountId}:${tableKey}`
            }));
        }
    }

    for (const targets of index.values()) {
        targets.sort((a, b) => a.account_id - b.account_id);
    }
    return index;
}

function commandForTarget(signal, target) {
    return Object.freeze({
        action: signal.action,
        router_signal_id: signal.signal_id,
        routed_account_id: target.account_id,
        routed_session_id: target.session_id,
        routed_table_key: target.table_key
    });
}

class TargetCache {
    constructor({ service, ttlMs }) {
        this.service = service;
        this.ttlMs = ttlMs;
        this.expiresAt = 0;
        this.index = new Map();
        this.refreshPromise = null;
    }

    async refresh() {
        if (this.refreshPromise) return this.refreshPromise;
        this.refreshPromise = (async () => {
            const houses = await this.service.listHouses({ includeDisabled: false });
            this.index = buildTargetIndex(houses);
            this.expiresAt = Date.now() + this.ttlMs;
            const total = Array.from(this.index.values()).reduce((sum, items) => sum + items.length, 0);
            console.log(`SIGNAL_ROUTER_TARGET_CACHE_REFRESH tables=${this.index.size} targets=${total} ttl_ms=${this.ttlMs}`);
        })().finally(() => {
            this.refreshPromise = null;
        });
        return this.refreshPromise;
    }

    async targets(tableKey) {
        if (Date.now() >= this.expiresAt) await this.refresh();
        return this.index.get(tableKey) || [];
    }
}

class RedisSignalDedup {
    constructor({ client, ttlMs, prefix = DEFAULT_DEDUP_PREFIX }) {
        if (!client || typeof client.set !== 'function') {
            throw new TypeError('SIGNAL_ROUTER_DEDUP_INVALID_REDIS_CLIENT');
        }
        this.client = client;
        this.ttlMs = ttlMs;
        this.prefix = prefix;
    }

    key(signalId) {
        return `${this.prefix}:${signalId}`;
    }

    async claim(signalId) {
        const result = await this.client.set(
            this.key(signalId),
            String(Date.now()),
            { NX: true, PX: this.ttlMs }
        );
        return result === 'OK';
    }
}

async function main() {
    const channel = globalChannel();
    const cacheTtlMs = positiveIntEnv('SIGNAL_ROUTER_TARGET_CACHE_TTL_MS', DEFAULT_TARGET_CACHE_TTL_MS, {
        min: 1000,
        max: 300000
    });
    const dedupTtlMs = positiveIntEnv('SIGNAL_ROUTER_DEDUP_TTL_MS', DEFAULT_DEDUP_TTL_MS, {
        min: 1000,
        max: 3600000
    });
    const dedupKeyPrefix = dedupPrefix();

    const dbPool = createDbPool();
    const service = createBettingHouseService({
        dbPool,
        encryptionKey: process.env.BETTING_HOUSE_CREDENTIALS_KEY
    });
    const cache = new TargetCache({ service, ttlMs: cacheTtlMs });
    const publisher = createClient({ url: redisUrl() });
    const subscriber = publisher.duplicate();
    const dedup = new RedisSignalDedup({
        client: publisher,
        ttlMs: dedupTtlMs,
        prefix: dedupKeyPrefix
    });
    let shuttingDown = false;

    publisher.on('error', error => {
        console.error(`SIGNAL_ROUTER_REDIS_PUBLISHER_ERROR: ${error?.message || error}`);
    });
    subscriber.on('error', error => {
        console.error(`SIGNAL_ROUTER_REDIS_SUBSCRIBER_ERROR: ${error?.message || error}`);
    });

    const shutdown = async reason => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`SIGNAL_ROUTER_SHUTDOWN_REQUESTED reason=${reason}`);
        await Promise.allSettled([
            subscriber.isOpen ? subscriber.quit() : Promise.resolve(),
            publisher.isOpen ? publisher.quit() : Promise.resolve()
        ]);
        await dbPool.end();
        console.log('SIGNAL_ROUTER_STOPPED=true');
    };

    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));

    try {
        await Promise.all([publisher.connect(), subscriber.connect()]);
        await cache.refresh();

        console.log('=== SIGNAL ROUTER ===');
        console.log(`SIGNAL_ROUTER_GLOBAL_CHANNEL=${channel}`);
        console.log(`SIGNAL_ROUTER_TARGET_CACHE_TTL_MS=${cacheTtlMs}`);
        console.log(`SIGNAL_ROUTER_DEDUP_TTL_MS=${dedupTtlMs}`);
        console.log(`SIGNAL_ROUTER_DEDUP_BACKEND=redis prefix=${dedupKeyPrefix}`);
        console.log('SIGNAL_ROUTER_SAFE_ACTIONS=sync_balance');
        console.log('SIGNAL_ROUTER_FINANCIAL_FANOUT_ENABLED=false');

        let generatedSequence = 0;
        await subscriber.subscribe(channel, async message => {
            if (shuttingDown) return;
            let signal;
            try {
                signal = normalizeSignal(message, () => `router-${process.pid}-${Date.now()}-${++generatedSequence}`);
            } catch (error) {
                console.error(`SIGNAL_ROUTER_REJECTED reason=${error?.message || error}`);
                return;
            }

            let claimed;
            try {
                claimed = await dedup.claim(signal.signal_id);
            } catch (error) {
                console.error(
                    `SIGNAL_ROUTER_DEDUP_FAILED signal=${signal.signal_id}: ${error?.message || error}`
                );
                return;
            }

            if (!claimed) {
                console.warn(`SIGNAL_ROUTER_DUPLICATE signal=${signal.signal_id}`);
                return;
            }

            console.log(
                `SIGNAL_ROUTER_RECEIVED signal=${signal.signal_id} action=${signal.action} table=${signal.table_key}`
            );

            let targets;
            try {
                targets = await cache.targets(signal.table_key);
            } catch (error) {
                console.error(
                    `SIGNAL_ROUTER_TARGET_DISCOVERY_FAILED signal=${signal.signal_id}: ${error?.message || error}`
                );
                return;
            }

            console.log(`SIGNAL_ROUTER_TARGETS signal=${signal.signal_id} count=${targets.length}`);
            if (targets.length === 0) {
                console.warn(`SIGNAL_ROUTER_NO_TARGETS signal=${signal.signal_id} table=${signal.table_key}`);
                return;
            }

            const results = await Promise.allSettled(targets.map(async target => {
                const command = commandForTarget(signal, target);
                const subscribers = await publisher.publish(target.command_channel, JSON.stringify(command));
                console.log(
                    `SIGNAL_ROUTER_DISPATCH signal=${signal.signal_id} account=${target.account_id} ` +
                    `session=${target.session_id} channel=${target.command_channel} subscribers=${subscribers}`
                );
                return { target, subscribers };
            }));

            let published = 0;
            let offline = 0;
            let failed = 0;
            for (const result of results) {
                if (result.status === 'rejected') {
                    failed += 1;
                    console.error(
                        `SIGNAL_ROUTER_DISPATCH_FAILED signal=${signal.signal_id}: ` +
                        `${result.reason?.message || result.reason}`
                    );
                    continue;
                }
                published += 1;
                if (Number(result.value.subscribers) === 0) offline += 1;
            }

            console.log(
                `SIGNAL_ROUTER_DISPATCH_COMPLETE signal=${signal.signal_id} ` +
                `targets=${targets.length} published=${published} offline=${offline} failed=${failed}`
            );
        });

        console.log('SIGNAL_ROUTER_READY=true');
    } catch (error) {
        await shutdown('STARTUP_FAILURE').catch(() => {});
        throw error;
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error('SIGNAL_ROUTER_FAILED:', error?.message || error);
        process.exitCode = 1;
    });
}

module.exports = {
    SAFE_ACTIONS,
    normalizeSignal,
    buildTargetIndex,
    commandForTarget,
    TargetCache,
    RedisSignalDedup
};
