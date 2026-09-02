'use strict';

const SAFE_DEFAULTS = Object.freeze({
    global_router_cap: 20.00,
    per_bridge_cap: 5.00,
    financial_dry_run: true
});

const SAFE_ENVELOPE = Object.freeze({
    global_router_cap: 20.00,
    per_bridge_cap: 5.00,
    financial_dry_run: true
});

const ADMIN_REQUEST_MAX = 99999.00;
const CONFIG_KEYS = Object.freeze([
    'global_router_cap',
    'per_bridge_cap',
    'financial_dry_run'
]);

function requestedMoney(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0 || number > ADMIN_REQUEST_MAX) return null;
    return Math.round(number * 100) / 100;
}

function requestedBoolean(value) {
    if (value === true || value === false) return value;
    const normalized = String(value ?? '').trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    return null;
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
         ('financial_dry_run', ?)`,
        [
            SAFE_DEFAULTS.global_router_cap.toFixed(2),
            SAFE_DEFAULTS.per_bridge_cap.toFixed(2),
            String(SAFE_DEFAULTS.financial_dry_run)
        ]
    );
}

function buildSnapshot(rows, extra = {}) {
    const values = normalizeRows(rows);
    const discrepancies = [];

    const rawGlobal = values.get('global_router_cap');
    const parsedGlobal = requestedMoney(rawGlobal);
    const requestedGlobal = parsedGlobal ?? SAFE_DEFAULTS.global_router_cap;
    if (rawGlobal != null && parsedGlobal == null) {
        discrepancies.push({
            key: 'global_router_cap',
            requested_value: rawGlobal,
            effective_value: SAFE_DEFAULTS.global_router_cap,
            reason: 'INVALID_REQUESTED_VALUE'
        });
    }

    const rawBridge = values.get('per_bridge_cap');
    const parsedBridge = requestedMoney(rawBridge);
    const requestedBridge = parsedBridge ?? SAFE_DEFAULTS.per_bridge_cap;
    if (rawBridge != null && parsedBridge == null) {
        discrepancies.push({
            key: 'per_bridge_cap',
            requested_value: rawBridge,
            effective_value: SAFE_DEFAULTS.per_bridge_cap,
            reason: 'INVALID_REQUESTED_VALUE'
        });
    }

    const rawDryRun = values.get('financial_dry_run');
    const parsedDryRun = requestedBoolean(rawDryRun);
    const requestedDryRun = parsedDryRun ?? SAFE_DEFAULTS.financial_dry_run;
    if (rawDryRun != null && parsedDryRun == null) {
        discrepancies.push({
            key: 'financial_dry_run',
            requested_value: rawDryRun,
            effective_value: true,
            reason: 'INVALID_REQUESTED_VALUE'
        });
    }

    const effectiveGlobal = Math.min(requestedGlobal, SAFE_ENVELOPE.global_router_cap);
    const effectiveBridge = Math.min(requestedBridge, SAFE_ENVELOPE.per_bridge_cap);
    const effectiveDryRun = true;

    if (requestedGlobal !== effectiveGlobal) {
        discrepancies.push({
            key: 'global_router_cap',
            requested_value: requestedGlobal,
            effective_value: effectiveGlobal,
            reason: 'SAFE_ENVELOPE_CLAMP'
        });
    }
    if (requestedBridge !== effectiveBridge) {
        discrepancies.push({
            key: 'per_bridge_cap',
            requested_value: requestedBridge,
            effective_value: effectiveBridge,
            reason: 'SAFE_ENVELOPE_CLAMP'
        });
    }
    if (requestedDryRun !== effectiveDryRun) {
        discrepancies.push({
            key: 'financial_dry_run',
            requested_value: requestedDryRun,
            effective_value: effectiveDryRun,
            reason: 'FINANCIAL_DRY_RUN_FORCED_TRUE'
        });
    }

    const invalidStoredValue = discrepancies.some(item => item.reason === 'INVALID_REQUESTED_VALUE');
    const dryRunForced = requestedDryRun !== true;
    const frozenDiscrepancies = Object.freeze(discrepancies.map(item => Object.freeze({ ...item })));

    return Object.freeze({
        global_router_cap: effectiveGlobal,
        per_bridge_cap: effectiveBridge,
        financial_dry_run: effectiveDryRun,
        requested_financial_dry_run: requestedDryRun,
        dry_run_forced: dryRunForced,
        requested: Object.freeze({
            global_router_cap: requestedGlobal,
            per_bridge_cap: requestedBridge,
            financial_dry_run: requestedDryRun
        }),
        effective: Object.freeze({
            global_router_cap: effectiveGlobal,
            per_bridge_cap: effectiveBridge,
            financial_dry_run: effectiveDryRun
        }),
        discrepancies: frozenDiscrepancies,
        clamped: frozenDiscrepancies.length > 0,
        source: extra.source || 'system_configs',
        fail_closed: extra.fail_closed === true || invalidStoredValue || dryRunForced,
        reason: extra.reason || (invalidStoredValue
            ? 'SYSTEM_CONFIG_INVALID_REQUESTED_VALUE'
            : (dryRunForced ? 'FINANCIAL_DRY_RUN_FORCED_TRUE' : null))
    });
}

function logDiscrepancies(snapshot, log = console) {
    if (!log || typeof log.warn !== 'function') return;
    for (const item of snapshot?.discrepancies || []) {
        log.warn(
            'SYSTEM_CONFIG_EFFECTIVE_CLAMP',
            `key=${item.key}`,
            `requested_value=${item.requested_value}`,
            `effective_value=${item.effective_value}`,
            `reason=${item.reason}`
        );
    }
}

async function readSystemConfig({ dbPool, log = console }) {
    if (!dbPool || typeof dbPool.query !== 'function') {
        const snapshot = buildSnapshot([], {
            source: 'safe-defaults',
            fail_closed: true,
            reason: 'SYSTEM_CONFIG_DB_INVALID'
        });
        logDiscrepancies(snapshot, log);
        return snapshot;
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
        const snapshot = buildSnapshot(rows);
        logDiscrepancies(snapshot, log);
        return snapshot;
    } catch (error) {
        const snapshot = buildSnapshot([], {
            source: 'safe-defaults',
            fail_closed: true,
            reason: `SYSTEM_CONFIG_DB_UNAVAILABLE:${error?.code || 'ERROR'}`
        });
        logDiscrepancies(snapshot, log);
        return snapshot;
    }
}

async function updateSystemConfig({
    dbPool,
    globalRouterCap,
    perBridgeCap,
    financialDryRun,
    log = console
}) {
    if (!dbPool || typeof dbPool.query !== 'function') {
        throw new TypeError('SYSTEM_CONFIG_DB_INVALID');
    }

    const globalValue = requestedMoney(globalRouterCap);
    const bridgeValue = requestedMoney(perBridgeCap);
    const dryRunValue = requestedBoolean(financialDryRun);

    if (globalValue == null) throw new Error('SYSTEM_CONFIG_GLOBAL_ROUTER_CAP_INVALID');
    if (bridgeValue == null) throw new Error('SYSTEM_CONFIG_PER_BRIDGE_CAP_INVALID');
    if (dryRunValue == null) throw new Error('SYSTEM_CONFIG_FINANCIAL_DRY_RUN_INVALID');

    await ensureSystemConfigsTable(dbPool);
    await dbPool.query(
        `INSERT INTO system_configs (config_key, config_value) VALUES
         ('global_router_cap', ?),
         ('per_bridge_cap', ?),
         ('financial_dry_run', ?)
         ON DUPLICATE KEY UPDATE config_value=VALUES(config_value)`,
        [globalValue.toFixed(2), bridgeValue.toFixed(2), String(dryRunValue)]
    );

    return readSystemConfig({ dbPool, log });
}

async function updateTechnicalCaps({ dbPool, globalRouterCap, perBridgeCap, log = console }) {
    const current = await readSystemConfig({ dbPool, log });
    return updateSystemConfig({
        dbPool,
        globalRouterCap,
        perBridgeCap,
        financialDryRun: current.requested.financial_dry_run,
        log
    });
}

async function resetSystemConfig({ dbPool, log = console }) {
    return updateSystemConfig({
        dbPool,
        globalRouterCap: SAFE_DEFAULTS.global_router_cap,
        perBridgeCap: SAFE_DEFAULTS.per_bridge_cap,
        financialDryRun: SAFE_DEFAULTS.financial_dry_run,
        log
    });
}

module.exports = {
    SAFE_DEFAULTS,
    SAFE_ENVELOPE,
    ADMIN_REQUEST_MAX,
    CONFIG_KEYS,
    requestedMoney,
    requestedBoolean,
    ensureSystemConfigsTable,
    buildSnapshot,
    logDiscrepancies,
    readSystemConfig,
    updateSystemConfig,
    updateTechnicalCaps,
    resetSystemConfig
};
