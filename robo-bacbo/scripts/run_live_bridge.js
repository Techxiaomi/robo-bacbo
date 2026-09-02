'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const mysql = require('mysql2/promise');

require('../env_loader').loadEnvFile(path.join(__dirname, '..', '..', '.env'));

const { createBettingHouseService } = require('../betting_house_service');
const { getTechnicalRiskCaps } = require('../technical_risk_caps');

const HOUSE_ADAPTER_KEY = 'brasil-da-sorte';
const DEFAULT_TABLE_KEY = 'bacbo_br';
const SUPPORTED_TABLE_KEYS = new Set(['bacbo_br', 'bacbo_int']);

let activePythonControl = null;
let pendingExternalShutdownReason = null;

function sendTelemetry(status, extra = {}) {
    if (!process.connected || typeof process.send !== 'function') return;
    try {
        process.send({ type: 'telemetry', status, ...extra });
    } catch (_) {}
}

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

    const technicalCaps = getTechnicalRiskCaps();
    return {
        mode: 'controlled',
        armed: true,
        max_exposure: technicalCaps.per_bridge_cap
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
    env.PYTHONUNBUFFERED = '1';
    env.PYTHONIOENCODING = 'utf-8';
    env.PYTHONUTF8 = '1';
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
        control: {
            stdin_keepalive: true
        },
        safety
    };
}

function requestExternalShutdown(reason) {
    const normalizedReason = String(reason || 'EXTERNAL').trim().toUpperCase() || 'EXTERNAL';
    if (activePythonControl) {
        activePythonControl.requestShutdown(normalizedReason);
        return;
    }
    pendingExternalShutdownReason = normalizedReason;
}

function inspectPythonLine(line) {
    const text = String(line || '').trim();
    if (!text) return;
    if (text === 'LIVE_BRIDGE_READY=true') {
        sendTelemetry('READY');
        return;
    }
    if (
        text.startsWith('LIVE_BRIDGE_WORKER_ERROR=') ||
        text.startsWith('LIVE_BRIDGE_SHUTDOWN_INCOMPLETE=true') ||
        text.startsWith('LIVE_BRIDGE_BROWSER_CLOSE_FAILED:')
    ) {
        sendTelemetry('ERROR', { error: text.slice(0, 1000) });
    }
}

function runPython({ pythonExecutable, pythonScript, config, cwd }) {
    return new Promise((resolve, reject) => {
        const child = spawn(pythonExecutable, [pythonScript], {
            cwd,
            env: sanitizedPythonEnv(),
            stdio: ['pipe', 'pipe', 'inherit'],
            windowsHide: false
        });

        let settled = false;
        let shutdownRequested = false;
        let stdoutBuffer = '';

        const consumeStdout = chunk => {
            process.stdout.write(chunk);
            stdoutBuffer += chunk.toString('utf8');
            let newlineIndex = stdoutBuffer.indexOf('\n');
            while (newlineIndex >= 0) {
                const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, '');
                stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
                inspectPythonLine(line);
                newlineIndex = stdoutBuffer.indexOf('\n');
            }
        };

        const finish = callback => {
            if (settled) return;
            settled = true;
            activePythonControl = null;
            if (stdoutBuffer.trim()) inspectPythonLine(stdoutBuffer);
            try { child.stdin.end(); } catch (_) {}
            callback();
        };

        const fail = error => {
            sendTelemetry('ERROR', { error: String(error?.message || error).slice(0, 1000) });
            finish(() => reject(error));
        };

        const requestShutdown = reason => {
            if (shutdownRequested) return;
            shutdownRequested = true;
            console.log(`LIVE_BRIDGE_ORCHESTRATOR_SHUTDOWN_REQUESTED=true reason=${reason}`);
            if (!child.stdin.destroyed && child.stdin.writable) {
                child.stdin.write('SHUTDOWN\n', error => {
                    if (error && error.code !== 'EPIPE') {
                        console.error(`LIVE_BRIDGE_CONTROL_WRITE_FAILED: ${error.message}`);
                    }
                });
            }
        };

        activePythonControl = Object.freeze({ requestShutdown });

        child.stdout.on('data', consumeStdout);
        child.stdout.once('error', fail);
        child.once('error', fail);
        child.once('exit', (code, signal) => {
            finish(() => {
                if (signal) return reject(new Error(`LIVE_BRIDGE_PYTHON_SIGNAL: ${signal}`));
                if (code !== 0) return reject(new Error(`LIVE_BRIDGE_PYTHON_EXIT_CODE: ${code}`));
                resolve();
            });
        });
        child.stdin.on('error', error => {
            if (shutdownRequested && error?.code === 'EPIPE') return;
            fail(error);
        });

        child.stdin.write(`${JSON.stringify(config)}\n`, error => {
            if (error) {
                fail(error);
                return;
            }
            if (pendingExternalShutdownReason) {
                const reason = pendingExternalShutdownReason;
                pendingExternalShutdownReason = null;
                requestShutdown(reason);
            }
        });
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
        console.log('CONFIG_TRANSPORT=STDIN_JSONL_CONTROL');
        console.log('SECRETS_LOGGED=false');
        console.log('LIVE_BRIDGE_MODE=controlled');
        console.log('LIVE_BRIDGE_TECHNICAL_CAP_SOURCE=technical_risk_caps');
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
        if (process.connected) {
            try { process.disconnect(); } catch (_) {}
        }
    }
}

process.on('SIGINT', () => requestExternalShutdown('SIGINT'));
process.on('SIGTERM', () => requestExternalShutdown('SIGTERM'));
process.on('message', message => {
    if (!message || message.type !== 'graceful_shutdown') return;
    requestExternalShutdown(message.reason || 'SUPERVISOR');
});

main().catch(error => {
    const text = String(error?.message || error);
    sendTelemetry('ERROR', { error: text.slice(0, 1000) });
    console.error('LIVE_BRIDGE_ORCHESTRATOR_FAILED:', text);
    process.exitCode = 1;
});
