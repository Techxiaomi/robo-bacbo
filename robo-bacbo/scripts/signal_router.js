'use strict';

const crypto = require('crypto');
const path = require('path');
const mysql = require('mysql2/promise');
const { createClient } = require('redis');
const { escreverLinhaJson } = require('../logger');

require('../env_loader').loadEnvFile(path.join(__dirname, '..', '..', '.env'));

const { createBettingHouseService } = require('../betting_house_service');
const { ResultFanIn } = require('../signal_result_fanin');
const { getTechnicalRiskCaps } = require('../technical_risk_caps');
const {
    filterTargetsByAccountIds,
    FinancialTraderScopeResolver
} = require('../signal_router_trader_scope');

const DEFAULT_GLOBAL_CHANNEL = 'global_signals';
const DEFAULT_RESULT_CHANNEL = 'global_signal_results';
const DEFAULT_RESPONSE_PATTERN = 'auto_trader_responses:*:*';
const DEFAULT_TARGET_CACHE_TTL_MS = 5000;
const DEFAULT_DEDUP_TTL_MS = 60000;
const DEFAULT_DEDUP_PREFIX = 'signal_router:dedup';
const DEFAULT_RESULT_TIMEOUT_MS = 210000;
const MAX_SIGNAL_BYTES = 32 * 1024;
const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const SIGNAL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const CHANNEL_PATTERN = /^[A-Za-z0-9._:*-]{1,160}$/;
const SAFE_ACTIONS = new Set(['sync_balance']);
const FINANCIAL_ACTIONS = new Set(['place_bet']);
const BET_TARGETS = new Set(['PlayerWon', 'BankerWon', 'Tie']);

const SIGNAL_ROUTER_AUDIT_FILE = path.resolve(
    __dirname,
    '..',
    '..',
    'logs',
    'signal-router.audit.jsonl'
);

function auditRouter(event, payload = {}) {
    try {
        escreverLinhaJson(
            SIGNAL_ROUTER_AUDIT_FILE,
            {
                timestamp: new Date().toISOString(),
                level: 'info',
                pid: process.pid,
                event,
                ...payload
            },
            {
                maxBytes: 5 * 1024 * 1024,
                maxArquivos: 5
            }
        );
    } catch (error) {
        console.error(
            `\u274C [ROUTER] ERROR | audit_write | ${error?.message || error}`
        );
    }
}

function envBoolean(name, fallback = false) {
    const raw = String(process.env[name] ?? '').trim().toLowerCase();
    if (!raw) return fallback;
    if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
    if (['0', 'false', 'no', 'off'].includes(raw)) return false;
    throw new Error(`SIGNAL_ROUTER_INVALID_${name}: ${raw}`);
}

function positiveIntEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    const raw = String(process.env[name] || '').trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`SIGNAL_ROUTER_INVALID_${name}: ${raw}`);
    }
    return value;
}

function validatedChannel(value, errorCode, { allowWildcard = false } = {}) {
    const channel = String(value || '').trim();
    if (!CHANNEL_PATTERN.test(channel) || (!allowWildcard && channel.includes('*'))) {
        throw new Error(errorCode);
    }
    return channel;
}

function financialFanoutEnabled() {
    return envBoolean('SIGNAL_ROUTER_FINANCIAL_FANOUT_ENABLED', false);
}

function financialDryRun() {
    return envBoolean('SIGNAL_ROUTER_FINANCIAL_DRY_RUN', true);
}

function financialFaninSimulationEnabled() {
    return envBoolean('SIGNAL_ROUTER_FINANCIAL_FANIN_SIMULATION', false);
}

function globalChannel() {
    return validatedChannel(
        process.env.SIGNAL_ROUTER_GLOBAL_CHANNEL || DEFAULT_GLOBAL_CHANNEL,
        'SIGNAL_ROUTER_GLOBAL_CHANNEL_INVALID'
    );
}

function resultChannel() {
    return validatedChannel(
        process.env.SIGNAL_ROUTER_RESULT_CHANNEL || DEFAULT_RESULT_CHANNEL,
        'SIGNAL_ROUTER_RESULT_CHANNEL_INVALID'
    );
}

