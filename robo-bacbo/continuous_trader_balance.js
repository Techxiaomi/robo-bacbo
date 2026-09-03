'use strict';

const express = require('express');
const mysql = require('mysql2/promise');
const { createClient } = require('redis');
const { obterMesaRuntime } = require('./mesa_runtime_context');
const { accountIdsFromConfig } = require('./trader_bound_tasks');

const CHANNEL_RE = /^auto_trader_responses:(\d+):([a-z0-9][a-z0-9_-]{0,79})$/;
const DEFAULT_MAX_AGE_SECONDS = 90;

function redisUrl() {
    return String(process.env.REDIS_URL || 'redis://127.0.0.1:6379').trim()
        || 'redis://127.0.0.1:6379';
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

function tableKeyFromRuntime(runtime = obterMesaRuntime()) {
    const codigo = String(runtime?.codigo || '').trim().toLowerCase();
    if (!codigo || !/^bacbo_[a-z0-9_]+$/.test(codigo)) {
        throw new Error('CONTINUOUS_BALANCE_TABLE_SCOPE_INVALID');
    }
    return codigo;
}

function maxAgeMs() {
    const raw = Number(process.env.BALANCE_SYNC_MAX_AGE_SECONDS || DEFAULT_MAX_AGE_SECONDS);
    const seconds = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_AGE_SECONDS;
    return Math.trunc(seconds * 1000);
}

function parseScopedBalance(channel, rawMessage, now = Date.now()) {
    const match = CHANNEL_RE.exec(String(channel || '').trim());
    if (!match) return null;

    let payload;
    try { payload = JSON.parse(String(rawMessage || '')); }
    catch (_) { return null; }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    if (String(payload.action || '').trim() !== 'balance_update') return null;

    const accountId = Number(match[1]);
    const tableKey = String(match[2] || '').trim().toLowerCase();
    const balance = Number(payload.balance);
    if (!Number.isSafeInteger(accountId) || accountId <= 0) return null;
    if (!Number.isFinite(balance) || balance < 0) return null;

    return Object.freeze({
        account_id: accountId,
        table_key: tableKey,
        balance: Math.round(balance * 100) / 100,
        updated_at: Math.trunc(Number(now) || Date.now())
    });
}

function aggregateTraderBalance(trader, snapshots, { now = Date.now(), freshnessMs = maxAgeMs() } = {}) {
    const accountIds = accountIdsFromConfig(trader?.config_json ?? trader?.config);
    if (accountIds.length === 0) {
        return Object.freeze({ complete: false, reason: 'NO_BOUND_ACCOUNTS', account_ids: [] });
    }

    let totalCents = 0;
    const accounts = [];
    for (const accountId of accountIds) {
        const snapshot = snapshots instanceof Map ? snapshots.get(accountId) : null;
        if (!snapshot) {
            return Object.freeze({ complete: false, reason: 'MISSING_ACCOUNT_BALANCE', account_ids: accountIds, missing_account_id: accountId });
        }
        const age = Number(now) - Number(snapshot.updated_at);
        if (!Number.isFinite(age) || age < 0 || age > freshnessMs) {
            return Object.freeze({ complete: false, reason: 'STALE_ACCOUNT_BALANCE', account_ids: accountIds, stale_account_id: accountId });
        }
        const cents = Math.round(Number(snapshot.balance) * 100);
        if (!Number.isSafeInteger(cents) || cents < 0) {
            return Object.freeze({ complete: false, reason: 'INVALID_ACCOUNT_BALANCE', account_ids: accountIds, invalid_account_id: accountId });
        }
        totalCents += cents;
        accounts.push(Object.freeze({
            account_id: accountId,
            balance: cents / 100,
            updated_at: Number(snapshot.updated_at)
        }));
    }

    return Object.freeze({
        complete: true,
        reason: null,
        account_ids: Object.freeze([...accountIds]),
        accounts: Object.freeze(accounts),
        total: totalCents / 100
    });
}

class ContinuousTraderBalanceAggregator {
    constructor({ dbPool, mesaId, tableKey, freshnessMs = maxAgeMs(), now = () => Date.now(), log = console }) {
        if (!dbPool || typeof dbPool.query !== 'function') throw new TypeError('CONTINUOUS_BALANCE_DB_INVALID');
        if (!Number.isSafeInteger(Number(mesaId)) || Number(mesaId) <= 0) throw new Error('CONTINUOUS_BALANCE_MESA_INVALID');
        this.dbPool = dbPool;
        this.mesaId = Number(mesaId);
        this.tableKey = String(tableKey || '').trim().toLowerCase();
        this.freshnessMs = Number(freshnessMs);
        this.now = now;
        this.log = log;
        this.snapshots = new Map();
    }

    async record(snapshot) {
        if (!snapshot || snapshot.table_key !== this.tableKey) return [];
        this.snapshots.set(snapshot.account_id, snapshot);

        const [rows] = await this.dbPool.query(
            `SELECT id, ativo, config_json, saldo_atual
             FROM auto_traders
             WHERE mesa_id=?
               AND ativo=true
             ORDER BY id`,
            [this.mesaId]
        );

        const updates = [];
        for (const trader of Array.isArray(rows) ? rows : []) {
            const linked = accountIdsFromConfig(trader.config_json);
            if (!linked.includes(snapshot.account_id)) continue;

            const aggregate = aggregateTraderBalance(trader, this.snapshots, {
                now: this.now(),
                freshnessMs: this.freshnessMs
            });
            if (!aggregate.complete) {
                this.log.log(
                    `CONTINUOUS_BALANCE_WAIT trader=${Number(trader.id)} table=${this.tableKey} ` +
                    `reason=${aggregate.reason}`
                );
                continue;
            }

            const [result] = await this.dbPool.query(
                `UPDATE auto_traders
                 SET saldo_atual=?
                 WHERE id=?
                   AND mesa_id=?
                   AND ativo=true`,
                [aggregate.total, Number(trader.id), this.mesaId]
            );
            if (Number(result?.affectedRows) !== 1) continue;

            const item = Object.freeze({
                trader_id: Number(trader.id),
                balance: aggregate.total,
                account_ids: aggregate.account_ids
            });
            updates.push(item);
            this.log.log(
                `CONTINUOUS_BALANCE_AGGREGATED trader=${item.trader_id} table=${this.tableKey} ` +
                `accounts=${item.account_ids.join(',')} balance=${item.balance.toFixed(2)}`
            );
        }
        return updates;
    }
}

let installed = false;
let subscriber = null;
let dbPool = null;
let aggregator = null;

function installLegacyGlobalBalanceGuard() {
    const originalPost = express.application.post;
    if (originalPost.__continuousBalanceGuardInstalled) return;

    function patchedPost(path, ...handlers) {
        if (path === '/receber-sinal') {
            handlers = handlers.map(handler => {
                if (typeof handler !== 'function') return handler;
                return function guardedReceiveSignal(req, res, next) {
                    if (
                        String(process.env.AUTO_TRADER_MULTI_ACCOUNT_ROUTER_ENABLED || '').trim().toLowerCase() === 'true'
                        && req?.body
                        && Object.prototype.hasOwnProperty.call(req.body, 'saldo_atual')
                    ) {
                        req.body = { ...req.body };
                        delete req.body.saldo_atual;
                        console.warn('CONTINUOUS_BALANCE_LEGACY_GLOBAL_BALANCE_IGNORED=true');
                    }
                    return handler(req, res, next);
                };
            });
        }
        return originalPost.call(this, path, ...handlers);
    }

    patchedPost.__continuousBalanceGuardInstalled = true;
    express.application.post = patchedPost;
}

async function installContinuousTraderBalance() {
    if (installed) return aggregator;
    if (String(process.env.AUTO_TRADER_MULTI_ACCOUNT_ROUTER_ENABLED || '').trim().toLowerCase() !== 'true') {
        throw new Error('CONTINUOUS_BALANCE_MULTI_ACCOUNT_ROUTER_REQUIRED');
    }

    const runtime = obterMesaRuntime();
    const tableKey = tableKeyFromRuntime(runtime);
    const mesaId = Number(runtime.id);

    installLegacyGlobalBalanceGuard();
    dbPool = createDbPool();
    aggregator = new ContinuousTraderBalanceAggregator({
        dbPool,
        mesaId,
        tableKey,
        freshnessMs: maxAgeMs()
    });

    subscriber = createClient({ url: redisUrl() });
    subscriber.on('error', error => {
        console.error(`CONTINUOUS_BALANCE_REDIS_ERROR: ${error?.message || error}`);
    });
    await subscriber.connect();

    const pattern = `auto_trader_responses:*:${tableKey}`;
    await subscriber.pSubscribe(pattern, (message, channel) => {
        const snapshot = parseScopedBalance(channel, message);
        if (!snapshot) return;
        void aggregator.record(snapshot).catch(error => {
            console.error(`CONTINUOUS_BALANCE_PROCESS_FAILED account=${snapshot.account_id}: ${error?.message || error}`);
        });
    });

    installed = true;
    console.log(`CONTINUOUS_BALANCE_READY=true table=${tableKey} pattern=${pattern}`);
    return aggregator;
}

module.exports = {
    parseScopedBalance,
    aggregateTraderBalance,
    ContinuousTraderBalanceAggregator,
    installLegacyGlobalBalanceGuard,
    installContinuousTraderBalance,
    tableKeyFromRuntime,
    maxAgeMs
};
