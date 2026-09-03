'use strict';

const crypto = require('crypto');
const express = require('express');
const mysql = require('mysql2/promise');
const { createClient } = require('redis');

const { normalizarConfigAutoTrader, estadoInicialCiclo } = require('./auto_trader');
const { validarPoliticaProtecao } = require('./tie_protection');
const { obterMesaRuntime } = require('./mesa_runtime_context');
const { readSupervisorSnapshot } = require('./supervisor_telemetry_store');
const { signalSupervisorReconcile } = require('./supervisor_reconcile_signal');

const READY_TIMEOUT_MS = 120000;
const BALANCE_TIMEOUT_MS = 20000;
const POLL_INTERVAL_MS = 250;
const SUPPORTED_ADAPTER_KEY = 'brasil-da-sorte';

let installed = false;
let putOriginal = null;
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
        connectionLimit: 3,
        queueLimit: 0
    });
    return dbPool;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function positiveId(value, label) {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) {
        const error = new Error(`AUTO_TRADER_ACTIVATION_INVALID_${label}`);
        error.statusCode = 400;
        throw error;
    }
    return id;
}

function normalizeAccountIds(config) {
    const values = Array.isArray(config?.account_ids) ? config.account_ids : [];
    return Array.from(new Set(values.map(Number).filter(id => Number.isSafeInteger(id) && id > 0)))
        .sort((a, b) => a - b);
}

function parseStoredConfig(value) {
    if (!value) return {};
    if (Buffer.isBuffer(value)) value = value.toString('utf8');
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(String(value));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
        return {};
    }
}

function sameAccountIds(leftConfig, rightConfig) {
    const left = normalizeAccountIds(leftConfig);
    const right = normalizeAccountIds(rightConfig);
    return left.length === right.length && left.every((id, index) => id === right[index]);
}

function taskId(accountId, tableKey) {
    return `account-${accountId}:${tableKey}`;
}

function channelsFor(accountId, tableKey) {
    return Object.freeze({
        command: `auto_trader_commands:${accountId}:${tableKey}`,
        response: `auto_trader_responses:${accountId}:${tableKey}`
    });
}

