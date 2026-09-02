'use strict';

const crypto = require('crypto');
const express = require('express');
const mysql = require('mysql2/promise');
const { createClient } = require('redis');

const { normalizarConfigAutoTrader } = require('./auto_trader');
const { validarPoliticaProtecao } = require('./tie_protection');
const { obterMesaRuntime } = require('./mesa_runtime_context');
const { readSupervisorSnapshot } = require('./supervisor_telemetry_store');

const SUPPORTED_ADAPTER_KEY = 'brasil-da-sorte';
const READY_TIMEOUT_MS = 120000;
const BALANCE_TIMEOUT_MS = 20000;
const POLL_INTERVAL_MS = 500;

let installed = false;
let dbPool = null;
let createQueue = Promise.resolve();

function createDbPool() {
    if (dbPool) return dbPool;
    dbPool = mysql.createPool({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        waitForConnections: true,
        connectionLimit: 3,
        queueLimit: 0
    });
    return dbPool;
}

function redisUrl() {
    return String(process.env.REDIS_URL || 'redis://127.0.0.1:6379').trim()
        || 'redis://127.0.0.1:6379';
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeAccountIds(config) {
    const values = Array.isArray(config?.account_ids) ? config.account_ids : [];
    return Array.from(new Set(values
        .map(Number)
        .filter(id => Number.isSafeInteger(id) && id > 0)))
        .sort((a, b) => a - b);
}

function channelsFor(accountId, tableKey) {
    return Object.freeze({
        command: `auto_trader_commands:${accountId}:${tableKey}`,
        response: `auto_trader_responses:${accountId}:${tableKey}`
    });
}

function taskId(accountId, tableKey) {
    return `account-${accountId}:${tableKey}`;
}

function canonicalConfig(rawConfig) {
    const config = normalizarConfigAutoTrader(rawConfig || {});
    const accountIds = normalizeAccountIds(config);
    if (accountIds.length === 0) {
        const error = new Error('AUTO_TRADER_BINDINGS_REQUIRED');
        error.statusCode = 409;
        throw error;
    }
    config.account_ids = accountIds;
    const tiePolicy = validarPoliticaProtecao(config);
    if (!tiePolicy.ok) {
        const error = new Error(tiePolicy.motivo || 'AUTO_TRADER_TIE_POLICY_INVALID');
        error.statusCode = 400;
        throw error;
    }
    return Object.freeze({ config: Object.freeze({ ...config }), accountIds: Object.freeze(accountIds) });
}

async function eligibleAccounts(accountIds, mesa = obterMesaRuntime(), pool = createDbPool()) {
    const ids = Array.from(accountIds || []);
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const [rows] = await pool.query(
        `SELECT h.id AS account_id, h.name AS account_name
         FROM betting_houses h
         INNER JOIN betting_house_tables t
            ON t.betting_house_id=h.id
           AND t.enabled=true
           AND LOWER(t.table_key)=LOWER(?)
         WHERE h.id IN (${placeholders})
           AND h.enabled=true
           AND h.adapter_key=?
         ORDER BY h.id`,
        [mesa.codigo, ...ids, SUPPORTED_ADAPTER_KEY]
    );
    const resolved = (rows || []).map(row => Object.freeze({
        account_id: Number(row.account_id),
        account_name: String(row.account_name || `Conta ${row.account_id}`)
    }));
    const eligibleIds = new Set(resolved.map(item => item.account_id));
    const missing = ids.filter(id => !eligibleIds.has(id));
    if (missing.length > 0) {
        const error = new Error(`AUTO_TRADER_BINDING_ACCOUNT_UNAVAILABLE:${missing.join(',')}`);
        error.statusCode = 409;
        throw error;
    }
    return resolved;
}

async function synchronizeBindings(traderId, mesaId, canonical, pool = createDbPool()) {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [rows] = await connection.query(
            'SELECT id FROM auto_traders WHERE id=? AND mesa_id=? FOR UPDATE',
            [traderId, mesaId]
        );
        if (!Array.isArray(rows) || rows.length !== 1) {
            throw new Error('AUTO_TRADER_BINDING_TRADER_NOT_FOUND');
        }

        await connection.query(
            'UPDATE auto_traders SET config_json=? WHERE id=? AND mesa_id=?',
            [JSON.stringify(canonical.config), traderId, mesaId]
        );
        await connection.query(
            'DELETE FROM auto_trader_account_bindings WHERE auto_trader_id=?',
            [traderId]
        );
        for (const accountId of canonical.accountIds) {
            await connection.query(
                `INSERT INTO auto_trader_account_bindings (auto_trader_id, betting_house_id)
                 VALUES (?, ?)`,
                [traderId, accountId]
            );
        }
        await connection.commit();
        return true;
    } catch (error) {
        try { await connection.rollback(); } catch (_) {}
        throw error;
    } finally {
        connection.release();
    }
}

