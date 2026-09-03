'use strict';

const express = require('express');
const mysql = require('mysql2/promise');

const { obterMesaRuntime } = require('./mesa_runtime_context');

const OPEN_FINANCIAL_STATUSES = Object.freeze([
    'PREPARANDO',
    'PENDENTE',
    'ENVIO_AMBIGUO'
]);

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

    const [traders] = await pool.query(
        `SELECT id, ativo, status_operacao
         FROM auto_traders
         WHERE id=? AND mesa_id=?
         LIMIT 1`,
        [traderId, mesa.id]
    );

    if (!Array.isArray(traders) || traders.length !== 1) return null;

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

    const openOrder = Array.isArray(openOrders) && openOrders.length > 0
        ? openOrders[0]
        : null;

    return Object.freeze({
        traderId,
        mesa,
        trader: { ...traders[0] },
        openOrder: openOrder ? { ...openOrder } : null
    });
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
                                'O Auto-Trader não pode ser reativado enquanto existir uma ordem/intenção financeira aberta.',
                            ordem_id: Number(state.openOrder.id),
                            status_ordem: String(state.openOrder.status_ordem || '')
                        });
                    }

                    if (
                        (state.trader.ativo === false || state.trader.ativo === 0)
                        && String(state.trader.status_operacao || '').toUpperCase() === 'BLOQUEADO_AMBIGUIDADE'
                    ) {
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
    wantsActivation,
    positiveTraderId,
    installAutoTraderAmbiguityReactivationGuard
});