async function loadActivationContext(req) {
    const activationStartedAt = Date.now();
    const traderId = positiveId(req?.params?.id, 'TRADER_ID');
    const mesa = obterMesaRuntime();
    const pool = createDbPool();
    const [rows] = await pool.query(
        `SELECT id, mesa_id, nome, ativo, config_json, saldo_inicial, saldo_atual,
                status_operacao, reds_consecutivos, stop_reds_pausado_ate,
                trailing_pico_lucro, estado_ciclo, reds_virtuais_observados,
                sinais_operados_onda, ciclos_concluidos, pulos_restantes
         FROM auto_traders
         WHERE id=? AND mesa_id=?
         LIMIT 1`,
        [traderId, mesa.id]
    );
    if (!Array.isArray(rows) || rows.length !== 1) {
        const error = new Error('AUTO_TRADER_ACTIVATION_TRADER_NOT_FOUND');
        error.statusCode = 404;
        throw error;
    }

    const existing = rows[0];
    const wantsActive = req?.body?.ativo === true || req?.body?.ativo === 1;
    const wasActive = existing.ativo === true || existing.ativo === 1;
    if (!wantsActive) return null;

    const config = normalizarConfigAutoTrader(req?.body?.config || {});
    const previousConfig = parseStoredConfig(existing.config_json);
    const previousAccountIds = normalizeAccountIds(previousConfig);
    const accountIds = normalizeAccountIds(config);
    const mode = wasActive
        ? (sameAccountIds(previousConfig, config) ? null : 'ACTIVE_REBIND')
        : 'ACTIVATION';
    if (!mode) return null;

    const tiePolicy = validarPoliticaProtecao(config);
    if (!tiePolicy.ok) {
        const error = new Error(tiePolicy.motivo || 'AUTO_TRADER_ACTIVATION_TIE_POLICY_INVALID');
        error.statusCode = 400;
        throw error;
    }

    if (accountIds.length === 0) {
        const error = new Error('AUTO_TRADER_ACTIVATION_ACCOUNTS_REQUIRED');
        error.statusCode = 409;
        throw error;
    }

    if (mode === 'ACTIVE_REBIND') {
        const [openOrders] = await pool.query(
            `SELECT id, status_ordem, executor_order_id
             FROM auditoria_ordens
             WHERE trader_id=?
               AND mesa_id=?
               AND status_ordem IN ('PREPARANDO','PENDENTE','ENVIO_AMBIGUO')
             ORDER BY id ASC
             LIMIT 1`,
            [traderId, mesa.id]
        );
        if (Array.isArray(openOrders) && openOrders.length > 0) {
            const error = new Error(`AUTO_TRADER_REBIND_OPEN_FINANCIAL_ORDER:${openOrders[0].id}`);
            error.statusCode = 409;
            throw error;
        }
    }

    const placeholders = accountIds.map(() => '?').join(',');
    const [accounts] = await pool.query(
        `SELECT h.id AS account_id, h.name AS account_name,
                LOWER(t.table_key) AS table_key
         FROM betting_houses h
         INNER JOIN betting_house_tables t
            ON t.betting_house_id=h.id
           AND t.enabled=true
           AND LOWER(t.table_key)=LOWER(?)
         WHERE h.id IN (${placeholders})
           AND h.enabled=true
           AND h.adapter_key=?
         ORDER BY h.id`,
        [mesa.codigo, ...accountIds, SUPPORTED_ADAPTER_KEY]
    );

    const eligibleIds = new Set((accounts || []).map(row => Number(row.account_id)));
    const missing = accountIds.filter(id => !eligibleIds.has(id));
    if (missing.length > 0) {
        const error = new Error(`AUTO_TRADER_ACTIVATION_ACCOUNT_UNAVAILABLE: ${missing.join(',')}`);
        error.statusCode = 409;
        throw error;
    }

    return Object.freeze({
        activationStartedAt,
        traderId,
        mesa,
        tableKey: String(mesa.codigo || '').trim().toLowerCase(),
        mode,
        wasActive,
        config,
        configJson: JSON.stringify(config),
        previousAccountIds,
        accountIds,
        accounts: (accounts || []).map(row => Object.freeze({
            id: Number(row.account_id),
            name: String(row.account_name || `Conta ${row.account_id}`)
        })),
        requestedName: String(req?.body?.nome || existing.nome || '').trim(),
        existing: { ...existing }
    });
}

async function markActivating(context) {
    const expectedActive = context.wasActive ? 1 : 0;
    const [result] = await createDbPool().query(
        `UPDATE auto_traders
         SET nome=?, config_json=?, ativo=false, status_operacao='ATIVANDO'
         WHERE id=? AND mesa_id=? AND ativo=?`,
        [context.requestedName, context.configJson, context.traderId, context.mesa.id, expectedActive]
    );
    if (Number(result?.affectedRows) !== 1) {
        throw new Error(
            context.mode === 'ACTIVE_REBIND'
                ? 'AUTO_TRADER_REBIND_STATE_CONFLICT'
                : 'AUTO_TRADER_ACTIVATION_STATE_CONFLICT'
        );
    }

    if (context.mode === 'ACTIVE_REBIND') {
        console.log(
            `AUTO_TRADER_ACTIVE_REBIND_PENDING trader=${context.traderId} table=${context.tableKey} ` +
            `previous_accounts=${context.previousAccountIds.join(',')} accounts=${context.accountIds.join(',')}`
        );
    } else {
        console.log(
            `AUTO_TRADER_ACTIVATION_PENDING trader=${context.traderId} table=${context.tableKey} ` +
            `accounts=${context.accountIds.join(',')}`
        );
    }

    const wakeDelivered = signalSupervisorReconcile(
        context.mode === 'ACTIVE_REBIND' ? 'AUTO_TRADER_ACTIVE_REBIND' : 'AUTO_TRADER_ACTIVATION',
        {
            trader_id: context.traderId,
            table_key: context.tableKey,
            account_ids: context.accountIds
        }
    );
    console.log(
        `AUTO_TRADER_ACTIVATION_SUPERVISOR_WAKE trader=${context.traderId} delivered=${wakeDelivered} ` +
        `elapsed_ms=${Date.now() - context.activationStartedAt}`
    );
}

