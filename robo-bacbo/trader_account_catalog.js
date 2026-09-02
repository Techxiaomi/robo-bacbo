'use strict';

const express = require('express');
const mysql = require('mysql2/promise');
const { obterMesaRuntime } = require('./mesa_runtime_context');

const SUPPORTED_ADAPTER_KEY = 'brasil-da-sorte';
let installed = false;
let getOriginal = null;
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

async function listEligibleTraderAccounts() {
    const mesa = obterMesaRuntime();
    const pool = createDbPool();
    const [rows] = await pool.query(
        `SELECT h.id AS account_id,
                h.name AS account_name,
                h.adapter_key,
                t.table_key,
                t.display_name AS table_name
         FROM betting_houses h
         INNER JOIN betting_house_tables t
            ON t.betting_house_id = h.id
           AND t.enabled = true
           AND LOWER(t.table_key) = LOWER(?)
         WHERE h.enabled = true
           AND h.adapter_key = ?
         ORDER BY h.id`,
        [mesa.codigo, SUPPORTED_ADAPTER_KEY]
    );

    return (rows || []).map(row => Object.freeze({
        account_id: Number(row.account_id),
        account_name: String(row.account_name || ''),
        adapter_key: String(row.adapter_key || ''),
        table_key: String(row.table_key || '').toLowerCase(),
        table_name: String(row.table_name || row.table_key || '')
    }));
}

async function handler(req, res) {
    try {
        const mesa = obterMesaRuntime();
        const accounts = await listEligibleTraderAccounts();
        return res.json({
            success: true,
            table_code: mesa.codigo,
            accounts
        });
    } catch (error) {
        console.error('TRADER_ACCOUNT_CATALOG_FAILED:', error?.message || error);
        return res.status(500).json({
            success: false,
            error: 'trader_account_catalog_failed'
        });
    }
}

function instalarCatalogoContasAutoTrader() {
    if (installed) return true;
    const proto = express.application;
    if (!proto || typeof proto.get !== 'function') {
        throw new Error('TRADER_ACCOUNT_CATALOG_EXPRESS_GET_UNAVAILABLE');
    }

    getOriginal = proto.get;
    proto.get = function getComCatalogo(path, ...handlers) {
        if (
            path === '/api/auto-traders'
            && !this.locals.__traderAccountCatalogInstalled
        ) {
            this.locals.__traderAccountCatalogInstalled = true;
            getOriginal.call(this, '/api/trader-account-catalog', handler);
            console.log('TRADER_ACCOUNT_CATALOG_ROUTE_INSTALLED=true anchor=/api/auto-traders');
        }
        return getOriginal.call(this, path, ...handlers);
    };

    installed = true;
    console.log('TRADER_ACCOUNT_CATALOG_READY=true mode=AUTH_ORDER_ANCHORED');
    return true;
}

module.exports = {
    SUPPORTED_ADAPTER_KEY,
    listEligibleTraderAccounts,
    instalarCatalogoContasAutoTrader
};
