'use strict';

const path = require('path');
const { spawn } = require('child_process');
const mysql = require('mysql2/promise');

require('../env_loader').loadEnvFile(path.join(__dirname, '..', '..', '.env'));
const { readSystemConfig } = require('../system_config_service');

const ALLOWED_TARGETS = new Set([
    'scripts/signal_router.js',
    'scripts/master_supervisor.js'
]);

function normalizedTarget(value) {
    return String(value || '').trim().replaceAll('\\', '/');
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

    const env = {
        ...process.env,
        SYSTEM_CONFIG_GLOBAL_ROUTER_CAP: config.global_router_cap.toFixed(2),
        SYSTEM_CONFIG_PER_BRIDGE_CAP: config.per_bridge_cap.toFixed(2),
        SIGNAL_ROUTER_FINANCIAL_DRY_RUN: 'true',
        SYSTEM_CONFIG_SOURCE: config.source
    };

    console.log(
        `SYSTEM_CONFIG_LOADED source=${config.source} global_router_cap=${config.global_router_cap.toFixed(2)} ` +
        `per_bridge_cap=${config.per_bridge_cap.toFixed(2)} financial_dry_run=true fail_closed=${config.fail_closed}`
    );

    const child = spawn(process.execPath, [path.join(__dirname, '..', target), ...process.argv.slice(3)], {
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

main().catch(error => {
    console.error('SYSTEM_CONFIG_RUNNER_FAILED:', error?.message || error);
    process.exitCode = 1;
});