async function restorePreviousState(context, reason) {
    const previous = context.existing;
    const previousActive = previous.ativo === true || previous.ativo === 1 ? 1 : 0;
    const previousStatus = previousActive === 0 && previous.status_operacao === 'ATIVANDO'
        ? 'DESLIGADO'
        : previous.status_operacao;
    await createDbPool().query(
        `UPDATE auto_traders
         SET nome=?, ativo=?, config_json=?, saldo_inicial=?, saldo_atual=?,
             status_operacao=?, reds_consecutivos=?, stop_reds_pausado_ate=?,
             trailing_pico_lucro=?, estado_ciclo=?, reds_virtuais_observados=?,
             sinais_operados_onda=?, ciclos_concluidos=?, pulos_restantes=?
         WHERE id=? AND mesa_id=?`,
        [
            previous.nome,
            previousActive,
            previous.config_json,
            previous.saldo_inicial,
            previous.saldo_atual,
            previousStatus,
            previous.reds_consecutivos,
            previous.stop_reds_pausado_ate,
            previous.trailing_pico_lucro,
            previous.estado_ciclo,
            previous.reds_virtuais_observados,
            previous.sinais_operados_onda,
            previous.ciclos_concluidos,
            previous.pulos_restantes,
            context.traderId,
            context.mesa.id
        ]
    );
    console.warn(
        `${context.mode === 'ACTIVE_REBIND' ? 'AUTO_TRADER_ACTIVE_REBIND_ROLLBACK' : 'AUTO_TRADER_ACTIVATION_ROLLBACK'} ` +
        `trader=${context.traderId} reason=${String(reason || 'UNKNOWN').slice(0, 300)}`
    );
    signalSupervisorReconcile('AUTO_TRADER_ACTIVATION_ROLLBACK', {
        trader_id: context.traderId,
        table_key: context.tableKey,
        account_ids: context.accountIds
    });
}

function readyWorkers(snapshot, context) {
    if (!snapshot?.available || snapshot?.stale || snapshot?.supervisor?.running !== true) {
        return false;
    }
    const byId = new Map((snapshot.workers || []).map(worker => [String(worker.session_id), worker]));
    return context.accountIds.every(accountId => {
        const worker = byId.get(taskId(accountId, context.tableKey));
        return worker && worker.desired === true && String(worker.status).toUpperCase() === 'READY';
    });
}

async function waitWorkersReady(context) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const snapshot = readSupervisorSnapshot();
        if (readyWorkers(snapshot, context)) {
            console.log(
                `AUTO_TRADER_ACTIVATION_WORKERS_READY trader=${context.traderId} ` +
                `accounts=${context.accountIds.join(',')} ` +
                `elapsed_ms=${Date.now() - context.activationStartedAt}`
            );
            return true;
        }
        await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`AUTO_TRADER_ACTIVATION_WORKERS_TIMEOUT:${READY_TIMEOUT_MS}`);
}

