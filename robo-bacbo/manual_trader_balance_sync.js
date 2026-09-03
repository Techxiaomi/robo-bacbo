'use strict';

const express = require('express');
const mysql = require('mysql2/promise');
const { createClient } = require('redis');
const { obterMesaRuntime } = require('./mesa_runtime_context');
const { accountIdsFromConfig } = require('./trader_bound_tasks');
const { readSupervisorSnapshot } = require('./supervisor_telemetry_store');

const BALANCE_TIMEOUT_MS = 20000;
const inflightByTrader = new Map();
let installed = false;
let dbPool = null;

function createDbPool() {
    if (dbPool) return dbPool;
    dbPool = mysql.createPool({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        waitForConnections: true,
        connectionLimit: 2,
        queueLimit: 0
    });
    return dbPool;
}

function redisUrl() {
    return String(process.env.REDIS_URL || 'redis://127.0.0.1:6379').trim()
        || 'redis://127.0.0.1:6379';
}

function tableKey(runtime = obterMesaRuntime()) {
    const key = String(runtime?.codigo || '').trim().toLowerCase();
    if (!/^bacbo_[a-z0-9_]+$/.test(key)) throw new Error('MANUAL_BALANCE_TABLE_INVALID');
    return key;
}

function taskId(accountId, key) {
    return `account-${accountId}:${key}`;
}

function readyWorkers(accountIds, key, snapshot = readSupervisorSnapshot()) {
    if (!snapshot?.available || snapshot?.stale || snapshot?.supervisor?.running !== true) return false;
    const workers = new Map((snapshot.workers || []).map(worker => [String(worker.session_id), worker]));
    return accountIds.every(accountId => {
        const worker = workers.get(taskId(accountId, key));
        return worker && worker.desired === true && String(worker.status).toUpperCase() === 'READY';
    });
}

async function loadTrader(traderId, runtime, pool = createDbPool()) {
    const [rows] = await pool.query(
        `SELECT id, ativo, config_json
         FROM auto_traders
         WHERE id=? AND mesa_id=?
         LIMIT 1`,
        [traderId, Number(runtime.id)]
    );
    if (!Array.isArray(rows) || rows.length !== 1) {
        const error = new Error('MANUAL_BALANCE_TRADER_NOT_FOUND');
        error.statusCode = 404;
        throw error;
    }
    const trader = rows[0];
    if (!(trader.ativo === true || trader.ativo === 1)) {
        const error = new Error('MANUAL_BALANCE_TRADER_NOT_ACTIVE');
        error.statusCode = 409;
        throw error;
    }
    const accountIds = accountIdsFromConfig(trader.config_json);
    if (accountIds.length === 0) {
        const error = new Error('MANUAL_BALANCE_NO_BOUND_ACCOUNTS');
        error.statusCode = 409;
        throw error;
    }
    return Object.freeze({ trader, accountIds: Object.freeze([...accountIds]) });
}

async function collectScopedBalances(accountIds, key) {
    const publisher = createClient({ url: redisUrl() });
    const subscriber = createClient({ url: redisUrl() });
    const wanted = new Set(accountIds.map(Number));
    const balances = new Map();
    let resolveAll;
    let timeout = null;

    const allReceived = new Promise(resolve => { resolveAll = resolve; });
    const pattern = `auto_trader_responses:*:${key}`;

    publisher.on('error', error => console.error('MANUAL_BALANCE_PUBLISHER_ERROR:', error?.message || error));
    subscriber.on('error', error => console.error('MANUAL_BALANCE_SUBSCRIBER_ERROR:', error?.message || error));

    try {
        await publisher.connect();
        await subscriber.connect();
        await subscriber.pSubscribe(pattern, (message, channel) => {
            const match = /^auto_trader_responses:(\d+):([a-z0-9_-]+)$/.exec(String(channel || ''));
            if (!match || String(match[2]).toLowerCase() !== key) return;
            const accountId = Number(match[1]);
            if (!wanted.has(accountId) || balances.has(accountId)) return;

            let payload;
            try { payload = JSON.parse(String(message || '')); } catch (_) { return; }
            if (payload?.action !== 'balance_update') return;
            const balance = Number(payload.balance);
            if (!Number.isFinite(balance) || balance < 0) return;

            balances.set(accountId, Math.round(balance * 100) / 100);
            if (balances.size === wanted.size) resolveAll();
        });

        for (const accountId of accountIds) {
            await publisher.publish(
                `auto_trader_commands:${accountId}:${key}`,
                JSON.stringify({ action: 'sync_balance' })
            );
        }

        await Promise.race([
            allReceived,
            new Promise((_, reject) => {
                timeout = setTimeout(
                    () => reject(new Error(`MANUAL_BALANCE_TIMEOUT:${BALANCE_TIMEOUT_MS}:${balances.size}/${wanted.size}`)),
                    BALANCE_TIMEOUT_MS
                );
                if (typeof timeout.unref === 'function') timeout.unref();
            })
        ]);

        if (balances.size !== wanted.size) {
            throw new Error(`MANUAL_BALANCE_INCOMPLETE:${balances.size}/${wanted.size}`);
        }

        let totalCents = 0;
        const accounts = accountIds.map(accountId => {
            const balance = balances.get(accountId);
            totalCents += Math.round(balance * 100);
            return Object.freeze({ account_id: accountId, balance });
        });
        return Object.freeze({ total: totalCents / 100, accounts: Object.freeze(accounts) });
    } finally {
        if (timeout) clearTimeout(timeout);
        try { if (subscriber.isOpen) await subscriber.quit(); } catch (_) {}
        try { if (publisher.isOpen) await publisher.quit(); } catch (_) {}
    }
}

