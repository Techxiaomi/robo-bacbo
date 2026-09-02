'use strict';

const { accountIdsFromConfig, normalizeAccountIds } = require('./trader_bound_tasks');

function freezeScope(value) {
    return Object.freeze({
        trader_id: Number(value.trader_id),
        table_key: String(value.table_key || '').trim().toLowerCase(),
        account_ids: Object.freeze(normalizeAccountIds(value.account_ids))
    });
}

function filterTargetsByAccountIds(targets, accountIds) {
    const allowed = new Set(normalizeAccountIds(accountIds));
    return (Array.isArray(targets) ? targets : [])
        .filter(target => allowed.has(Number(target?.account_id)))
        .slice()
        .sort((a, b) => Number(a.account_id) - Number(b.account_id));
}

class FinancialTraderScopeResolver {
    constructor({ dbPool }) {
        if (!dbPool || typeof dbPool.query !== 'function') {
            throw new TypeError('SIGNAL_ROUTER_TRADER_SCOPE_DB_INVALID');
        }
        this.dbPool = dbPool;
    }

    async resolve(signal) {
        if (!signal || signal.action !== 'place_bet') {
            throw new Error('SIGNAL_ROUTER_TRADER_SCOPE_FINANCIAL_SIGNAL_REQUIRED');
        }

        const signalId = String(signal.signal_id || '').trim().toLowerCase();
        const tableKey = String(signal.table_key || '').trim().toLowerCase();
        if (!signalId || !tableKey) {
            throw new Error('SIGNAL_ROUTER_TRADER_SCOPE_SIGNAL_INVALID');
        }

        const [rows] = await this.dbPool.query(
            `SELECT ao.trader_id,
                    at.config_json,
                    at.ativo,
                    at.status_operacao,
                    LOWER(m.codigo) AS table_key
             FROM auditoria_ordens ao
             INNER JOIN auto_traders at
                ON at.id = ao.trader_id
               AND at.mesa_id = ao.mesa_id
             INNER JOIN mesas m
                ON m.id = ao.mesa_id
               AND m.ativo = true
             WHERE LOWER(ao.executor_order_id) = ?
               AND LOWER(m.codigo) = ?
             ORDER BY ao.id DESC
             LIMIT 2`,
            [signalId, tableKey]
        );

        if (!Array.isArray(rows) || rows.length !== 1) {
            throw new Error('SIGNAL_ROUTER_TRADER_SCOPE_ORDER_NOT_UNIQUE');
        }

        const row = rows[0];
        const traderId = Number(row.trader_id);
        const resolvedTable = String(row.table_key || '').trim().toLowerCase();
        const active = row.ativo === true || row.ativo === 1;
        const status = String(row.status_operacao || '').trim().toUpperCase();

        if (!Number.isSafeInteger(traderId) || traderId <= 0) {
            throw new Error('SIGNAL_ROUTER_TRADER_SCOPE_TRADER_INVALID');
        }
        if (resolvedTable !== tableKey) {
            throw new Error('SIGNAL_ROUTER_TRADER_SCOPE_TABLE_MISMATCH');
        }
        if (!active || status !== 'OPERANDO') {
            throw new Error('SIGNAL_ROUTER_TRADER_SCOPE_TRADER_NOT_OPERATING');
        }

        let accountIds = accountIdsFromConfig(row.config_json);
        if (accountIds.length === 0) {
            const [bindings] = await this.dbPool.query(
                `SELECT betting_house_id AS account_id
                 FROM auto_trader_account_bindings
                 WHERE auto_trader_id = ?
                 ORDER BY betting_house_id`,
                [traderId]
            );
            accountIds = normalizeAccountIds((bindings || []).map(item => item.account_id));
        }

        if (accountIds.length === 0) {
            throw new Error('SIGNAL_ROUTER_TRADER_SCOPE_NO_ACCOUNTS');
        }

        return freezeScope({
            trader_id: traderId,
            table_key: tableKey,
            account_ids: accountIds
        });
    }
}

module.exports = {
    filterTargetsByAccountIds,
    FinancialTraderScopeResolver
};
