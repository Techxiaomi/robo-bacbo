'use strict';

const SUPPORTED_LIVE_BRIDGE_ADAPTERS = new Set(['brasil-da-sorte']);

function positiveId(value, fieldName) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) {
        throw new Error(`TRADER_ACCOUNT_BINDING_INVALID_${fieldName}: ${value}`);
    }
    return number;
}

function normalizeAccountIds(values) {
    const source = Array.isArray(values) ? values : [values];
    const unique = new Set();
    for (const value of source) {
        if (value === undefined || value === null || String(value).trim() === '') continue;
        unique.add(positiveId(value, 'ACCOUNT_ID'));
    }
    return Array.from(unique).sort((a, b) => a - b);
}

function accountIdsFromConfig(configJson) {
    let config = configJson;
    if (typeof configJson === 'string') {
        try { config = JSON.parse(configJson); }
        catch (_) { return []; }
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) return [];
    try { return normalizeAccountIds(Array.isArray(config.account_ids) ? config.account_ids : []); }
    catch (_) { return []; }
}

function liveBridgeAdapterSupported(value) {
    return SUPPORTED_LIVE_BRIDGE_ADAPTERS.has(String(value || '').trim().toLowerCase());
}

function configWithAccountIds(configJson, accountIds) {
    let config = {};
    if (configJson && typeof configJson === 'object' && !Array.isArray(configJson)) {
        config = { ...configJson };
    } else if (typeof configJson === 'string' && configJson.trim()) {
        try {
            const parsed = JSON.parse(configJson);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = { ...parsed };
        } catch (_) {}
    }
    config.account_ids = normalizeAccountIds(accountIds);
    return config;
}

async function traderDescriptor(dbPool, traderId) {
    const id = positiveId(traderId, 'TRADER_ID');
    const [rows] = await dbPool.query(
        `SELECT at.id, at.nome, at.ativo, at.mesa_id, at.config_json,
                m.codigo AS mesa_codigo, m.nome AS mesa_nome
         FROM auto_traders at
         INNER JOIN mesas m ON m.id = at.mesa_id
         WHERE at.id = ?
         LIMIT 1`,
        [id]
    );
    if (!Array.isArray(rows) || rows.length !== 1) {
        throw new Error(`TRADER_ACCOUNT_BINDING_TRADER_NOT_FOUND: ${id}`);
    }
    return rows[0];
}

async function validateAccountsForTrader(dbPool, trader, accountIds) {
    if (accountIds.length === 0) return [];
    const placeholders = accountIds.map(() => '?').join(',');
    const [rows] = await dbPool.query(
        `SELECT h.id, h.name, h.adapter_key, h.enabled,
                t.table_key, t.display_name, t.enabled AS table_enabled
         FROM betting_houses h
         LEFT JOIN betting_house_tables t
           ON t.betting_house_id = h.id
          AND LOWER(t.table_key) = LOWER(?)
         WHERE h.id IN (${placeholders})
         ORDER BY h.id`,
        [trader.mesa_codigo, ...accountIds]
    );

    const byId = new Map((rows || []).map(row => [Number(row.id), row]));
    for (const accountId of accountIds) {
        const row = byId.get(accountId);
        if (!row) {
            throw new Error(`TRADER_ACCOUNT_BINDING_ACCOUNT_NOT_FOUND: ${accountId}`);
        }
        if (!liveBridgeAdapterSupported(row.adapter_key)) {
            throw new Error(
                `TRADER_ACCOUNT_BINDING_ADAPTER_UNSUPPORTED: account=${accountId} adapter=${row.adapter_key || '<empty>'}`
            );
        }
        if (!row.table_key) {
            throw new Error(
                `TRADER_ACCOUNT_BINDING_TABLE_NOT_CONFIGURED: account=${accountId} table=${trader.mesa_codigo}`
            );
        }
    }
    return accountIds.map(accountId => byId.get(accountId));
}

async function setTraderAccounts(dbPool, traderId, accountIds) {
    const trader = await traderDescriptor(dbPool, traderId);
    const normalized = normalizeAccountIds(accountIds);
    const accounts = await validateAccountsForTrader(dbPool, trader, normalized);
    const connection = await dbPool.getConnection();
    try {
        await connection.beginTransaction();
        await connection.query(
            'DELETE FROM auto_trader_account_bindings WHERE auto_trader_id=?',
            [Number(trader.id)]
        );
        for (const accountId of normalized) {
            await connection.query(
                `INSERT INTO auto_trader_account_bindings
                    (auto_trader_id, betting_house_id)
                 VALUES (?, ?)`,
                [Number(trader.id), accountId]
            );
        }
        const config = configWithAccountIds(trader.config_json, normalized);
        await connection.query(
            'UPDATE auto_traders SET config_json=? WHERE id=?',
            [JSON.stringify(config), Number(trader.id)]
        );
        await connection.commit();
    } catch (error) {
        try { await connection.rollback(); } catch (_) {}
        throw error;
    } finally {
        connection.release();
    }

    return {
        trader: {
            id: Number(trader.id),
            nome: String(trader.nome || ''),
            ativo: Boolean(trader.ativo),
            mesa_id: Number(trader.mesa_id),
            mesa_codigo: String(trader.mesa_codigo)
        },
        accounts: accounts.map(row => ({
            id: Number(row.id),
            name: String(row.name || ''),
            adapter_key: String(row.adapter_key || ''),
            enabled: Boolean(row.enabled),
            table_key: String(row.table_key || ''),
            table_enabled: Boolean(row.table_enabled)
        }))
    };
}