function workersReady(snapshot, accountIds, tableKey) {
    if (!snapshot?.available || snapshot?.stale || snapshot?.supervisor?.running !== true) return false;
    const byId = new Map((snapshot.workers || []).map(worker => [String(worker.session_id), worker]));
    return accountIds.every(accountId => {
        const worker = byId.get(taskId(accountId, tableKey));
        return worker && worker.desired === true && String(worker.status).toUpperCase() === 'READY';
    });
}

async function waitWorkersReady(accountIds, tableKey) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (workersReady(readSupervisorSnapshot(), accountIds, tableKey)) return true;
        await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`AUTO_TRADER_STRUCTURAL_WORKERS_TIMEOUT:${READY_TIMEOUT_MS}`);
}

async function collectBalances(accountIds, tableKey, accountNames = new Map()) {
    const publisher = createClient({ url: redisUrl() });
    const subscriber = createClient({ url: redisUrl() });
    const balances = new Map();
    const resolvers = new Map();
    const requestId = crypto.randomUUID();
    let timeout = null;

    publisher.on('error', error => console.error('AUTO_TRADER_STRUCTURAL_REDIS_PUBLISHER:', error.message));
    subscriber.on('error', error => console.error('AUTO_TRADER_STRUCTURAL_REDIS_SUBSCRIBER:', error.message));

    try {
        await publisher.connect();
        await subscriber.connect();

        const responses = accountIds.map(accountId => new Promise(resolve => {
            resolvers.set(accountId, resolve);
        }));

        for (const accountId of accountIds) {
            const channel = channelsFor(accountId, tableKey).response;
            await subscriber.subscribe(channel, message => {
                let payload = null;
                try { payload = JSON.parse(String(message || '')); } catch (_) { return; }
                if (payload?.action !== 'balance_update') return;
                const balance = Number(payload.balance);
                if (!Number.isFinite(balance) || balance < 0 || balances.has(accountId)) return;
                balances.set(accountId, Math.round(balance * 100) / 100);
                resolvers.get(accountId)?.();
            });
        }

        console.log(
            `AUTO_TRADER_STRUCTURAL_BALANCE_SUBSCRIBED table=${tableKey} accounts=${accountIds.join(',')}`
        );

        for (const accountId of accountIds) {
            await publisher.publish(
                channelsFor(accountId, tableKey).command,
                JSON.stringify({ action: 'sync_balance', request_id: requestId })
            );
        }

        console.log(
            `AUTO_TRADER_STRUCTURAL_BALANCE_REQUESTED table=${tableKey} accounts=${accountIds.join(',')}`
        );

        await Promise.race([
            Promise.all(responses),
            new Promise((_, reject) => {
                timeout = setTimeout(
                    () => reject(new Error(`AUTO_TRADER_STRUCTURAL_BALANCE_TIMEOUT:${BALANCE_TIMEOUT_MS}:${balances.size}/${accountIds.length}`)),
                    BALANCE_TIMEOUT_MS
                );
                if (typeof timeout.unref === 'function') timeout.unref();
            })
        ]);

        if (balances.size !== accountIds.length) {
            throw new Error(`AUTO_TRADER_STRUCTURAL_BALANCE_INCOMPLETE:${balances.size}/${accountIds.length}`);
        }

        let totalCents = 0;
        const accounts = accountIds.map(accountId => {
            const balance = balances.get(accountId);
            totalCents += Math.round(balance * 100);
            return Object.freeze({
                account_id: accountId,
                account_name: String(accountNames.get(accountId) || `Conta ${accountId}`),
                balance
            });
        });
        return Object.freeze({ total: totalCents / 100, accounts: Object.freeze(accounts) });
    } finally {
        if (timeout) clearTimeout(timeout);
        try { if (subscriber.isOpen) await subscriber.quit(); } catch (_) {}
        try { if (publisher.isOpen) await publisher.quit(); } catch (_) {}
    }
}

