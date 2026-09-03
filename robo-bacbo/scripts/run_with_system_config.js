'use strict';

const path = require('path');
const { spawn } = require('child_process');
const mysql = require('mysql2/promise');

require('../env_loader').loadEnvFile(path.join(__dirname, '..', '..', '.env'));
const { readSystemConfig } = require('../system_config_service');

const ALLOWED_TARGETS = new Set([
    'scripts/signal_router.js',
    'scripts/master_supervisor.js',
    'scripts/master_supervisor_fast.js'
]);

function normalizedTarget(value) {
    return String(value || '').trim().replaceAll('\\', '/');
}

function effectiveTargetForMode(target, financialMode) {
    if (target === 'scripts/signal_router.js' && financialMode === 'ARMED_REVIEW') {
        return 'scripts/signal_router_armed_review.js';
    }
    return target;
}

async function main() {
    const target = normalizedTarget(process.argv[2]);
    if (!ALLOWED_TARGETS.has(target)) {
        throw new Error(`SYSTEM_CONFIG_RUNNER_TARGET_INVALID: ${target || '<empty>'}`);
    }

    const dbPool = mysql.createPool({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        waitForConnections: true,
        connectionLimit: 2,
        queueLimit: 0
    });

    let config;
    try {
        config = await readSystemConfig({ dbPool });
    } finally {
        await dbPool.end();
    }

    const financialMode = String(config.financial_mode || 'DRY_RUN').trim().toUpperCase();
    if (!['DRY_RUN', 'ARMED_REVIEW'].includes(financialMode)) {
        throw new Error(`SYSTEM_CONFIG_FINANCIAL_MODE_INVALID: ${financialMode}`);
    }

    const effectiveTarget = effectiveTargetForMode(target, financialMode);
    const env = {
        ...process.env,
        SYSTEM_CONFIG_GLOBAL_ROUTER_CAP: config.global_router_cap.toFixed(2),
        SYSTEM_CONFIG_PER_BRIDGE_CAP: config.per_bridge_cap.toFixed(2),
        SYSTEM_CONFIG_TECHNICAL_RISK_CAPS_ENABLED: String(config.technical_risk_caps_enabled === true),
        SIGNAL_ROUTER_FINANCIAL_DRY_RUN: 'true',
        SIGNAL_ROUTER_FINANCIAL_MODE: financialMode,
        SYSTEM_CONFIG_SOURCE: config.source
    };

    console.log(
        `SYSTEM_CONFIG_LOADED source=${config.source} technical_risk_caps_enabled=${config.technical_risk_caps_enabled === true} ` +
        `global_router_cap=${config.global_router_cap.toFixed(2)} per_bridge_cap=${config.per_bridge_cap.toFixed(2)} ` +
        `financial_mode=${financialMode} automated_dispatch=false fail_closed=${config.fail_closed}`
    );
    if (effectiveTarget !== target) {
        console.warn(
            `SYSTEM_CONFIG_ROUTER_MODE_SWITCH requested_target=${target} effective_target=${effectiveTarget} ` +
            `financial_mode=${financialMode} human_confirmation_required=true`
        );
    }

    const child = spawn(process.execPath, [path.join(__dirname, '..', effectiveTarget), ...process.argv.slice(3)], {
        cwd: path.join(__dirname, '..'),
        env,
        stdio: 'inherit',
        windowsHide: false
    });

    child.once('error', error => {
        console.error('SYSTEM_CONFIG_RUNNER_SPAWN_FAILED:', error?.message || error);
        process.exitCode = 1;
    });
    child.once('exit', (code, signal) => {
        if (signal) {
            console.error(`SYSTEM_CONFIG_RUNNER_CHILD_SIGNAL=${signal}`);
            process.exitCode = 1;
            return;
        }
        process.exitCode = Number.isInteger(code) ? code : 1;
    });
}

if (require.main === module) {
    main().catch(error => {
        console.error('SYSTEM_CONFIG_RUNNER_FAILED:', error?.message || error);
        process.exitCode = 1;
    });
}

module.exports = {
    normalizedTarget,
    effectiveTargetForMode
};
