'use strict';

const SAFE_DEFAULTS = Object.freeze({
    global_router_cap: 20.00,
    per_bridge_cap: 5.00,
    financial_dry_run: true
});

const CONFIG_KEYS = Object.freeze([
    'global_router_cap',
    'per_bridge_cap',
    'financial_dry_run'
]);

function safeMoney(value, fallback, max) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0 || number > max) return fallback;
    return Math.round(number * 100) / 100;
}

function normalizeRows(rows) {
    const map = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
        map.set(String(row?.config_key || '').trim(), String(row?.config_value ?? '').trim());
    }
    return map;
}

async function ensureSystemConfigsTable(dbPool) {
    await dbPool.query(`
        CREATE TABLE IF NOT EXISTS system_configs (
            config_key VARCHAR(80) NOT NULL PRIMARY KEY,
            config_value VARCHAR(255) NOT NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await dbPool.query(
        `INSERT IGNORE INTO system_configs (config_key, config_value) VALUES
         ('global_router_cap', ?),
         ('per_bridge_cap', ?),
         ('financial_dry_run', 'true')`,
        [SAFE_DEFAULTS.global_router_cap.toFixed(2), SAFE_DEFAULTS.per_bridge_cap.toFixed(2)]
    );
}

function safeSnapshot(rows, extra = {}) {
    const values = normalizeRows(rows);
    const globalRouterCap = safeMoney(
        values.get('global_router_cap'),
        SAFE_DEFAULTS.global_router_cap,
        SAFE_DEFAULTS.global_router_cap
    );
    const perBridgeCap = safeMoney(
        values.get('per_bridge_cap'),
        SAFE_DEFAULTS.per_bridge_cap,
        SAFE_DEFAULTS.per_bridge_cap
    );
    const requestedDryRun = String(values.get('financial_dry_run') || 'true').toLowerCase() === 'true';

    return Object.freeze({
        global_router_cap: globalRouterCap,
        per_bridge_cap: perBridgeCap,
        financial_dry_run: true,
        requested_financial_dry_run: requestedDryRun,
        dry_run_forced: requestedDryRun !== true,
        source: extra.source || 'system_configs',
        fail_closed: extra.fail_closed === true || requestedDryRun !== true,
        reason: extra.reason || (requestedDryRun !== true ? 'FINANCIAL_DRY_RUN_FORCED_TRUE' : null)
    });
}

async function readSystemConfig({ dbPool }) {
    if (!dbPool || typeof dbPool.query !== 'function') {
        return safeSnapshot([], { source: 'safe-defaults', fail_closed: true, reason: 'SYSTEM_CONFIG_DB_INVALID' });
    }
    try {
        await ensureSystemConfigsTable(dbPool);
        const [rows] = await dbPool.query(
            `SELECT config_key, config_value
             FROM system_configs
             WHERE config_key IN (?, ?, ?)
             ORDER BY config_key`,
            CONFIG_KEYS
        );
        return safeSnapshot(rows);
    } catch (error) {
        return safeSnapshot([], {
            source: 'safe-defaults',
            fail_closed: true,
            reason: `SYSTEM_CONFIG_DB_UNAVAILABLE:${error?.code || 'ERROR'}`
        });
    }
}

async function updateTechnicalCaps({ dbPool, globalRouterCap, perBridgeCap }) {
    if (!dbPool || typeof dbPool.query !== 'function') {
        throw new TypeError('SYSTEM_CONFIG_DB_INVALID');
    }
    const globalValue = safeMoney(globalRouterCap, null, SAFE_DEFAULTS.global_router_cap);
    const bridgeValue = safeMoney(perBridgeCap, null, SAFE_DEFAULTS.per_bridge_cap);
    if (globalValue == null) throw new Error('SYSTEM_CONFIG_GLOBAL_ROUTER_CAP_INVALID');
    if (bridgeValue == null) throw new Error('SYSTEM_CONFIG_PER_BRIDGE_CAP_INVALID');

    await ensureSystemConfigsTable(dbPool);
    await dbPool.query(
        `INSERT INTO system_configs (config_key, config_value) VALUES
         ('global_router_cap', ?),
         ('per_bridge_cap', ?),
         ('financial_dry_run', 'true')
         ON DUPLICATE KEY UPDATE config_value=VALUES(config_value)`,
        [globalValue.toFixed(2), bridgeValue.toFixed(2)]
    );
    return readSystemConfig({ dbPool });
}

module.exports = {
    SAFE_DEFAULTS,
    CONFIG_KEYS,
    ensureSystemConfigsTable,
    readSystemConfig,
    updateTechnicalCaps
};
