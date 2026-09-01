'use strict';

function taskId(accountId, tableKey) {
    return `account-${accountId}:${tableKey}`;
}

function normalizeTableFilter(tableFilter) {
    if (!tableFilter) return null;
    const values = tableFilter instanceof Set ? Array.from(tableFilter) : Array.from(tableFilter || []);
    return new Set(values.map(value => String(value || '').trim().toLowerCase()).filter(Boolean));
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
    const [rows] = await dbPool.query(
        `SELECT at.id AS trader_id,
                h.id AS account_id,
                h.name AS account_name,
                ht.table_key AS table_key,
                ht.display_name AS table_name
         FROM auto_trader_account_bindings binding
         INNER JOIN auto_traders at
            ON at.id = binding.auto_trader_id
           AND at.ativo = true
         INNER JOIN mesas m
            ON m.id = at.mesa_id
           AND m.ativo = true
         INNER JOIN betting_houses h
            ON h.id = binding.betting_house_id
           AND h.enabled = true
         INNER JOIN betting_house_tables ht
            ON ht.betting_house_id = h.id
           AND ht.enabled = true
           AND LOWER(ht.table_key) = LOWER(m.codigo)
         ORDER BY h.id, ht.table_key, at.id`
    );
    return tasksFromRows(rows, tableFilter);
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
    taskId,
    normalizeTableFilter,
    tasksFromRows,
    discoverBoundTasks,
    metricsNamespaceForTask,
    envForTask
};
