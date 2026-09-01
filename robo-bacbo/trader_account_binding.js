'use strict';

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

async function traderDescriptor(dbPool, traderId) {
    const id = positiveId(traderId, 'TRADER_ID');
    const [rows] = await dbPool.query(
        `SELECT at.id, at.nome, at.ativo, at.mesa_id, m.codigo AS mesa_codigo, m.nome AS mesa_nome
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
        `SELECT h.id, h.name, h.enabled, t.table_key, t.display_name, t.enabled AS table_enabled
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
            enabled: Boolean(row.enabled),
            table_key: String(row.table_key || ''),
            table_enabled: Boolean(row.table_enabled)
        }))
    };
}

async function clearTraderAccounts(dbPool, traderId) {
    const trader = await traderDescriptor(dbPool, traderId);
    const [result] = await dbPool.query(
        'DELETE FROM auto_trader_account_bindings WHERE auto_trader_id=?',
        [Number(trader.id)]
    );
    return {
        trader_id: Number(trader.id),
        removed: Number(result?.affectedRows || 0)
    };
}

async function listTraderAccountBindings(dbPool) {
    const [rows] = await dbPool.query(
        `SELECT at.id AS trader_id,
                at.nome AS trader_name,
                at.ativo AS trader_active,
                m.codigo AS table_code,
                b.betting_house_id AS account_id,
                h.name AS account_name,
                h.enabled AS account_enabled,
                ht.enabled AS table_enabled
         FROM auto_traders at
         INNER JOIN mesas m ON m.id = at.mesa_id
         LEFT JOIN auto_trader_account_bindings b ON b.auto_trader_id = at.id
         LEFT JOIN betting_houses h ON h.id = b.betting_house_id
         LEFT JOIN betting_house_tables ht
           ON ht.betting_house_id = h.id
          AND LOWER(ht.table_key) = LOWER(m.codigo)
         ORDER BY at.id, b.betting_house_id`
    );

    const traders = new Map();
    for (const row of rows || []) {
        const id = Number(row.trader_id);
        let item = traders.get(id);
        if (!item) {
            item = {
                trader_id: id,
                trader_name: String(row.trader_name || ''),
                trader_active: Boolean(row.trader_active),
                table_code: String(row.table_code || ''),
                accounts: []
            };
            traders.set(id, item);
        }
        if (row.account_id != null) {
            item.accounts.push({
                account_id: Number(row.account_id),
                account_name: String(row.account_name || ''),
                account_enabled: Boolean(row.account_enabled),
                table_enabled: Boolean(row.table_enabled)
            });
        }
    }
    return Array.from(traders.values());
}

module.exports = {
    normalizeAccountIds,
    traderDescriptor,
    validateAccountsForTrader,
    setTraderAccounts,
    clearTraderAccounts,
    listTraderAccountBindings
};