function responsePattern() {
    return validatedChannel(
        process.env.SIGNAL_ROUTER_RESPONSE_PATTERN || DEFAULT_RESPONSE_PATTERN,
        'SIGNAL_ROUTER_RESPONSE_PATTERN_INVALID',
        { allowWildcard: true }
    );
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

function normalizeMoney(value, field) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0 || number > 1000000) {
        throw new Error(`SIGNAL_ROUTER_${field.toUpperCase()}_INVALID`);
    }
    const cents = Math.round(number * 100);
    if (cents <= 0) throw new Error(`SIGNAL_ROUTER_${field.toUpperCase()}_INVALID`);
    return cents / 100;
}

function normalizeTarget(value) {
    const target = String(value || '').trim();
    if (!BET_TARGETS.has(target)) throw new Error('SIGNAL_ROUTER_BET_TARGET_INVALID');
    return target;
}

function normalizeBetPlan(input) {
    if (Array.isArray(input.apostas) && input.apostas.length > 0) {
        if (input.apostas.length > 4) throw new Error('SIGNAL_ROUTER_BET_PLAN_TOO_LARGE');
        const apostas = input.apostas.map(leg => {
            const item = plainObject(leg);
            if (!item) throw new Error('SIGNAL_ROUTER_BET_PLAN_INVALID');
            return Object.freeze({
                alvo: normalizeTarget(item.alvo),
                valor: normalizeMoney(item.valor, 'bet_value')
            });
        });
        const exposureCents = apostas.reduce((sum, leg) => sum + Math.round(leg.valor * 100), 0);
        return Object.freeze({
            alvo: apostas[0].alvo,
            valor: exposureCents / 100,
            apostas: Object.freeze(apostas),
            exposure_cents: exposureCents
        });
    }

    const alvo = normalizeTarget(input.alvo);
    const valor = normalizeMoney(input.valor_base ?? input.valor, 'bet_value');
    return Object.freeze({
        alvo,
        valor,
        apostas: null,
        exposure_cents: Math.round(valor * 100)
    });
}

function normalizeSignal(raw, options = {}) {
    const nextGeneratedId = typeof options.nextGeneratedId === 'function'
        ? options.nextGeneratedId
        : () => `router-${process.pid}-${Date.now()}`;
    const allowFinancial = options.financialEnabled === true;
    const source = typeof raw === 'string' ? raw : String(raw ?? '');
    if (!source || Buffer.byteLength(source, 'utf8') > MAX_SIGNAL_BYTES) {
        throw new Error('SIGNAL_ROUTER_SIGNAL_SIZE_INVALID');
    }

    let parsed;
    try { parsed = JSON.parse(source); }
    catch (_) { throw new Error('SIGNAL_ROUTER_INVALID_JSON'); }

    const input = plainObject(parsed);
    if (!input) throw new Error('SIGNAL_ROUTER_INVALID_PAYLOAD');

    const action = String(input.action || '').trim().toLowerCase();
    if (!SAFE_ACTIONS.has(action) && !FINANCIAL_ACTIONS.has(action)) {
        throw new Error(`SIGNAL_ROUTER_ACTION_UNSUPPORTED: ${action || '<empty>'}`);
    }
    if (FINANCIAL_ACTIONS.has(action) && !allowFinancial) {
        throw new Error('SIGNAL_ROUTER_FINANCIAL_ACTION_BLOCKED');
    }

    const tableKey = String(input.table_key || input.table || '').trim().toLowerCase();
    if (!KEY_PATTERN.test(tableKey)) throw new Error('SIGNAL_ROUTER_TABLE_KEY_INVALID');

    let signalId = String(input.signal_id || '').trim();
    if (!signalId) signalId = String(nextGeneratedId()).trim();
    if (!SIGNAL_ID_PATTERN.test(signalId)) throw new Error('SIGNAL_ROUTER_SIGNAL_ID_INVALID');

    const base = { signal_id: signalId, action, table_key: tableKey };
    if (action !== 'place_bet') return Object.freeze(base);

    const plan = normalizeBetPlan(input);
    return Object.freeze({
        ...base,
        alvo: plan.alvo,
        valor: plan.valor,
        apostas: plan.apostas,
        exposure_cents: plan.exposure_cents
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
                command_channel: `auto_trader_commands:${accountId}:${tableKey}`,
                response_channel: `auto_trader_responses:${accountId}:${tableKey}`
            }));
        }
    }

    for (const targets of index.values()) targets.sort((a, b) => a.account_id - b.account_id);
    return index;
}