async function cleanupOrphanBootstrapCarriers(mesaId, pool = createDbPool()) {
    const [result] = await pool.query(
        `DELETE FROM auto_traders
         WHERE mesa_id=?
           AND ativo=false
           AND status_operacao='ATIVANDO'
           AND nome LIKE '__binding_bootstrap__%'`,
        [mesaId]
    );
    const removed = Number(result?.affectedRows) || 0;
    if (removed > 0) {
        console.warn(`AUTO_TRADER_BOOTSTRAP_ORPHANS_REMOVED mesa=${mesaId} count=${removed}`);
    }
    return removed;
}

async function createBootstrapCarrier(mesa, canonical, requestedName, pool = createDbPool()) {
    const name = `__binding_bootstrap__${crypto.randomUUID()}`;
    const [result] = await pool.query(
        `INSERT INTO auto_traders
            (mesa_id, nome, ativo, config_json, saldo_inicial, saldo_atual, status_operacao)
         VALUES (?, ?, false, ?, 0, 0, 'ATIVANDO')`,
        [mesa.id, name, JSON.stringify(canonical.config)]
    );
    const id = Number(result?.insertId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('AUTO_TRADER_BOOTSTRAP_CARRIER_CREATE_FAILED');
    console.log(
        `AUTO_TRADER_CREATE_BOOTSTRAP_PENDING carrier=${id} requested_name=${String(requestedName || '').slice(0, 80)} ` +
        `accounts=${canonical.accountIds.join(',')}`
    );
    return id;
}

async function deleteBootstrapCarrier(carrierId, mesaId, pool = createDbPool()) {
    if (!carrierId) return;
    await pool.query(
        'DELETE FROM auto_traders WHERE id=? AND mesa_id=? AND ativo=false',
        [carrierId, mesaId]
    );
}

async function withLegacyAggregateResponder(balance, callback) {
    const subscriber = createClient({ url: redisUrl() });
    const publisher = createClient({ url: redisUrl() });
    const normalizedBalance = Math.round(Number(balance) * 100) / 100;
    subscriber.on('error', error => console.error('AUTO_TRADER_CREATE_LEGACY_RESPONDER_SUB:', error.message));
    publisher.on('error', error => console.error('AUTO_TRADER_CREATE_LEGACY_RESPONDER_PUB:', error.message));
    try {
        await subscriber.connect();
        await publisher.connect();
        await subscriber.subscribe('auto_trader_commands', async message => {
            let payload = null;
            try { payload = JSON.parse(String(message || '')); } catch (_) { return; }
            if (payload?.action !== 'sync_balance') return;
            await publisher.publish('auto_trader_responses', JSON.stringify({
                action: 'balance_update',
                balance: normalizedBalance,
                source: 'MULTI_ACCOUNT_CREATE_BOOTSTRAP'
            }));
        });
        await publisher.publish('auto_trader_responses', JSON.stringify({
            action: 'balance_update',
            balance: normalizedBalance,
            source: 'MULTI_ACCOUNT_CREATE_BOOTSTRAP_PRIME'
        }));
        await sleep(25);
        return await callback();
    } finally {
        try { if (subscriber.isOpen) await subscriber.quit(); } catch (_) {}
        try { if (publisher.isOpen) await publisher.quit(); } catch (_) {}
    }
}

async function identifyCreatedTrader(afterId, carrierId, mesaId, requestedName, canonical, pool = createDbPool()) {
    const [rows] = await pool.query(
        `SELECT id, nome, config_json
         FROM auto_traders
         WHERE mesa_id=? AND id>? AND id<>?
         ORDER BY id`,
        [mesaId, afterId, carrierId || 0]
    );
    const matches = (rows || []).filter(row => {
        if (String(row.nome || '') !== String(requestedName || '')) return false;
        let config = {};
        try { config = JSON.parse(row.config_json || '{}'); } catch (_) { return false; }
        return JSON.stringify(normalizeAccountIds(config)) === JSON.stringify(canonical.accountIds);
    });
    if (matches.length !== 1) {
        throw new Error(`AUTO_TRADER_CREATE_IDENTIFICATION_AMBIGUOUS:${matches.length}`);
    }
    return Number(matches[0].id);
}

async function captureJsonHandler(handler, req, res, next, invoke) {
    const originalJson = res.json.bind(res);
    let captured = null;
    res.json = body => {
        captured = { body, statusCode: Number(res.statusCode) || 200 };
        return res;
    };
    try {
        await invoke(() => handler(req, res, next));
    } finally {
        res.json = originalJson;
    }
    if (!captured) throw new Error('AUTO_TRADER_API_RESPONSE_NOT_CAPTURED');
    return { ...captured, send: body => originalJson(body) };
}

async function handleCreate(handler, req, res, next) {
    const run = async () => {
        const mesa = obterMesaRuntime();
        const canonical = canonicalConfig(req?.body?.config || {});
        await eligibleAccounts(canonical.accountIds, mesa);
        req.body = { ...(req.body || {}), config: { ...canonical.config } };

        const pool = createDbPool();
        await cleanupOrphanBootstrapCarriers(mesa.id, pool);
        const [[maxRow]] = await pool.query(
            'SELECT COALESCE(MAX(id), 0) AS max_id FROM auto_traders WHERE mesa_id=?',
            [mesa.id]
        );
        const maxIdBefore = Number(maxRow?.max_id) || 0;
        const wantsActive = req.body.ativo === true || req.body.ativo === 1;
        let carrierId = 0;
        let balanceResult = null;

        try {
            if (wantsActive) {
                carrierId = await createBootstrapCarrier(mesa, canonical, req.body.nome, pool);
                const tableKey = String(mesa.codigo || '').trim().toLowerCase();
                await waitWorkersReady(canonical.accountIds, tableKey);
                const accounts = await eligibleAccounts(canonical.accountIds, mesa, pool);
                const names = new Map(accounts.map(item => [item.account_id, item.account_name]));
                balanceResult = await collectBalances(canonical.accountIds, tableKey, names);
                console.log(
                    `AUTO_TRADER_CREATE_BOOTSTRAP_BALANCE_READY carrier=${carrierId} ` +
                    `accounts=${canonical.accountIds.join(',')} aggregate=R$${balanceResult.total.toFixed(2)}`
                );
                await deleteBootstrapCarrier(carrierId, mesa.id, pool);

                const captured = await captureJsonHandler(
                    handler,
                    req,
                    res,
                    next,
                    callback => withLegacyAggregateResponder(balanceResult.total, callback)
                );
                if (captured.statusCode >= 400) return captured.send(captured.body);

                const traderId = await identifyCreatedTrader(
                    maxIdBefore,
                    carrierId,
                    mesa.id,
                    req.body.nome,
                    canonical,
                    pool
                );
                await synchronizeBindings(traderId, mesa.id, canonical, pool);
                console.log(
                    `AUTO_TRADER_CREATE_ACTIVE_READY trader=${traderId} accounts=${canonical.accountIds.join(',')} ` +
                    `aggregate=R$${balanceResult.total.toFixed(2)}`
                );
                return captured.send({
                    ...(captured.body && typeof captured.body === 'object' ? captured.body : {}),
                    trader_id: traderId,
                    saldo_contas: balanceResult.accounts,
                    bindings_synchronized: true
                });
            }

            const captured = await captureJsonHandler(handler, req, res, next, callback => callback());
            if (captured.statusCode >= 400) return captured.send(captured.body);
            const traderId = await identifyCreatedTrader(
                maxIdBefore,
                0,
                mesa.id,
                req.body.nome,
                canonical,
                pool
            );
            await synchronizeBindings(traderId, mesa.id, canonical, pool);
            return captured.send({
                ...(captured.body && typeof captured.body === 'object' ? captured.body : {}),
                trader_id: traderId,
                bindings_synchronized: true
            });
        } finally {
            try { await deleteBootstrapCarrier(carrierId, mesa.id, pool); } catch (error) {
                console.error('AUTO_TRADER_BOOTSTRAP_CARRIER_CLEANUP_FAILED:', error?.message || error);
            }
        }
    };

    const previous = createQueue;
    let release;
    createQueue = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await run(); }
    finally { release(); }
}