async function collectLinkedBalances(context) {
    const balanceStartedAt = Date.now();
    const redisUrl = String(process.env.REDIS_URL || 'redis://127.0.0.1:6379').trim();
    const publisher = createClient({ url: redisUrl });
    const subscriber = createClient({ url: redisUrl });
    const balances = new Map();
    const waiters = new Map();
    const requestId = crypto.randomUUID();

    publisher.on('error', error => console.error('AUTO_TRADER_ACTIVATION_REDIS_PUBLISHER:', error.message));
    subscriber.on('error', error => console.error('AUTO_TRADER_ACTIVATION_REDIS_SUBSCRIBER:', error.message));

    try {
        await publisher.connect();
        await subscriber.connect();

        for (const accountId of context.accountIds) {
            const channel = channelsFor(accountId, context.tableKey).response;
            const promise = new Promise(resolve => waiters.set(accountId, resolve));
            waiters.set(`${accountId}:promise`, promise);
            await subscriber.subscribe(channel, message => {
                let payload = null;
                try { payload = JSON.parse(String(message || '')); } catch (_) { return; }
                if (payload?.action !== 'balance_update') return;
                const balance = Number(payload.balance);
                if (!Number.isFinite(balance) || balance < 0 || balances.has(accountId)) return;
                balances.set(accountId, Number(balance.toFixed(2)));
                const resolve = waiters.get(accountId);
                if (typeof resolve === 'function') resolve();
            });
        }

        for (const accountId of context.accountIds) {
            const channel = channelsFor(accountId, context.tableKey).command;
            await publisher.publish(channel, JSON.stringify({
                action: 'sync_balance',
                request_id: requestId,
                routed_account_id: accountId,
                routed_session_id: taskId(accountId, context.tableKey),
                routed_table_key: context.tableKey
            }));
        }

        const pending = context.accountIds.map(accountId => waiters.get(`${accountId}:promise`));
        await Promise.race([
            Promise.all(pending),
            new Promise((_, reject) => {
                const timer = setTimeout(
                    () => reject(new Error(`AUTO_TRADER_ACTIVATION_BALANCE_TIMEOUT:${BALANCE_TIMEOUT_MS}`)),
                    BALANCE_TIMEOUT_MS
                );
                if (typeof timer.unref === 'function') timer.unref();
            })
        ]);

        if (balances.size !== context.accountIds.length) {
            throw new Error(
                `AUTO_TRADER_ACTIVATION_BALANCE_INCOMPLETE:${balances.size}/${context.accountIds.length}`
            );
        }

        const accounts = context.accounts.map(account => Object.freeze({
            account_id: account.id,
            account_name: account.name,
            balance: balances.get(account.id)
        }));
        const total = Number(
            accounts.reduce((sum, account) => sum + account.balance, 0).toFixed(2)
        );

        console.log(
            `AUTO_TRADER_ACTIVATION_BALANCE_READY trader=${context.traderId} ` +
            `accounts=${accounts.map(item => `${item.account_id}=R$${item.balance.toFixed(2)}`).join(',')} ` +
            `aggregate=R$${total.toFixed(2)} ` +
            `balance_wait_ms=${Date.now() - balanceStartedAt} ` +
            `activation_elapsed_ms=${Date.now() - context.activationStartedAt}`
        );

        return Object.freeze({ total, accounts: Object.freeze(accounts) });
    } finally {
        try { if (subscriber.isOpen) await subscriber.quit(); } catch (_) {}
        try { if (publisher.isOpen) await publisher.quit(); } catch (_) {}
    }
}

