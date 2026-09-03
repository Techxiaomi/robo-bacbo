'use strict';

const express = require('express');
const mysql = require('mysql2/promise');

const { obterMesaRuntime } = require('./mesa_runtime_context');

const OPEN_FINANCIAL_STATUSES = Object.freeze([
    'PREPARANDO',
    'PENDENTE',
    'ENVIO_AMBIGUO'
]);

const AUTO_RECONCILE_METHOD = 'AUTO_REACTIVATION_NO_EVIDENCE';

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
        connectionLimit: 1,
        queueLimit: 0
    });
    return dbPool;
}

function wantsActivation(req) {
    return req?.body?.ativo === true || req?.body?.ativo === 1;
}

function positiveTraderId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function hasValue(value) {
    return value !== null && value !== undefined && String(value).trim() !== '';
}

function ambiguityHasExecutionEvidence(order = {}) {
    return hasValue(order.executor_confirmacao_metodo)
        || order.executor_saldo_antes !== null && order.executor_saldo_antes !== undefined
        || order.executor_saldo_depois !== null && order.executor_saldo_depois !== undefined
        || order.executor_debito_observado !== null && order.executor_debito_observado !== undefined
        || order.execucao_confirmada_em !== null && order.execucao_confirmada_em !== undefined
        || order.resultado_confirmado_em !== null && order.resultado_confirmado_em !== undefined
        || order.saldo_pos_confirmado_em !== null && order.saldo_pos_confirmado_em !== undefined;
}

function traderIsAmbiguityBlocked(trader = {}) {
    const ativo = trader.ativo === true || trader.ativo === 1;
    return !ativo
        && String(trader.status_operacao || '').toUpperCase() === 'BLOQUEADO_AMBIGUIDADE';
}

async function reconcileEmptyAmbiguities(connection, traderId, mesaId) {
    const [rows] = await connection.query(
        `SELECT id, status_ordem, executor_order_id,
                executor_confirmacao_metodo,
                executor_saldo_antes, executor_saldo_depois,
                executor_debito_observado, execucao_confirmada_em,
                resultado_confirmado_em, saldo_pos_confirmado_em
         FROM auditoria_ordens
         WHERE trader_id=?
           AND mesa_id=?
           AND status_ordem='ENVIO_AMBIGUO'
         ORDER BY id ASC
         FOR UPDATE`,
        [traderId, mesaId]
    );

    const safeIds = (rows || [])
        .filter(order => !ambiguityHasExecutionEvidence(order))
        .map(order => Number(order.id))
        .filter(id => Number.isSafeInteger(id) && id > 0);

    if (safeIds.length === 0) return [];

    const placeholders = safeIds.map(() => '?').join(',');
    const [result] = await connection.query(
        `UPDATE auditoria_ordens
         SET status_ordem='FALHOU',
             executor_confirmacao_metodo=?
         WHERE trader_id=?
           AND mesa_id=?
           AND status_ordem='ENVIO_AMBIGUO'
           AND executor_confirmacao_metodo IS NULL
           AND executor_saldo_antes IS NULL
           AND executor_saldo_depois IS NULL
           AND executor_debito_observado IS NULL
           AND execucao_confirmada_em IS NULL
           AND resultado_confirmado_em IS NULL
           AND saldo_pos_confirmado_em IS NULL
           AND id IN (${placeholders})`,
        [AUTO_RECONCILE_METHOD, traderId, mesaId, ...safeIds]
    );

    if (Number(result?.affectedRows) !== safeIds.length) {
        throw new Error(
            `AUTO_TRADER_AMBIGUITY_RECONCILE_CONFLICT:${Number(result?.affectedRows)}/${safeIds.length}`
        );
    }

    return safeIds;
}

