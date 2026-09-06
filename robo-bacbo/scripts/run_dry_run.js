'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const mysql = require('mysql2/promise');

require('../env_loader').loadEnvFile(path.join(__dirname, '..', '..', '.env'));

const { createBettingHouseService } = require('../betting_house_service');

const HOUSE_ADAPTER_KEY = 'brasil-da-sorte';
const DEFAULT_TABLE_KEY = 'bacbo_br';
const TABLE_KEY_PATTERN = /^[a-z0-9_-]+$/;

function resolveTableKey(argv = process.argv) {
    const requested = String(argv[2] || '').trim().toLowerCase();
    const tableKey = requested || DEFAULT_TABLE_KEY;

    if (!TABLE_KEY_PATTERN.test(tableKey)) {
        throw new Error(`DRY_RUN_TABLE_KEY_INVALID: ${tableKey}`);
    }

    return tableKey;
}

function createDbPool() {
    return mysql.createPool({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        waitForConnections: true,
        connectionLimit: 2,
        queueLimit: 0
    });
}

function resolvePythonExecutable(projectRoot) {
    const explicit = String(process.env.PYTHON_EXECUTABLE || '').trim();
    if (explicit) return explicit;

    const candidates = process.platform === 'win32'
        ? [
            path.join(projectRoot, 'python', 'venv', 'Scripts', 'python.exe'),
            path.join(projectRoot, 'robo-sync-pilot', 'venv', 'Scripts', 'python.exe')
        ]
        : [
            path.join(projectRoot, 'python', 'venv', 'bin', 'python'),
            path.join(projectRoot, 'robo-sync-pilot', 'venv', 'bin', 'python')
        ];

    return candidates.find(candidate => fs.existsSync(candidate))
        || (process.platform === 'win32' ? 'python' : 'python3');
}

function sanitizedPythonEnv() {
    const names = [
        'PATH',
        'Path',
        'SystemRoot',
        'WINDIR',
        'COMSPEC',
        'TEMP',
        'TMP',
        'USERPROFILE',
        'HOME',
        'LOCALAPPDATA',
        'APPDATA',
        'PROGRAMDATA',
        'PROGRAMFILES',
        'PROGRAMFILES(X86)',
        'PLAYWRIGHT_BROWSERS_PATH'
    ];
    const env = {};
    for (const name of names) {
        if (process.env[name] != null && process.env[name] !== '') {
            env[name] = process.env[name];
        }
    }
    return env;
}

async function findRuntimeConfig(service, tableKey) {
    const houses = await service.listHouses({ includeDisabled: false });
    const house = houses.find(item => item.adapter_key === HOUSE_ADAPTER_KEY);
    if (!house) throw new Error(`DRY_RUN_HOUSE_NOT_FOUND: ${HOUSE_ADAPTER_KEY}`);

    const runtime = await service.getRuntimeConfig(house.id);
    const table = runtime.tables.find(
        item => item.table_key === tableKey && item.enabled === true
    );
    if (!table) throw new Error(`DRY_RUN_TABLE_NOT_FOUND: ${tableKey}`);

    return {
        house: {
            id: runtime.id,
            name: runtime.name,
            adapter_key: runtime.adapter_key,
            home_url: runtime.home_url,
            username: runtime.username,
            password: runtime.password,
            session_state_file: runtime.session_state_file
        },
        table: {
            id: table.id,
            table_key: table.table_key,
            display_name: table.display_name,
            game_url: table.game_url,
            enabled: table.enabled
        }
    };
}

function runPython({ pythonExecutable, pythonScript, config, cwd }) {
    return new Promise((resolve, reject) => {
        const child = spawn(pythonExecutable, [pythonScript], {
            cwd,
            env: sanitizedPythonEnv(),
            stdio: ['pipe', 'inherit', 'inherit'],
            windowsHide: false
        });

        let settled = false;
        const fail = error => {
            if (settled) return;
            settled = true;
            reject(error);
        };

        child.once('error', fail);
        child.once('exit', (code, signal) => {
            if (settled) return;
            settled = true;
            if (signal) return reject(new Error(`DRY_RUN_PYTHON_SIGNAL: ${signal}`));
            if (code !== 0) return reject(new Error(`DRY_RUN_PYTHON_EXIT_CODE: ${code}`));
            resolve();
        });
        child.stdin.once('error', fail);
        child.stdin.end(JSON.stringify(config));
    });
}

async function main() {
    const tableKey = resolveTableKey();
    const projectRoot = path.resolve(__dirname, '..', '..');
    const pythonRoot = path.join(projectRoot, 'robo-sync-pilot');
    const pythonScript = path.join(pythonRoot, 'diagnostics', 'dry_run_discovery.py');
    const dbPool = createDbPool();

    try {
        const service = createBettingHouseService({
            dbPool,
            encryptionKey: process.env.BETTING_HOUSE_CREDENTIALS_KEY
        });
        const config = await findRuntimeConfig(service, tableKey);

        console.log('=== DRY RUN ORCHESTRATOR ===');
        console.log(`HOUSE=${config.house.name}`);
        console.log(`ADAPTER=${config.house.adapter_key}`);
        console.log(`TABLE=${config.table.table_key}`);
        console.log('CONFIG_TRANSPORT=STDIN_JSON');
        console.log('SECRETS_LOGGED=false');

        await runPython({
            pythonExecutable: resolvePythonExecutable(projectRoot),
            pythonScript,
            config,
            cwd: pythonRoot
        });

        console.log('DRY_RUN_ORCHESTRATOR_SUCCESS');
    } finally {
        await dbPool.end();
    }
}

main().catch(error => {
    console.error('DRY_RUN_ORCHESTRATOR_FAILED:', error?.message || error);
    process.exitCode = 1;
});