async function clearTraderAccounts(dbPool, traderId) {
    const trader = await traderDescriptor(dbPool, traderId);
    const connection = await dbPool.getConnection();
    try {
        await connection.beginTransaction();
        const [result] = await connection.query(
            'DELETE FROM auto_trader_account_bindings WHERE auto_trader_id=?',
            [Number(trader.id)]
        );
        const config = configWithAccountIds(trader.config_json, []);
        await connection.query(
            'UPDATE auto_traders SET config_json=? WHERE id=?',
            [JSON.stringify(config), Number(trader.id)]
        );
        await connection.commit();
        return {
            trader_id: Number(trader.id),
            removed: Number(result?.affectedRows || 0)
        };
    } catch (error) {
        try { await connection.rollback(); } catch (_) {}
        throw error;
    } finally {
        connection.release();
    }
}

async function listTraderAccountBindings(dbPool) {
    const [traderRows] = await dbPool.query(
        `SELECT at.id AS trader_id,
                at.nome AS trader_name,
                at.ativo AS trader_active,
                at.config_json,
                m.codigo AS table_code
         FROM auto_traders at
         INNER JOIN mesas m ON m.id = at.mesa_id
         ORDER BY at.id`
    );
    const [bindingRows] = await dbPool.query(
        `SELECT auto_trader_id AS trader_id,
                betting_house_id AS account_id
         FROM auto_trader_account_bindings
         ORDER BY auto_trader_id, betting_house_id`
    );
    const [accountRows] = await dbPool.query(
        `SELECT h.id AS account_id,
                h.name AS account_name,
                h.adapter_key,
                h.enabled AS account_enabled,
                LOWER(ht.table_key) AS table_code,
                ht.enabled AS table_enabled
         FROM betting_houses h
         LEFT JOIN betting_house_tables ht ON ht.betting_house_id = h.id
         ORDER BY h.id, ht.table_key`
    );

    const legacyByTrader = new Map();
    for (const row of bindingRows || []) {
        const traderId = Number(row.trader_id);
        const accountId = Number(row.account_id);
        if (!Number.isSafeInteger(traderId) || traderId <= 0) continue;
        if (!Number.isSafeInteger(accountId) || accountId <= 0) continue;
        if (!legacyByTrader.has(traderId)) legacyByTrader.set(traderId, []);
        legacyByTrader.get(traderId).push(accountId);
    }

    const accountIndex = new Map();
    for (const row of accountRows || []) {
        const accountId = Number(row.account_id);
        const tableCode = String(row.table_code || '').trim().toLowerCase();
        if (!Number.isSafeInteger(accountId) || accountId <= 0 || !tableCode) continue;
        accountIndex.set(`${accountId}:${tableCode}`, row);
    }

    return (traderRows || []).map(row => {
        const traderId = Number(row.trader_id);
        const tableCode = String(row.table_code || '').trim();
        const configIds = accountIdsFromConfig(row.config_json);
        const accountIds = configIds.length > 0
            ? configIds
            : normalizeAccountIds(legacyByTrader.get(traderId) || []);
        const accounts = accountIds.map(accountId => {
            const account = accountIndex.get(`${accountId}:${tableCode.toLowerCase()}`);
            return {
                account_id: accountId,
                account_name: String(account?.account_name || `Conta ${accountId}`),
                adapter_key: String(account?.adapter_key || ''),
                adapter_supported: liveBridgeAdapterSupported(account?.adapter_key),
                account_enabled: Boolean(account?.account_enabled),
                table_enabled: Boolean(account?.table_enabled)
            };
        });
        return {
            trader_id: traderId,
            trader_name: String(row.trader_name || ''),
            trader_active: Boolean(row.trader_active),
            table_code: tableCode,
            binding_source: configIds.length > 0 ? 'config' : 'legacy_table',
            accounts
        };
    });
}

module.exports = {
    SUPPORTED_LIVE_BRIDGE_ADAPTERS,
    positiveId,
    normalizeAccountIds,
    accountIdsFromConfig,
    liveBridgeAdapterSupported,
    configWithAccountIds,
    traderDescriptor,
    validateAccountsForTrader,
    setTraderAccounts,
    clearTraderAccounts,
    listTraderAccountBindings
};