async function handleUpdate(handler, req, res, next) {
    const mesa = obterMesaRuntime();
    const traderId = Number(req?.params?.id);
    if (!Number.isSafeInteger(traderId) || traderId <= 0) return handler(req, res, next);
    const canonical = canonicalConfig(req?.body?.config || {});
    await eligibleAccounts(canonical.accountIds, mesa);
    req.body = { ...(req.body || {}), config: { ...canonical.config } };

    const captured = await captureJsonHandler(handler, req, res, next, callback => callback());
    if (captured.statusCode < 400) {
        await synchronizeBindings(traderId, mesa.id, canonical);
        console.log(`AUTO_TRADER_BINDINGS_SYNCED trader=${traderId} accounts=${canonical.accountIds.join(',')}`);
    }
    return captured.send(captured.body);
}

function installAutoTraderStructuralIntegrity() {
    if (installed) return true;
    const proto = express.application;
    if (!proto || typeof proto.post !== 'function' || typeof proto.put !== 'function') {
        throw new Error('AUTO_TRADER_STRUCTURAL_EXPRESS_UNAVAILABLE');
    }

    const originalPost = proto.post;
    const originalPut = proto.put;

    proto.post = function postWithStructuralIntegrity(path, ...handlers) {
        if (path !== '/api/auto-trader') return originalPost.call(this, path, ...handlers);
        const wrapped = handlers.map(handler => typeof handler === 'function'
            ? async function structuralCreate(req, res, next) {
                try { return await handleCreate(handler, req, res, next); }
                catch (error) {
                    console.error('AUTO_TRADER_CREATE_STRUCTURAL_FAILED:', error?.message || error);
                    if (res.headersSent) return undefined;
                    return res.status(Number(error?.statusCode) || 409).json({
                        sucesso: false,
                        erro: 'integridade_vinculos_auto_trader',
                        detalhe: String(error?.message || error)
                    });
                }
            }
            : handler);
        return originalPost.call(this, path, ...wrapped);
    };

    proto.put = function putWithStructuralIntegrity(path, ...handlers) {
        if (path !== '/api/auto-trader/:id') return originalPut.call(this, path, ...handlers);
        const wrapped = handlers.map(handler => typeof handler === 'function'
            ? async function structuralUpdate(req, res, next) {
                try { return await handleUpdate(handler, req, res, next); }
                catch (error) {
                    console.error('AUTO_TRADER_UPDATE_STRUCTURAL_FAILED:', error?.message || error);
                    if (res.headersSent) return undefined;
                    return res.status(Number(error?.statusCode) || 409).json({
                        sucesso: false,
                        erro: 'integridade_vinculos_auto_trader',
                        detalhe: String(error?.message || error)
                    });
                }
            }
            : handler);
        return originalPut.call(this, path, ...wrapped);
    };

    installed = true;
    console.log('AUTO_TRADER_STRUCTURAL_INTEGRITY_READY=true');
    return true;
}

module.exports = Object.freeze({
    normalizeAccountIds,
    canonicalConfig,
    workersReady,
    synchronizeBindings,
    cleanupOrphanBootstrapCarriers,
    installAutoTraderStructuralIntegrity
});