async function performSync(traderId) {
    const runtime = obterMesaRuntime();
    const key = tableKey(runtime);
    const { accountIds } = await loadTrader(traderId, runtime);

    if (!readyWorkers(accountIds, key)) {
        const error = new Error(`MANUAL_BALANCE_WORKERS_NOT_READY:${accountIds.join(',')}`);
        error.statusCode = 409;
        throw error;
    }

    const result = await collectScopedBalances(accountIds, key);
    const [update] = await createDbPool().query(
        `UPDATE auto_traders
         SET saldo_atual=?
         WHERE id=? AND mesa_id=? AND ativo=true`,
        [result.total, traderId, Number(runtime.id)]
    );
    if (Number(update?.affectedRows) !== 1) {
        throw new Error('MANUAL_BALANCE_UPDATE_CONFLICT');
    }

    console.log(
        `MANUAL_BALANCE_SYNC_READY trader=${traderId} table=${key} ` +
        `accounts=${accountIds.join(',')} aggregate=R$${result.total.toFixed(2)}`
    );
    return Object.freeze({
        sucesso: true,
        fresco: true,
        trader_id: traderId,
        saldo_atual: result.total,
        saldo_contas: result.accounts
    });
}

async function manualBalanceHandler(req, res) {
    const traderId = Number(req?.params?.id);
    if (!Number.isSafeInteger(traderId) || traderId <= 0) {
        return res.status(400).json({ sucesso: false, fresco: false, erro: 'trader_id_invalido' });
    }

    const key = `${Number(obterMesaRuntime().id)}:${traderId}`;
    if (inflightByTrader.has(key)) {
        console.warn(`MANUAL_BALANCE_SYNC_DUPLICATE trader=${traderId} ignored=true`);
        return res.status(409).json({
            sucesso: false,
            fresco: false,
            erro: 'saldo_sincronizacao_em_andamento',
            detalhe: 'Já existe uma sincronização de saldo em andamento para este Auto-Trader.'
        });
    }

    const promise = performSync(traderId);
    inflightByTrader.set(key, promise);
    console.log(`MANUAL_BALANCE_SYNC_STARTED trader=${traderId}`);

    try {
        const result = await promise;
        return res.json(result);
    } catch (error) {
        console.error(`MANUAL_BALANCE_SYNC_FAILED trader=${traderId}: ${error?.message || error}`);
        return res.status(Number(error?.statusCode) || 503).json({
            sucesso: false,
            fresco: false,
            erro: 'saldo_contas_vinculadas_indisponivel',
            detalhe: String(error?.message || error)
        });
    } finally {
        if (inflightByTrader.get(key) === promise) inflightByTrader.delete(key);
    }
}

function installManualTraderBalanceSync() {
    if (installed) return true;
    const proto = express.application;
    if (!proto || typeof proto.post !== 'function') {
        throw new Error('MANUAL_BALANCE_EXPRESS_UNAVAILABLE');
    }

    const originalPost = proto.post;
    let routeInstalled = false;

    proto.post = function postWithManualBalanceOverride(path, ...handlers) {
        if (path === '/api/auto-trader' && !routeInstalled) {
            routeInstalled = true;
            originalPost.call(this, '/api/auto-trader/:id/sync-balance', manualBalanceHandler);
            console.log('MANUAL_BALANCE_SYNC_ROUTE_READY=true');
        }
        return originalPost.call(this, path, ...handlers);
    };

    installed = true;
    return true;
}

module.exports = Object.freeze({
    BALANCE_TIMEOUT_MS,
    taskId,
    readyWorkers,
    installManualTraderBalanceSync
});