function deterministicOrderId(signal, target) {
    const digest = crypto.createHash('sha256')
        .update(`signal-router-v1|${signal.signal_id}|${target.account_id}|${target.table_key}`)
        .digest('hex')
        .slice(0, 32);
    return `sr-${digest}`;
}

function commandForTarget(signal, target) {
    const base = {
        action: signal.action,
        router_signal_id: signal.signal_id,
        routed_account_id: target.account_id,
        routed_session_id: target.session_id,
        routed_table_key: target.table_key
    };
    if (signal.action !== 'place_bet') return Object.freeze(base);

    return Object.freeze({
        ...base,
        order_id: deterministicOrderId(signal, target),
        alvo: signal.alvo,
        valor: signal.valor,
        ...(Array.isArray(signal.apostas) ? { apostas: signal.apostas } : {})
    });
}

function calculateGlobalExposure(signal, onlineTargetCount) {
    if (signal.action !== 'place_bet') return 0;
    const count = Number(onlineTargetCount);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('SIGNAL_ROUTER_ONLINE_TARGET_COUNT_INVALID');
    return (signal.exposure_cents * count) / 100;
}

async function resolveOnlineTargets(client, targets) {
    const items = Array.isArray(targets) ? targets : [];
    if (items.length === 0) return [];
    if (!client || typeof client.sendCommand !== 'function') {
        throw new TypeError('SIGNAL_ROUTER_PUBSUB_CLIENT_INVALID');
    }
    const channels = items.map(item => item.command_channel);
    const raw = await client.sendCommand(['PUBSUB', 'NUMSUB', ...channels]);
    const counts = new Map();
    for (let index = 0; Array.isArray(raw) && index + 1 < raw.length; index += 2) {
        counts.set(String(raw[index]), Number(raw[index + 1]) || 0);
    }
    return items.map(target => Object.freeze({
        target,
        subscribers: counts.get(target.command_channel) || 0
    }));
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
            auditRouter(
                'SIGNAL_ROUTER_TARGET_CACHE_REFRESH',
                {
                    tables: this.index.size,
                    targets: total,
                    ttl_ms: this.ttlMs
                }
            );
        })().finally(() => { this.refreshPromise = null; });
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

    key(signalId) { return `${this.prefix}:${signalId}`; }

    async claim(signalId) {
        const result = await this.client.set(
            this.key(signalId),
            String(Date.now()),
            { NX: true, PX: this.ttlMs }
        );
        return result === 'OK';
    }
}

function fanInTargets(signal, targets) {
    return targets.map(target => ({
        account_id: target.account_id,
        session_id: target.session_id,
        order_id: deterministicOrderId(signal, target),
        response_channel: target.response_channel
    }));
}

function registerFanInExpectation(fanin, signal, targets, resultTimeoutMs) {
    const expectedTargets = fanInTargets(signal, targets);
    fanin.register({
        signalId: signal.signal_id,
        tableKey: signal.table_key,
        targets: expectedTargets
    });
    auditRouter(
        'SIGNAL_FANIN_EXPECTING',
        {
            signal_id: signal.signal_id,
            table_key: signal.table_key,
            accounts: targets.length,
            timeout_ms: resultTimeoutMs,
            targets: expectedTargets
        }
    );
    return expectedTargets;
}

