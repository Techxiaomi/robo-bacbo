'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const mysql = require('mysql2/promise');

require('../env_loader').loadEnvFile(path.join(__dirname, '..', '..', '.env'));

const { createBettingHouseService } = require('../betting_house_service');

const HOUSE_ADAPTER_KEY = 'brasil-da-sorte';
const DEFAULT_TABLE_KEY = 'bacbo_br';
const SUPPORTED_TABLE_KEYS = new Set(['bacbo_br', 'bacbo_int']);
const CONTROLLED_MAX_EXPOSURE_CAP = 5;

function selectedTableKey() {
    const tableKey = String(process.argv[2] || DEFAULT_TABLE_KEY).trim();
    if (!SUPPORTED_TABLE_KEYS.has(tableKey)) {
        throw new Error(`LIVE_BRIDGE_TABLE_UNSUPPORTED: ${tableKey || '<empty>'}`);
    }
    return tableKey;
}

function selectedAccountId() {
    const raw = String(process.argv[3] || '').trim();
    if (!raw) return null;

    const accountId = Number(raw);
    if (!Number.isSafeInteger(accountId) || accountId <= 0) {
        throw new Error(`LIVE_BRIDGE_ACCOUNT_ID_INVALID: ${raw}`);
    }
    return accountId;
}

function safetyConfig() {
    const armed = String(process.env.LIVE_BRIDGE_ARMED || '').trim().toUpperCase() === 'YES';
    if (!armed) {
        throw new Error('LIVE_BRIDGE_NOT_ARMED: defina LIVE_BRIDGE_ARMED=YES para a execução controlada');
    }

    const maxExposure = Number(process.env.LIVE_BRIDGE_MAX_EXPOSURE);
    if (!Number.isFinite(maxExposure) || maxExposure <= 0 || maxExposure > CONTROLLED_MAX_EXPOSURE_CAP) {
        throw new Error(
            `LIVE_BRIDGE_MAX_EXPOSURE_INVALID: use valor > 0 e <= ${CONTROLLED_MAX_EXPOSURE_CAP}`
        );
    }

    return {
        mode: 'controlled',
        armed: true,
        max_exposure: maxExposure
    };
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
        'PLAYWRIGHT_BROWSERS_PATH',
        'AUTO_TRADER_ENABLED',
        'REDIS_URL'
    ];

    const env = {};
    for (const name of names) {
        if (process.env[name] != null && process.env[name] !== '') {
            env[name] = process.env[name];
        }
    }
    return env;
}

function accountScopedSessionStateFile(sessionStateFile, accountId, tableKey) {
    const configured = String(sessionStateFile || '').trim();
    if (!configured) return '';

    const parsed = path.parse(configured);
    const suffix = `.account-${accountId}.${tableKey}`;
    return path.join(parsed.dir, `${parsed.name}${suffix}${parsed.ext || '.json'}`);
}

function sessionConfig(accountId, tableKey) {
    const sessionId = `account-${accountId}:${tableKey}`;
    return {
        account_id: accountId,
        session_id: sessionId,
        redis_command_channel: `auto_trader_commands:${accountId}:${tableKey}`,
        redis_response_channel: `auto_trader_responses:${accountId}:${tableKey}`
    };
}

async function resolveAccount(service, requestedAccountId) {
    const houses = await service.listHouses({ includeDisabled: false });
    const compatible = houses.filter(item => item.adapter_key === HOUSE_ADAPTER_KEY);

    if (requestedAccountId != null) {
        const selected = compatible.find(item => Number(item.id) === requestedAccountId);
        if (!selected) {
            throw new Error(`LIVE_BRIDGE_ACCOUNT_NOT_FOUND: ${requestedAccountId}`);
        }
        return selected;
    }

    if (compatible.length === 0) {
        throw new Error(`LIVE_BRIDGE_HOUSE_NOT_FOUND: ${HOUSE_ADAPTER_KEY}`);
    }
    if (compatible.length > 1) {
        throw new Error('LIVE_BRIDGE_ACCOUNT_ID_REQUIRED: multiplas contas habilitadas para o adapter');
    }
    return compatible[0];
}

