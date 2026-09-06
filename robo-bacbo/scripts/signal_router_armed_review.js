'use strict';

const path = require('path');
const mysql = require('mysql2/promise');
const { createClient } = require('redis');
const { escreverLinhaJson } = require('../logger');

require('../env_loader').loadEnvFile(path.join(__dirname, '..', '..', '.env'));

const { createBettingHouseService } = require('../betting_house_service');
const { getTechnicalRiskCaps } = require('../technical_risk_caps');
const {
    filterTargetsByAccountIds,
    FinancialTraderScopeResolver
} = require('../signal_router_trader_scope');
const {
    normalizeSignal,
    commandForTarget,
    calculateGlobalExposure,
    resolveOnlineTargets,
    TargetCache,
    RedisSignalDedup
} = require('./signal_router');

const DEFAULT_GLOBAL_CHANNEL = 'global_signals';
const DEFAULT_RESULT_CHANNEL = 'global_signal_results';
const DEFAULT_REVIEW_QUEUE_CHANNEL = 'financial_review_queue';
const DEFAULT_TARGET_CACHE_TTL_MS = 5000;
const DEFAULT_DEDUP_TTL_MS = 60000;
const DEFAULT_DEDUP_PREFIX = 'signal_router:armed_review:dedup';
const CHANNEL_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;

const SIGNAL_ROUTER_AUDIT_FILE = path.resolve(
    __dirname,
    '..',
    '..',
    'logs',
    'signal-router.audit.jsonl'
);