async function publishTerminalFinancialFailure({
    publisher,
    consolidatedChannel,
    signal,
    reason,
    expectedAccounts = 0
}) {
    const expected = Number.isSafeInteger(Number(expectedAccounts))
        && Number(expectedAccounts) >= 0
        ? Number(expectedAccounts)
        : 0;

    const motivo = String(
        reason || 'SIGNAL_ROUTER_TERMINAL_REJECTION'
    ).trim().slice(0, 1000);

    const result = Object.freeze({
        action: 'multi_account_bet_result',
        signal_id: signal.signal_id,
        order_id: signal.signal_id,
        table_key: signal.table_key,
        status: 'FAILED',
        executor_status: 'FALHOU',
        expected_accounts: expected,
        success_accounts: 0,
        failed_accounts: expected,
        accounts: Object.freeze([]),
        confirmacao: null,
        dry_run: false,
        router_terminal_rejection: true,
        motivo,
        completed_at: Date.now()
    });

    const subscribers = await publisher.publish(
        consolidatedChannel,
        JSON.stringify(result)
    );

    auditRouter(
        'SIGNAL_ROUTER_TERMINAL_REJECTION',
        {
            signal_id: signal.signal_id,
            table_key: signal.table_key,
            reason: motivo,
            expected_accounts: expected,
            dispatch: 0,
            result_subscribers: subscribers
        }
    );

    console.warn(
        `\u26A0\uFE0F [ROUTER] DROP | table=${signal.table_key} | ` +
        `signal=${signal.signal_id} | reason=${motivo}`
    );

    return result;
}

function buildDryRunConsolidated(signal, targets, now = Date.now()) {
    const expectedTargets = fanInTargets(signal, targets);
    const accounts = expectedTargets.map(item => ({
        account_id: item.account_id,
        session_id: item.session_id,
        order_id: item.order_id,
        status: 'FALHOU',
        motivo: 'SIGNAL_ROUTER_FINANCIAL_DRY_RUN_NO_DISPATCH',
        confirmacao: null
    }));
    return Object.freeze({
        action: 'multi_account_bet_result',
        signal_id: signal.signal_id,
        order_id: signal.signal_id,
        table_key: signal.table_key,
        status: 'FAILED',
        executor_status: 'FALHOU',
        expected_accounts: accounts.length,
        success_accounts: 0,
        failed_accounts: accounts.length,
        accounts,
        confirmacao: null,
        dry_run: true,
        completed_at: now
    });
}