async function findRuntimeConfig(service, tableKey, requestedAccountId, safety) {
    const house = await resolveAccount(service, requestedAccountId);
    const runtime = await service.getRuntimeConfig(house.id);
    const table = runtime.tables.find(
        item => item.table_key === tableKey && item.enabled === true
    );
    if (!table) throw new Error(`LIVE_BRIDGE_TABLE_NOT_FOUND: ${tableKey}`);

    const accountId = Number(runtime.id);
    if (!Number.isSafeInteger(accountId) || accountId <= 0) {
        throw new Error('LIVE_BRIDGE_RUNTIME_ACCOUNT_ID_INVALID');
    }

    return {
        house: {
            id: accountId,
            name: runtime.name,
            adapter_key: runtime.adapter_key,
            home_url: runtime.home_url,
            username: runtime.username,
            password: runtime.password,
            session_state_file: accountScopedSessionStateFile(
                runtime.session_state_file,
                accountId,
                tableKey
            )
        },
        table: {
            id: table.id,
            table_key: table.table_key,
            display_name: table.display_name,
            game_url: table.game_url,
            enabled: table.enabled
        },
        session: sessionConfig(accountId, tableKey),
        safety
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
        let shutdownRequested = false;

        const removeSignalHandlers = () => {
            process.removeListener('SIGINT', handleSigint);
        };

        const finish = callback => {
            if (settled) return;
            settled = true;
            removeSignalHandlers();
            callback();
        };

        const fail = error => {
            finish(() => reject(error));
        };

        const handleSigint = () => {
            if (shutdownRequested) return;
            shutdownRequested = true;
            console.log('LIVE_BRIDGE_ORCHESTRATOR_SHUTDOWN_REQUESTED=true');
            // O console também entrega Ctrl+C ao Python filho no Windows.
            // Manter o Node pai vivo evita fechar os pipes enquanto o Python
            // conclui BrowserContext/browser/sync_playwright de forma cooperativa.
        };

        process.on('SIGINT', handleSigint);

        child.once('error', fail);
        child.once('exit', (code, signal) => {
            finish(() => {
                if (signal) return reject(new Error(`LIVE_BRIDGE_PYTHON_SIGNAL: ${signal}`));
                if (code !== 0) return reject(new Error(`LIVE_BRIDGE_PYTHON_EXIT_CODE: ${code}`));
                resolve();
            });
        });
        child.stdin.once('error', fail);
        child.stdin.end(JSON.stringify(config));
    });
}

async function main() {
    const projectRoot = path.resolve(__dirname, '..', '..');
    const pythonRoot = path.join(projectRoot, 'robo-sync-pilot');
    const pythonScript = path.join(pythonRoot, 'live_bridge.py');
    const tableKey = selectedTableKey();
    const requestedAccountId = selectedAccountId();
    const safety = safetyConfig();
    const dbPool = createDbPool();

    try {
        const service = createBettingHouseService({
            dbPool,
            encryptionKey: process.env.BETTING_HOUSE_CREDENTIALS_KEY
        });
        const config = await findRuntimeConfig(
            service,
            tableKey,
            requestedAccountId,
            safety
        );

        console.log('=== LIVE BRIDGE ORCHESTRATOR ===');
        console.log(`HOUSE=${config.house.name}`);
        console.log(`ACCOUNT_ID=${config.session.account_id}`);
        console.log(`SESSION_ID=${config.session.session_id}`);
        console.log(`ADAPTER=${config.house.adapter_key}`);
        console.log(`TABLE=${config.table.table_key}`);
        console.log(`REDIS_COMMAND_CHANNEL=${config.session.redis_command_channel}`);
        console.log(`REDIS_RESPONSE_CHANNEL=${config.session.redis_response_channel}`);
        console.log('CONFIG_TRANSPORT=STDIN_JSON');
        console.log('SECRETS_LOGGED=false');
        console.log('LIVE_BRIDGE_MODE=controlled');
        console.log(`LIVE_BRIDGE_MAX_EXPOSURE=${safety.max_exposure.toFixed(2)}`);

        await runPython({
            pythonExecutable: resolvePythonExecutable(projectRoot),
            pythonScript,
            config,
            cwd: pythonRoot
        });

        console.log('LIVE_BRIDGE_ORCHESTRATOR_STOPPED');
    } finally {
        await dbPool.end();
    }
}

main().catch(error => {
    console.error('LIVE_BRIDGE_ORCHESTRATOR_FAILED:', error?.message || error);
    process.exitCode = 1;
});