async function inspectActivationState(req) {
    if (!wantsActivation(req)) return null;

    const traderId = positiveTraderId(req?.params?.id);
    if (!traderId) {
        const error = new Error('AUTO_TRADER_REACTIVATION_INVALID_TRADER_ID');
        error.statusCode = 400;
        throw error;
    }

    const mesa = obterMesaRuntime();
    const pool = createDbPool();
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        const [traders] = await connection.query(
            `SELECT id, ativo, status_operacao
             FROM auto_traders
             WHERE id=? AND mesa_id=?
             LIMIT 1
             FOR UPDATE`,
            [traderId, mesa.id]
        );

        if (!Array.isArray(traders) || traders.length !== 1) {
            await connection.commit();
            return null;
        }

        const trader = { ...traders[0] };
        let reconciledOrderIds = [];

        if (traderIsAmbiguityBlocked(trader)) {
            reconciledOrderIds = await reconcileEmptyAmbiguities(
                connection,
                traderId,
                mesa.id
            );
        }

        const [openOrders] = await connection.query(
            `SELECT id, status_ordem, executor_order_id
             FROM auditoria_ordens
             WHERE trader_id=?
               AND mesa_id=?
               AND status_ordem IN ('PREPARANDO','PENDENTE','ENVIO_AMBIGUO')
             ORDER BY id ASC
             LIMIT 1
             FOR UPDATE`,
            [traderId, mesa.id]
        );

        await connection.commit();

        const openOrder = Array.isArray(openOrders) && openOrders.length > 0
            ? openOrders[0]
            : null;

        return Object.freeze({
            traderId,
            mesa,
            trader,
            reconciledOrderIds: Object.freeze([...reconciledOrderIds]),
            openOrder: openOrder ? { ...openOrder } : null
        });
    } catch (error) {
        try { await connection.rollback(); } catch (_) {}
        throw error;
    } finally {
        connection.release();
    }
}

function installAutoTraderAmbiguityReactivationGuard() {
    if (installed) return true;

    const proto = express.application;
    if (!proto || typeof proto.put !== 'function') {
        throw new Error('AUTO_TRADER_REACTIVATION_EXPRESS_PUT_UNAVAILABLE');
    }

    putOriginal = proto.put;
    proto.put = function putWithAmbiguityReactivationGuard(path, ...handlers) {
        if (path !== '/api/auto-trader/:id' || handlers.length === 0) {
            return putOriginal.call(this, path, ...handlers);
        }

        const wrapped = handlers.map(handler => {
            if (typeof handler !== 'function') return handler;

            return async function ambiguityReactivationMiddleware(req, res, next) {
                try {
                    const state = await inspectActivationState(req);
                    if (!state) return handler(req, res, next);

                    if (state.reconciledOrderIds.length > 0) {
                        console.warn(
                            `AUTO_TRADER_AMBIGUITY_AUTO_RECONCILED trader=${state.traderId} ` +
                            `table=${String(state.mesa.codigo || '').toLowerCase()} ` +
                            `orders=${state.reconciledOrderIds.join(',')} method=${AUTO_RECONCILE_METHOD}`
                        );
                    }

                    if (state.openOrder) {
                        console.warn(
                            `AUTO_TRADER_REACTIVATION_BLOCKED_OPEN_ORDER trader=${state.traderId} ` +
                            `table=${String(state.mesa.codigo || '').toLowerCase()} ` +
                            `order_audit_id=${state.openOrder.id} status=${state.openOrder.status_ordem}`
                        );
                        return res.status(409).json({
                            sucesso: false,
                            erro: 'ordem_financeira_aberta',
                            mensagem:
                                'O Auto-Trader não pode ser reativado enquanto existir uma ordem/intenção financeira aberta com evidência pendente de reconciliação.',
                            ordem_id: Number(state.openOrder.id),
                            status_ordem: String(state.openOrder.status_ordem || '')
                        });
                    }

                    if (traderIsAmbiguityBlocked(state.trader)) {
                        console.log(
                            `AUTO_TRADER_AMBIGUITY_BLOCK_CLEARED_ON_REACTIVATION trader=${state.traderId} ` +
                            `table=${String(state.mesa.codigo || '').toLowerCase()} open_orders=0`
                        );
                    }

                    return handler(req, res, next);
                } catch (error) {
                    if (res.headersSent) return undefined;
                    console.error(
                        'AUTO_TRADER_REACTIVATION_GUARD_FAILED:',
                        error?.message || error
                    );
                    return res.status(Number(error?.statusCode) || 503).json({
                        sucesso: false,
                        erro: 'reactivation_guard_unavailable',
                        mensagem:
                            'Não foi possível validar com segurança o estado financeiro do Auto-Trader. Ele permaneceu desligado.',
                        detalhe: String(error?.message || error)
                    });
                }
            };
        });

        return putOriginal.call(this, path, ...wrapped);
    };

    installed = true;
    console.log('AUTO_TRADER_AMBIGUITY_REACTIVATION_GUARD_READY=true');
    return true;
}

module.exports = Object.freeze({
    OPEN_FINANCIAL_STATUSES,
    AUTO_RECONCILE_METHOD,
    wantsActivation,
    positiveTraderId,
    ambiguityHasExecutionEvidence,
    traderIsAmbiguityBlocked,
    installAutoTraderAmbiguityReactivationGuard
});