async function main() {
    const channel = globalChannel();
    const consolidatedChannel = resultChannel();
    const responsesPattern = responsePattern();
    const cacheTtlMs = positiveIntEnv('SIGNAL_ROUTER_TARGET_CACHE_TTL_MS', DEFAULT_TARGET_CACHE_TTL_MS, { min: 1000, max: 300000 });
    const dedupTtlMs = positiveIntEnv('SIGNAL_ROUTER_DEDUP_TTL_MS', DEFAULT_DEDUP_TTL_MS, { min: 1000, max: 3600000 });
    const resultTimeoutMs = positiveIntEnv('SIGNAL_ROUTER_RESULT_TIMEOUT_MS', DEFAULT_RESULT_TIMEOUT_MS, { min: 5000, max: 600000 });
    const dedupKeyPrefix = dedupPrefix();
    const financialEnabled = financialFanoutEnabled();
    const dryRun = financialDryRun();
    const faninSimulation = financialFaninSimulationEnabled();
    if (faninSimulation && !dryRun) {
        throw new Error('SIGNAL_ROUTER_FANIN_SIMULATION_REQUIRES_DRY_RUN');
    }
    const technicalCaps = getTechnicalRiskCaps();
    const globalMaxExposure = technicalCaps.global_router_cap;

    const dbPool = createDbPool();
    const service = createBettingHouseService({ dbPool, encryptionKey: process.env.BETTING_HOUSE_CREDENTIALS_KEY });
    const cache = new TargetCache({ service, ttlMs: cacheTtlMs });
    const traderScopeResolver = new FinancialTraderScopeResolver({ dbPool });
    const publisher = createClient({ url: redisUrl() });
    const subscriber = publisher.duplicate();
    const responseSubscriber = publisher.duplicate();
    const dedup = new RedisSignalDedup({ client: publisher, ttlMs: dedupTtlMs, prefix: dedupKeyPrefix });
    const fanin = new ResultFanIn({
        timeoutMs: resultTimeoutMs,
        publish: async consolidated => {
            const output = faninSimulation
                ? { ...consolidated, simulation: true }
                : consolidated;
            const subscribers = await publisher.publish(consolidatedChannel, JSON.stringify(output));
            auditRouter(
                'SIGNAL_FANIN_COMPLETE',
                {
                    signal_id: output.signal_id,
                    table_key: output.table_key,
                    status: output.status,
                    success_accounts: output.success_accounts,
                    expected_accounts: output.expected_accounts,
                    executor_status: output.executor_status,
                    simulation: output.simulation === true,
                    subscribers
                }
            );

            console.log(
                `\u2705 [ROUTER] RESULT | table=${output.table_key} | ` +
                `signal=${output.signal_id} | status=${output.status} | ` +
                `success=${output.success_accounts}/${output.expected_accounts}`
            );
        }
    });
    let shuttingDown = false;

    publisher.on(
        'error',
        error => console.error(
            `\u274C [ROUTER] ERROR | redis_publisher | ${error?.message || error}`
        )
    );

    subscriber.on(
        'error',
        error => console.error(
            `\u274C [ROUTER] ERROR | redis_subscriber | ${error?.message || error}`
        )
    );

    responseSubscriber.on(
        'error',
        error => console.error(
            `\u274C [ROUTER] ERROR | redis_response | ${error?.message || error}`
        )
    );

    const shutdown = async reason => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(
            `\u23F9\uFE0F [ROUTER] STOP | reason=${reason}`
        );

        auditRouter(
            'SIGNAL_ROUTER_SHUTDOWN_REQUESTED',
            { reason }
        );
        fanin.close();
        await Promise.allSettled([
            subscriber.isOpen ? subscriber.quit() : Promise.resolve(),
            responseSubscriber.isOpen ? responseSubscriber.quit() : Promise.resolve(),
            publisher.isOpen ? publisher.quit() : Promise.resolve()
        ]);
        await dbPool.end();
        console.log('\u2705 [ROUTER] STOPPED');
    };

    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));

    try {
        await Promise.all([publisher.connect(), subscriber.connect(), responseSubscriber.connect()]);
        await cache.refresh();

        await responseSubscriber.pSubscribe(responsesPattern, (message, responseChannelName) => {
            let payload;
            try { payload = JSON.parse(String(message || '')); }
            catch (_) { return; }
            void (async () => {
                const accepted = await fanin.accept(responseChannelName, payload);
                if (!accepted) return;
                auditRouter(
                    'SIGNAL_FANIN_RESPONSE_ACCEPTED',
                    {
                        order_id: String(
                            payload.order_id || ''
                        ).trim(),
                        status: String(
                            payload.status || ''
                        ).trim().toUpperCase(),
                        channel: responseChannelName
                    }
                );
            })().catch(error => {
                console.error(`SIGNAL_FANIN_RESPONSE_FAILED channel=${responseChannelName}: ${error?.message || error}`);
            });
        });

        console.log('=== SIGNAL ROUTER ===');

        console.log(
            `\uD83D\uDEA6 [ROUTER] START | channel=${channel} | ` +
            `results=${consolidatedChannel}`
        );

        auditRouter(
            'SIGNAL_ROUTER_STARTUP_CONFIG',
            {
                global_channel: channel,
                result_channel: consolidatedChannel,
                response_pattern: responsesPattern,
                result_timeout_ms: resultTimeoutMs,
                target_cache_ttl_ms: cacheTtlMs,
                dedup_ttl_ms: dedupTtlMs,
                dedup_backend: 'redis',
                dedup_prefix: dedupKeyPrefix,
                safe_actions: ['sync_balance'],
                financial_fanout_enabled: financialEnabled,
                financial_dry_run: dryRun,
                financial_fanin_simulation: faninSimulation,
                technical_cap_source: 'technical_risk_caps',
                global_max_exposure: globalMaxExposure,
                per_bridge_max_exposure:
                    technicalCaps.per_bridge_cap,
                financial_scope:
                    'AUTHORITATIVE_TRADER_BINDINGS'
            }
        );

        let generatedSequence = 0;
        await subscriber.subscribe(channel, async message => {
            if (shuttingDown) return;
            let signal;
            try {
                signal = normalizeSignal(message, {
                    financialEnabled,
                    nextGeneratedId: () => `router-${process.pid}-${Date.now()}-${++generatedSequence}`
                });
            } catch (error) {
                const reason =
                    String(error?.message || error);

                auditRouter(
                    'SIGNAL_ROUTER_REJECTED',
                    { reason }
                );

                console.warn(
                    `\u26A0\uFE0F [ROUTER] DROP | reason=${reason}`
                );
                return;
            }

            let claimed;
            try { claimed = await dedup.claim(signal.signal_id); }
            catch (error) {
                auditRouter(
                    'SIGNAL_ROUTER_DEDUP_FAILED',
                    {
                        signal_id: signal.signal_id,
                        table_key: signal.table_key,
                        reason: String(error?.message || error)
                    }
                );

                console.error(
                    `\u274C [ROUTER] ERROR | table=${signal.table_key} | ` +
                    `signal=${signal.signal_id} | dedup | ` +
                    `${error?.message || error}`
                );
                return;
            }
            if (!claimed) {
                auditRouter(
                    'SIGNAL_ROUTER_DUPLICATE',
                    {
                        signal_id: signal.signal_id,
                        table_key: signal.table_key
                    }
                );

                console.warn(
                    `\u26A0\uFE0F [ROUTER] DROP | table=${signal.table_key} | ` +
                    `signal=${signal.signal_id} | reason=DUPLICATE`
                );
                return;
            }

            auditRouter(
                'SIGNAL_ROUTER_RECEIVED',
                {
                    signal_id: signal.signal_id,
                    action: signal.action,
                    table_key: signal.table_key
                }
            );

            console.log(
                `\uD83D\uDCE5 [ROUTER] RX | table=${signal.table_key} | ` +
                `signal=${signal.signal_id} | action=${signal.action}`
            );

            let targets;
            try { targets = await cache.targets(signal.table_key); }
            catch (error) {
                console.error(
                    `SIGNAL_ROUTER_TARGET_DISCOVERY_FAILED signal=${signal.signal_id}: ${error?.message || error}`
                );

                if (signal.action === 'place_bet') {
                    await publishTerminalFinancialFailure({
                        publisher,
                        consolidatedChannel,
                        signal,
                        reason:
                            `SIGNAL_ROUTER_TARGET_DISCOVERY_FAILED: ${error?.message || error}`,
                        expectedAccounts: 0
                    });
                }

                return;
            }
            auditRouter(
                'SIGNAL_ROUTER_TARGETS',
                {
                    signal_id: signal.signal_id,
                    table_key: signal.table_key,
                    count: targets.length
                }
            );
            if (targets.length === 0) {
                auditRouter(
                    'SIGNAL_ROUTER_NO_TARGETS',
                    {
                        signal_id: signal.signal_id,
                        table_key: signal.table_key
                    }
                );

                console.warn(
                    `\u26A0\uFE0F [ROUTER] DROP | table=${signal.table_key} | ` +
                    `signal=${signal.signal_id} | reason=NO_TARGETS`
                );

                if (signal.action === 'place_bet') {
                    await publishTerminalFinancialFailure({
                        publisher,
                        consolidatedChannel,
                        signal,
                        reason: 'SIGNAL_ROUTER_NO_TARGETS',
                        expectedAccounts: 0
                    });
                }

                return;
            }

            let dispatchTargets = targets;
            if (signal.action === 'place_bet') {
                let traderScope;
                try {
                    traderScope = await traderScopeResolver.resolve(signal);
                } catch (error) {
                    const terminalReason =
                        `SIGNAL_ROUTER_TRADER_SCOPE_REJECTED: ${error?.message || error}`;

                    console.error(
                        `SIGNAL_ROUTER_TRADER_SCOPE_REJECTED signal=${signal.signal_id} ` +
                        `table=${signal.table_key} reason=${error?.message || error} dispatch=0`
                    );

                    await publishTerminalFinancialFailure({
                        publisher,
                        consolidatedChannel,
                        signal,
                        reason: terminalReason,
                        expectedAccounts: 0
                    });

                    return;
                }

                const unscopedCount = targets.length;
                targets = filterTargetsByAccountIds(targets, traderScope.account_ids);
                const ignoredUnbound = Math.max(0, unscopedCount - targets.length);
                auditRouter(
                    'SIGNAL_ROUTER_TRADER_SCOPE',
                    {
                        signal_id: signal.signal_id,
                        trader_id: traderScope.trader_id,
                        table_key: signal.table_key,
                        linked_accounts: traderScope.account_ids,
                        eligible_accounts:
                            targets.map(
                                item => item.account_id
                            ),
                        ignored_unbound: ignoredUnbound,
                        detail: `ignored_unbound=${ignoredUnbound}`
                    }
                );
                if (targets.length === 0) {
                    console.warn(
                        `SIGNAL_ROUTER_NO_BOUND_TARGETS signal=${signal.signal_id} trader=${traderScope.trader_id} ` +
                        `table=${signal.table_key} dispatch=0`
                    );

                    await publishTerminalFinancialFailure({
                        publisher,
                        consolidatedChannel,
                        signal,
                        reason: 'SIGNAL_ROUTER_NO_BOUND_TARGETS',
                        expectedAccounts: 0
                    });

                    return;
                }

                let availability;
                try { availability = await resolveOnlineTargets(publisher, targets); }
                catch (error) {
                    console.error(
                        `SIGNAL_ROUTER_ONLINE_DISCOVERY_FAILED signal=${signal.signal_id}: ${error?.message || error}`
                    );

                    await publishTerminalFinancialFailure({
                        publisher,
                        consolidatedChannel,
                        signal,
                        reason:
                            `SIGNAL_ROUTER_ONLINE_DISCOVERY_FAILED: ${error?.message || error}`,
                        expectedAccounts: targets.length
                    });

                    return;
                }
                dispatchTargets = availability.filter(item => item.subscribers > 0).map(item => item.target);
                const online = dispatchTargets.length;
                const globalExposure = calculateGlobalExposure(signal, online);
                auditRouter(
                    'SIGNAL_ROUTER_FINANCIAL_PRECHECK',
                    {
                        signal_id: signal.signal_id,
                        trader_id: traderScope.trader_id,
                        table_key: signal.table_key,
                        per_account:
                            signal.exposure_cents / 100,
                        online,
                        online_accounts:
                            dispatchTargets.map(
                                item => item.account_id
                            ),
                        global_exposure: globalExposure,
                        global_limit: globalMaxExposure
                    }
                );
                if (globalExposure > globalMaxExposure + 1e-9) {
                    console.error(
                        `GLOBAL_EXPOSURE_LIMIT_EXCEEDED signal=${signal.signal_id} ` +
                        `global=${globalExposure.toFixed(2)} limit=${globalMaxExposure.toFixed(2)} online=${online}`
                    );

                    await publishTerminalFinancialFailure({
                        publisher,
                        consolidatedChannel,
                        signal,
                        reason:
                            `GLOBAL_EXPOSURE_LIMIT_EXCEEDED global=${globalExposure.toFixed(2)} limit=${globalMaxExposure.toFixed(2)}`,
                        expectedAccounts: online
                    });

                    return;
                }
                if (online === 0) {
                    console.warn(
                        `SIGNAL_ROUTER_NO_ONLINE_TARGETS signal=${signal.signal_id}`
                    );

                    await publishTerminalFinancialFailure({
                        publisher,
                        consolidatedChannel,
                        signal,
                        reason: 'SIGNAL_ROUTER_NO_ONLINE_TARGETS',
                        expectedAccounts: targets.length
                    });

                    return;
                }
                if (dryRun) {
                    if (faninSimulation) {
                        registerFanInExpectation(fanin, signal, dispatchTargets, resultTimeoutMs);
                        console.log(
                            `SIGNAL_ROUTER_FINANCIAL_DRY_RUN_FANIN_SIMULATION signal=${signal.signal_id} ` +
                            `trader=${traderScope.trader_id} accounts=${dispatchTargets.map(item => item.account_id).join(',')} ` +
                            `online=${online} global=${globalExposure.toFixed(2)} dispatch=0`
                        );
                        return;
                    }

                    const dryRunResult = buildDryRunConsolidated(signal, dispatchTargets);
                    const subscribers = await publisher.publish(consolidatedChannel, JSON.stringify(dryRunResult));
                    auditRouter(
                        'SIGNAL_ROUTER_FINANCIAL_DRY_RUN_COMPLETE',
                        {
                            signal_id: signal.signal_id,
                            trader_id: traderScope.trader_id,
                            table_key: signal.table_key,
                            accounts:
                                dispatchTargets.map(
                                    item => item.account_id
                                ),
                            online,
                            global_exposure: globalExposure,
                            dispatch: 0,
                            executor_status:
                                dryRunResult.executor_status,
                            result_subscribers: subscribers
                        }
                    );

                    console.log(
                        `\u2197\uFE0F [ROUTER] ROUTE | table=${signal.table_key} | ` +
                        `signal=${signal.signal_id} | mode=DRY_RUN | ` +
                        `targets=${dispatchTargets.length} | dispatch=0`
                    );
                    return;
                }

                registerFanInExpectation(fanin, signal, dispatchTargets, resultTimeoutMs);
            }

            const results = await Promise.allSettled(dispatchTargets.map(async target => {
                const command = commandForTarget(signal, target);
                try {
                    const subscribers = await publisher.publish(target.command_channel, JSON.stringify(command));
                    auditRouter(
                        'SIGNAL_ROUTER_DISPATCH',
                        {
                            signal_id: signal.signal_id,
                            table_key: signal.table_key,
                            account_id: target.account_id,
                            session_id: target.session_id,
                            channel: target.command_channel,
                            subscribers
                        }
                    );

                    console.log(
                        `\u2197\uFE0F [ROUTER] ROUTE | table=${signal.table_key} | ` +
                        `signal=${signal.signal_id} | ` +
                        `account=${target.account_id} | subscribers=${subscribers}`
                    );
                    if (signal.action === 'place_bet' && Number(subscribers) < 1) {
                        await fanin.markDispatchFailure(command.order_id, 'SIGNAL_ROUTER_DISPATCH_NO_SUBSCRIBER');
                    }
                    return { target, subscribers };
                } catch (error) {
                    if (signal.action === 'place_bet') {
                        await fanin.markDispatchFailure(command.order_id, `SIGNAL_ROUTER_DISPATCH_FAILED: ${error?.message || error}`);
                    }
                    throw error;
                }
            }));

            let published = 0;
            let offline = 0;
            let failed = 0;
            for (const result of results) {
                if (result.status === 'rejected') {
                    failed += 1;
                    console.error(`SIGNAL_ROUTER_DISPATCH_FAILED signal=${signal.signal_id}: ${result.reason?.message || result.reason}`);
                    continue;
                }
                published += 1;
                if (Number(result.value.subscribers) === 0) offline += 1;
            }
            auditRouter(
                'SIGNAL_ROUTER_DISPATCH_COMPLETE',
                {
                    signal_id: signal.signal_id,
                    table_key: signal.table_key,
                    targets: dispatchTargets.length,
                    published,
                    offline,
                    failed
                }
            );

            console.log(
                `\u2197\uFE0F [ROUTER] ROUTED | table=${signal.table_key} | ` +
                `signal=${signal.signal_id} | targets=${dispatchTargets.length} | ` +
                `ok=${published} | offline=${offline} | failed=${failed}`
            );
        });

        console.log(
            `\u2705 [ROUTER] READY | channel=${channel} | ` +
            `results=${consolidatedChannel}`
        );

        auditRouter(
            'SIGNAL_ROUTER_READY',
            {
                channel,
                result_channel: consolidatedChannel
            }
        );
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
    FINANCIAL_ACTIONS,
    normalizeSignal,
    buildTargetIndex,
    deterministicOrderId,
    commandForTarget,
    calculateGlobalExposure,
    resolveOnlineTargets,
    fanInTargets,
    registerFanInExpectation,
    publishTerminalFinancialFailure,
    buildDryRunConsolidated,
    TargetCache,
    RedisSignalDedup
};