async function primeActivation(context, balanceResult) {
    const state = estadoInicialCiclo();
    const [result] = await createDbPool().query(
        `UPDATE auto_traders
         SET ativo=true, nome=?, config_json=?, saldo_inicial=?, saldo_atual=?,
             status_operacao='STANDBY', reds_consecutivos=0,
             stop_reds_pausado_ate=0, trailing_pico_lucro=0,
             estado_ciclo=?, reds_virtuais_observados=?, sinais_operados_onda=?,
             ciclos_concluidos=?, pulos_restantes=?
         WHERE id=? AND mesa_id=? AND ativo=false AND status_operacao='ATIVANDO'`,
        [
            context.requestedName,
            context.configJson,
            balanceResult.total,
            balanceResult.total,
            state.estado_ciclo,
            state.reds_virtuais_observados,
            state.sinais_operados_onda,
            state.ciclos_concluidos,
            state.pulos_restantes,
            context.traderId,
            context.mesa.id
        ]
    );
    if (Number(result?.affectedRows) !== 1) {
        throw new Error('AUTO_TRADER_ACTIVATION_COMMIT_CONFLICT');
    }
    console.log(
        `AUTO_TRADER_ACTIVATION_COMMITTED trader=${context.traderId} ` +
        `elapsed_ms=${Date.now() - context.activationStartedAt}`
    );
}

function installActivationBootstrap() {
    if (installed) return true;
    const proto = express.application;
    if (!proto || typeof proto.put !== 'function') {
        throw new Error('AUTO_TRADER_ACTIVATION_EXPRESS_PUT_UNAVAILABLE');
    }

    putOriginal = proto.put;
    proto.put = function putWithLinkedActivation(path, ...handlers) {
        if (path !== '/api/auto-trader/:id' || handlers.length === 0) {
            return putOriginal.call(this, path, ...handlers);
        }

        const wrapped = handlers.map(handler => {
            if (typeof handler !== 'function') return handler;
            return async function linkedActivationMiddleware(req, res, next) {
                let context = null;
                let primed = false;
                let balanceResult = null;
                const originalJson = res.json.bind(res);

                try {
                    context = await loadActivationContext(req);
                    if (!context) return handler(req, res, next);

                    await markActivating(context);
                    await waitWorkersReady(context);
                    balanceResult = await collectLinkedBalances(context);
                    await primeActivation(context, balanceResult);
                    primed = true;

                    res.json = body => originalJson({
                        ...(body && typeof body === 'object' ? body : {}),
                        baseline_recapturado: true,
                        binding_reconfigurado: context.mode === 'ACTIVE_REBIND',
                        binding_anterior: context.previousAccountIds,
                        binding_atual: context.accountIds,
                        saldo_inicial: balanceResult.total,
                        saldo_contas: balanceResult.accounts
                    });

                    await handler(req, res, next);
                    if (res.statusCode >= 400) {
                        await restorePreviousState(context, `DOWNSTREAM_HTTP_${res.statusCode}`);
                    }
                    return undefined;
                } catch (error) {
                    if (context) {
                        try { await restorePreviousState(context, error?.message || error); } catch (rollbackError) {
                            console.error('AUTO_TRADER_ACTIVATION_ROLLBACK_FAILED:', rollbackError?.message || rollbackError);
                        }
                    }
                    if (res.headersSent) return undefined;
                    const statusCode = Number(error?.statusCode) || 409;
                    res.status(statusCode);
                    return originalJson({
                        sucesso: false,
                        erro: 'saldo_contas_vinculadas_indisponivel',
                        mensagem: context?.mode === 'ACTIVE_REBIND'
                            ? 'Não foi possível confirmar o saldo real de todas as novas contas vinculadas. A configuração ativa anterior foi restaurada.'
                            : 'Não foi possível confirmar o saldo real de todas as contas vinculadas. O Auto-Trader permaneceu desligado.',
                        detalhe: String(error?.message || error),
                        primed
                    });
                } finally {
                    res.json = originalJson;
                }
            };
        });

        return putOriginal.call(this, path, ...wrapped);
    };

    installed = true;
    console.log('AUTO_TRADER_ACTIVATION_BOOTSTRAP_READY=true');
    return true;
}

module.exports = Object.freeze({
    READY_TIMEOUT_MS,
    BALANCE_TIMEOUT_MS,
    normalizeAccountIds,
    sameAccountIds,
    taskId,
    channelsFor,
    readyWorkers,
    installActivationBootstrap
});
