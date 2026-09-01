'use strict';

const SUPPORTED_LIVE_BRIDGE_ADAPTER_KEY = 'brasil-da-sorte';

function taskId(accountId, tableKey) {
    return `account-${accountId}:${tableKey}`;
}

function normalizeTableFilter(tableFilter) {
    if (!tableFilter) return null;
    const values = tableFilter instanceof Set ? Array.from(tableFilter) : Array.from(tableFilter || []);
    return new Set(values.map(value => String(value || '').trim().toLowerCase()).filter(Boolean));
}

function normalizeAccountIds(values) {
    const source = Array.isArray(values) ? values : [];
    return Array.from(new Set(source
        .map(Number)
        .filter(id => Number.isSafeInteger(id) && id > 0)))
        .sort((a, b) => a - b);
}

function accountIdsFromConfig(configJson) {
    let config = configJson;
    if (typeof configJson === 'string') {
        try { config = JSON.parse(configJson); }
        catch (_) { return []; }
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) return [];
    return normalizeAccountIds(config.account_ids);
}

function tasksFromRows(rows, tableFilter = null) {
    const filter = normalizeTableFilter(tableFilter);
    const byId = new Map();

    for (const row of rows || []) {
        const accountId = Number(row.account_id);
        const tableKey = String(row.table_key || '').trim().toLowerCase();
        if (!Number.isSafeInteger(accountId) || accountId <= 0 || !tableKey) continue;
        if (filter && !filter.has(tableKey)) continue;

        const id = taskId(accountId, tableKey);
        let task = byId.get(id);
        if (!task) {
            task = {
                id,
                accountId,
                accountName: String(row.account_name || `Conta ${accountId}`),
                tableKey,
                tableName: String(row.table_name || tableKey),
                traderIds: []
            };
            byId.set(id, task);
        }

        const traderId = Number(row.trader_id);
        if (Number.isSafeInteger(traderId) && traderId > 0 && !task.traderIds.includes(traderId)) {
            task.traderIds.push(traderId);
            task.traderIds.sort((a, b) => a - b);
        }
    }

    return Array.from(byId.values())
        .sort((a, b) => {
            if (a.accountId !== b.accountId) return a.accountId - b.accountId;
            return a.tableKey.localeCompare(b.tableKey, 'en');
        })
        .map(task => Object.freeze({ ...task, traderIds: Object.freeze([...task.traderIds]) }));
}

async function discoverBoundTasks(dbPool, tableFilter = null) {
    const [traders] = await dbPool.query(
        `SELECT at.id AS trader_id,
                at.config_json,
                LOWER(m.codigo) AS table_key
         FROM auto_traders at
         INNER JOIN mesas m
            ON m.id = at.mesa_id
           AND m.ativo = true
         WHERE at.ativo = true
         ORDER BY at.id`
    );

    if (!Array.isArray(traders) || traders.length === 0) return [];

    const [bindingRows] = await dbPool.query(
        `SELECT auto_trader_id AS trader_id,
                betting_house_id AS account_id
         FROM auto_trader_account_bindings
         ORDER BY auto_trader_id, betting_house_id`
    );
    const legacyBindings = new Map();
    for (const row of bindingRows || []) {
        const traderId = Number(row.trader_id);
        const accountId = Number(row.account_id);
        if (!Number.isSafeInteger(traderId) || traderId <= 0) continue;
        if (!Number.isSafeInteger(accountId) || accountId <= 0) continue;
        if (!legacyBindings.has(traderId)) legacyBindings.set(traderId, []);
        legacyBindings.get(traderId).push(accountId);
    }

    const [accounts] = await dbPool.query(
        `SELECT h.id AS account_id,
                h.name AS account_name,
                LOWER(ht.table_key) AS table_key,
                ht.display_name AS table_name
         FROM betting_houses h
         INNER JOIN betting_house_tables ht
            ON ht.betting_house_id = h.id
           AND ht.enabled = true
         WHERE h.enabled = true
           AND h.adapter_key = ?
         ORDER BY h.id, ht.table_key`,
        [SUPPORTED_LIVE_BRIDGE_ADAPTER_KEY]
    );
    const accountTableIndex = new Map();
    for (const account of accounts || []) {
        const accountId = Number(account.account_id);
        const tableKey = String(account.table_key || '').trim().toLowerCase();
        if (!Number.isSafeInteger(accountId) || accountId <= 0 || !tableKey) continue;
        accountTableIndex.set(`${accountId}:${tableKey}`, account);
    }

    const resolvedRows = [];
    for (const trader of traders) {
        const traderId = Number(trader.trader_id);
        const tableKey = String(trader.table_key || '').trim().toLowerCase();
        if (!Number.isSafeInteger(traderId) || traderId <= 0 || !tableKey) continue;

        const configAccountIds = accountIdsFromConfig(trader.config_json);
        const accountIds = configAccountIds.length > 0
            ? configAccountIds
            : normalizeAccountIds(legacyBindings.get(traderId));

        for (const accountId of accountIds) {
            const account = accountTableIndex.get(`${accountId}:${tableKey}`);
            if (!account) continue;
            resolvedRows.push({
                trader_id: traderId,
                account_id: accountId,
                account_name: account.account_name,
                table_key: tableKey,
                table_name: account.table_name
            });
        }
    }

    return tasksFromRows(resolvedRows, tableFilter);
}

function metricsNamespaceForTask(task) {
    const accountId = Number(task?.accountId);
    const tableKey = String(task?.tableKey || '').trim().toLowerCase();
    if (!Number.isSafeInteger(accountId) || accountId <= 0 || !/^[a-z0-9_]+$/.test(tableKey)) {
        throw new Error('MASTER_SUPERVISOR_TASK_SCOPE_INVALID');
    }
    return `account-${accountId}-${tableKey}`;
}

function envForTask(baseEnv, task) {
    const namespace = metricsNamespaceForTask(task);
    return {
        ...(baseEnv || {}),
        BACBO_MESA_CODIGO: String(task.tableKey).trim().toUpperCase(),
        OPERATIONS_METRICS_NAMESPACE: namespace,
        LIVE_BRIDGE_PROCESS_NAMESPACE: namespace
    };
}

module.exports = {
    SUPPORTED_LIVE_BRIDGE_ADAPTER_KEY,
    taskId,
    normalizeTableFilter,
    normalizeAccountIds,
    accountIdsFromConfig,
    tasksFromRows,
    discoverBoundTasks,
    metricsNamespaceForTask,
    envForTask
};