function auditArmedReview(event, payload = {}) {
    try {
        escreverLinhaJson(
            SIGNAL_ROUTER_AUDIT_FILE,
            {
                timestamp: new Date().toISOString(),
                level: 'info',
                pid: process.pid,
                mode: 'ARMED_REVIEW',
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

function validatedChannel(value, fallback, errorCode) {
    const channel = String(value || fallback).trim();
    if (!CHANNEL_PATTERN.test(channel)) throw new Error(errorCode);
    return channel;
}

function positiveIntEnv(name, fallback, min, max) {
    const raw = Number(process.env[name]);
    if (!Number.isFinite(raw)) return fallback;
    const value = Math.trunc(raw);
    if (value < min || value > max) throw new Error(`ARMED_REVIEW_INVALID_${name}: ${raw}`);
    return value;
}

function redisUrl() {
    return String(process.env.REDIS_URL || 'redis://127.0.0.1:6379').trim()
        || 'redis://127.0.0.1:6379';
}

function buildArmedReviewRequest({ signal, traderScope, targets, globalExposure, now = Date.now() }) {
    const preparedOrders = targets.map(target => {
        const command = commandForTarget(signal, target);
        return Object.freeze({
            account_id: target.account_id,
            account_name: target.account_name,
            session_id: target.session_id,
            table_key: target.table_key,
            order_id: command.order_id,
            alvo: command.alvo,
            valor: command.valor,
            ...(Array.isArray(command.apostas) ? { apostas: command.apostas } : {})
        });
    });

    return Object.freeze({
        action: 'financial_review_request',
        schema_version: 1,
        review_status: 'PENDING_HUMAN_CONFIRMATION',
        financial_mode: 'ARMED_REVIEW',
        signal_id: signal.signal_id,
        trader_id: traderScope.trader_id,
        table_key: signal.table_key,
        expected_accounts: preparedOrders.length,
        aggregate_exposure: globalExposure,
        prepared_orders: Object.freeze(preparedOrders),
        automatic_dispatch: false,
        worker_dispatch_count: 0,
        human_confirmation_required: true,
        created_at: now
    });
}

function buildReviewConsolidated(reviewRequest, now = Date.now()) {
    return Object.freeze({
        action: 'multi_account_bet_result',
        signal_id: reviewRequest.signal_id,
        order_id: reviewRequest.signal_id,
        table_key: reviewRequest.table_key,
        status: 'REVIEW_REQUIRED',
        executor_status: 'AGUARDANDO_CONFIRMACAO',
        expected_accounts: reviewRequest.expected_accounts,
        success_accounts: 0,
        failed_accounts: 0,
        accounts: Object.freeze([]),
        confirmacao: null,
        dry_run: false,
        armed_review: true,
        human_confirmation_required: true,
        automatic_dispatch: false,
        dispatch: 0,
        review_status: 'PENDING_HUMAN_CONFIRMATION',
        completed_at: now
    });
}

async function main() {
    const mode = String(process.env.SIGNAL_ROUTER_FINANCIAL_MODE || '').trim().toUpperCase();
    const technicalDryRun = String(process.env.SIGNAL_ROUTER_FINANCIAL_DRY_RUN || '').trim().toLowerCase();
    if (mode !== 'ARMED_REVIEW') {
        throw new Error(`ARMED_REVIEW_ROUTER_MODE_INVALID: ${mode || '<empty>'}`);
    }
    if (technicalDryRun !== 'true') {
        throw new Error('ARMED_REVIEW_AUTOMATIC_DISPATCH_GUARD_NOT_ACTIVE');
    }

    const globalChannel = validatedChannel(
        process.env.SIGNAL_ROUTER_GLOBAL_CHANNEL,
        DEFAULT_GLOBAL_CHANNEL,
        'ARMED_REVIEW_GLOBAL_CHANNEL_INVALID'
    );
    const resultChannel = validatedChannel(
        process.env.SIGNAL_ROUTER_RESULT_CHANNEL,
        DEFAULT_RESULT_CHANNEL,
        'ARMED_REVIEW_RESULT_CHANNEL_INVALID'
    );
    const reviewQueueChannel = validatedChannel(
        process.env.SIGNAL_ROUTER_REVIEW_QUEUE_CHANNEL,
        DEFAULT_REVIEW_QUEUE_CHANNEL,
        'ARMED_REVIEW_QUEUE_CHANNEL_INVALID'
    );
    const cacheTtlMs = positiveIntEnv(
        'SIGNAL_ROUTER_TARGET_CACHE_TTL_MS',
        DEFAULT_TARGET_CACHE_TTL_MS,
        1000,
        300000
    );
    const dedupTtlMs = positiveIntEnv(
        'SIGNAL_ROUTER_DEDUP_TTL_MS',
        DEFAULT_DEDUP_TTL_MS,
        1000,
        3600000
    );

    const dbPool = mysql.createPool({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        waitForConnections: true,
        connectionLimit: 2,
        queueLimit: 0
    });

    const service = createBettingHouseService({
        dbPool,
        encryptionKey: process.env.BETTING_HOUSE_CREDENTIALS_KEY
    });
    const cache = new TargetCache({ service, ttlMs: cacheTtlMs });
    const traderScopeResolver = new FinancialTraderScopeResolver({ dbPool });
    const publisher = createClient({ url: redisUrl() });
    const subscriber = publisher.duplicate();
    const dedup = new RedisSignalDedup({
        client: publisher,
        ttlMs: dedupTtlMs,
        prefix: DEFAULT_DEDUP_PREFIX
    });
    const technicalCaps = getTechnicalRiskCaps();
    let shuttingDown = false;
    let generatedSequence = 0;

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

    const shutdown = async reason => {
        if (shuttingDown) return;
        shuttingDown = true;
        auditArmedReview(
            'ARMED_REVIEW_ROUTER_SHUTDOWN_REQUESTED',
            { reason }
        );

        console.log(
            `\u23F9\uFE0F [ROUTER] STOP | mode=ARMED_REVIEW | reason=${reason}`
        );
        await Promise.allSettled([
            subscriber.isOpen ? subscriber.quit() : Promise.resolve(),
            publisher.isOpen ? publisher.quit() : Promise.resolve()
        ]);
        await dbPool.end();
        console.log(
            '\u2705 [ROUTER] STOPPED | mode=ARMED_REVIEW'
        );
    };

    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));

    try {
        await Promise.all([publisher.connect(), subscriber.connect()]);
        await cache.refresh();

        console.log('=== SIGNAL ROUTER ===');

        console.log(
            `\uD83D\uDEA6 [ROUTER] START | mode=ARMED_REVIEW | ` +
            `channel=${globalChannel} | review_queue=${reviewQueueChannel}`
        );

        auditArmedReview(
            'ARMED_REVIEW_STARTUP',
            {
                financial_mode: 'ARMED_REVIEW',
                financial_dry_run: true,
                automatic_financial_dispatch: false,
                human_confirmation_required: true,
                global_channel: globalChannel,
                result_channel: resultChannel,
                review_queue_channel: reviewQueueChannel
            }
        );

        await subscriber.subscribe(globalChannel, async message => {
            if (shuttingDown) return;

            let signal;
            try {
                signal = normalizeSignal(message, {
                    financialEnabled: true,
                    nextGeneratedId: () => `armed-review-${process.pid}-${Date.now()}-${++generatedSequence}`
                });
            } catch (error) {
                const reason =
                    String(error?.message || error);

                auditArmedReview(
                    'ARMED_REVIEW_SIGNAL_REJECTED',
                    { reason }
                );

                console.warn(
                    `\u26A0\uFE0F [ROUTER] DROP | mode=ARMED_REVIEW | reason=${reason}`
                );
                return;
            }

            let claimed;
            try {
                claimed = await dedup.claim(signal.signal_id);
            } catch (error) {
                auditArmedReview(
                    'ARMED_REVIEW_DEDUP_FAILED',
                    {
                        signal_id: signal.signal_id,
                        table_key: signal.table_key,
                        reason: String(error?.message || error)
                    }
                );

                console.error(
                    `\u274C [ROUTER] ERROR | table=${signal.table_key} | ` +
                    `signal=${signal.signal_id} | dedup | ${error?.message || error}`
                );
                return;
            }
            if (!claimed) {
                auditArmedReview(
                    'ARMED_REVIEW_DUPLICATE',
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

            auditArmedReview(
                'ARMED_REVIEW_RECEIVED',
                {
                    signal_id: signal.signal_id,
                    action: signal.action,
                    table_key: signal.table_key
                }
            );

            console.log(
                `\uD83D\uDCE5 [ROUTER] RX | table=${signal.table_key} | ` +
                `signal=${signal.signal_id} | action=${signal.action} | ` +
                `mode=ARMED_REVIEW`
            );

            let targets;
            try {
                targets = await cache.targets(signal.table_key);
            } catch (error) {
                auditArmedReview(
                    'ARMED_REVIEW_TARGET_DISCOVERY_FAILED',
                    {
                        signal_id: signal.signal_id,
                        table_key: signal.table_key,
                        reason: String(error?.message || error)
                    }
                );

                console.error(
                    `\u274C [ROUTER] ERROR | table=${signal.table_key} | ` +
                    `signal=${signal.signal_id} | target_discovery | ` +
                    `${error?.message || error}`
                );
                return;
            }

            if (!Array.isArray(targets) || targets.length === 0) {
                auditArmedReview(
                    'ARMED_REVIEW_NO_TARGETS',
                    {
                        signal_id: signal.signal_id,
                        table_key: signal.table_key
                    }
                );

                console.warn(
                    `\u26A0\uFE0F [ROUTER] DROP | table=${signal.table_key} | ` +
                    `signal=${signal.signal_id} | reason=NO_TARGETS`
                );
                return;
            }

            if (signal.action !== 'place_bet') {
                const results = await Promise.allSettled(targets.map(async target => {
                    const command = commandForTarget(signal, target);
                    const subscribers = await publisher.publish(
                        target.command_channel,
                        JSON.stringify(command)
                    );
                    return { target, subscribers };
                }));
                const published = results.filter(item => item.status === 'fulfilled').length;
                auditArmedReview(
                    'ARMED_REVIEW_SAFE_ACTION_DISPATCH_COMPLETE',
                    {
                        signal_id: signal.signal_id,
                        action: signal.action,
                        table_key: signal.table_key,
                        targets: targets.length,
                        published
                    }
                );

                console.log(
                    `\u2705 [ROUTER] ROUTED | table=${signal.table_key} | ` +
                    `signal=${signal.signal_id} | action=${signal.action} | ` +
                    `targets=${targets.length} | ok=${published}`
                );
                return;
            }

            let traderScope;
            try {
                traderScope = await traderScopeResolver.resolve(signal);
            } catch (error) {
                const reason =
                    String(error?.message || error);

                auditArmedReview(
                    'ARMED_REVIEW_TRADER_SCOPE_REJECTED',
                    {
                        signal_id: signal.signal_id,
                        table_key: signal.table_key,
                        reason,
                        dispatch: 0
                    }
                );

                console.warn(
                    `\u26A0\uFE0F [ROUTER] DROP | table=${signal.table_key} | ` +
                    `signal=${signal.signal_id} | reason=TRADER_SCOPE_REJECTED | ` +
                    `${reason}`
                );
                return;
            }

            targets = filterTargetsByAccountIds(targets, traderScope.account_ids);
            if (targets.length === 0) {
                auditArmedReview(
                    'ARMED_REVIEW_NO_BOUND_TARGETS',
                    {
                        signal_id: signal.signal_id,
                        trader_id: traderScope.trader_id,
                        table_key: signal.table_key,
                        dispatch: 0
                    }
                );

                console.warn(
                    `\u26A0\uFE0F [ROUTER] DROP | table=${signal.table_key} | ` +
                    `signal=${signal.signal_id} | trader=${traderScope.trader_id} | ` +
                    `reason=NO_BOUND_TARGETS`
                );
                return;
            }

            let availability;
            try {
                availability = await resolveOnlineTargets(publisher, targets);
            } catch (error) {
                auditArmedReview(
                    'ARMED_REVIEW_ONLINE_DISCOVERY_FAILED',
                    {
                        signal_id: signal.signal_id,
                        table_key: signal.table_key,
                        reason: String(error?.message || error)
                    }
                );

                console.error(
                    `\u274C [ROUTER] ERROR | table=${signal.table_key} | ` +
                    `signal=${signal.signal_id} | online_discovery | ` +
                    `${error?.message || error}`
                );
                return;
            }

            const reviewTargets = availability
                .filter(item => item.subscribers > 0)
                .map(item => item.target);
            const online = reviewTargets.length;
            if (online === 0) {
                auditArmedReview(
                    'ARMED_REVIEW_NO_ONLINE_TARGETS',
                    {
                        signal_id: signal.signal_id,
                        table_key: signal.table_key,
                        dispatch: 0
                    }
                );

                console.warn(
                    `\u26A0\uFE0F [ROUTER] DROP | table=${signal.table_key} | ` +
                    `signal=${signal.signal_id} | reason=NO_ONLINE_TARGETS`
                );
                return;
            }

            const globalExposure = calculateGlobalExposure(signal, online);
            if (globalExposure > technicalCaps.global_router_cap + 1e-9) {
                auditArmedReview(
                    'ARMED_REVIEW_GLOBAL_EXPOSURE_REJECTED',
                    {
                        signal_id: signal.signal_id,
                        table_key: signal.table_key,
                        global_exposure: globalExposure,
                        limit: technicalCaps.global_router_cap,
                        dispatch: 0
                    }
                );

                console.warn(
                    `\u26A0\uFE0F [ROUTER] DROP | table=${signal.table_key} | ` +
                    `signal=${signal.signal_id} | reason=GLOBAL_EXPOSURE_REJECTED`
                );
                return;
            }

            const reviewRequest = buildArmedReviewRequest({
                signal,
                traderScope,
                targets: reviewTargets,
                globalExposure
            });
            const queueSubscribers = await publisher.publish(
                reviewQueueChannel,
                JSON.stringify(reviewRequest)
            );
            const consolidated = buildReviewConsolidated(reviewRequest);
            const resultSubscribers = await publisher.publish(
                resultChannel,
                JSON.stringify(consolidated)
            );

            auditArmedReview(
                'SIGNAL_ROUTER_FINANCIAL_ARMED_REVIEW_QUEUED',
                {
                    signal_id: signal.signal_id,
                    trader_id: traderScope.trader_id,
                    table_key: signal.table_key,
                    accounts:
                        reviewTargets.map(
                            item => item.account_id
                        ),
                    online,
                    global_exposure: globalExposure,
                    review_queue_subscribers: queueSubscribers,
                    result_subscribers: resultSubscribers,
                    dispatch: 0,
                    human_confirmation_required: true
                }
            );

            console.warn(
                `\uD83D\uDCCB [ROUTER] REVIEW | table=${signal.table_key} | ` +
                `signal=${signal.signal_id} | trader=${traderScope.trader_id} | ` +
                `accounts=${reviewTargets.length} | confirmation=REQUIRED`
            );
        });

        console.log(
            `\u2705 [ROUTER] READY | mode=ARMED_REVIEW | ` +
            `channel=${globalChannel} | review_queue=${reviewQueueChannel}`
        );

        auditArmedReview(
            'ARMED_REVIEW_READY',
            {
                global_channel: globalChannel,
                result_channel: resultChannel,
                review_queue_channel: reviewQueueChannel
            }
        );
    } catch (error) {
        await shutdown('STARTUP_FAILURE').catch(() => {});
        throw error;
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error('SIGNAL_ROUTER_ARMED_REVIEW_FAILED:', error?.message || error);
        process.exitCode = 1;
    });
}

module.exports = {
    buildArmedReviewRequest,
    buildReviewConsolidated
};
