'use strict';

const path = require('path');
const { spawn } = require('child_process');
const mysql = require('mysql2/promise');

require('../env_loader').loadEnvFile(path.join(__dirname, '..', '..', '.env'));

const { createBettingHouseService } = require('../betting_house_service');

const DEFAULT_STAGGER_MS = 3000;
const DEFAULT_BACKOFF_BASE_MS = 2000;
const DEFAULT_BACKOFF_MAX_MS = 60000;
const DEFAULT_STABLE_WINDOW_MS = 60000;
const SHUTDOWN_GRACE_MS = 15000;

function positiveIntEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    const raw = String(process.env[name] || '').trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`MASTER_SUPERVISOR_INVALID_${name}: ${raw}`);
    }
    return value;
}

function optionalTableFilter() {
    const raw = String(process.env.MASTER_SUPERVISOR_TABLE_KEYS || '').trim();
    if (!raw) return null;
    const values = raw.split(',').map(item => item.trim()).filter(Boolean);
    if (values.length === 0) return null;
    return new Set(values);
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

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function taskId(accountId, tableKey) {
    return `account-${accountId}:${tableKey}`;
}

async function discoverTasks(service, tableFilter) {
    const accounts = await service.listHouses({ includeDisabled: false });
    const tasks = [];

    for (const account of accounts) {
        if (account.enabled !== true) continue;
        const accountId = Number(account.id);
        if (!Number.isSafeInteger(accountId) || accountId <= 0) continue;

        const tables = Array.isArray(account.tables) ? account.tables : [];
        for (const table of tables) {
            if (table.enabled !== true) continue;
            const tableKey = String(table.table_key || '').trim();
            if (!tableKey) continue;
            if (tableFilter && !tableFilter.has(tableKey)) continue;

            tasks.push(Object.freeze({
                id: taskId(accountId, tableKey),
                accountId,
                accountName: String(account.name || `Conta ${accountId}`),
                tableKey,
                tableName: String(table.display_name || tableKey)
            }));
        }
    }

    tasks.sort((a, b) => {
        if (a.accountId !== b.accountId) return a.accountId - b.accountId;
        return a.tableKey.localeCompare(b.tableKey, 'en');
    });
    return tasks;
}

class MasterSupervisor {
    constructor({ runnerPath, cwd, staggerMs, backoffBaseMs, backoffMaxMs, stableWindowMs }) {
        this.runnerPath = runnerPath;
        this.cwd = cwd;
        this.staggerMs = staggerMs;
        this.backoffBaseMs = backoffBaseMs;
        this.backoffMaxMs = backoffMaxMs;
        this.stableWindowMs = stableWindowMs;
        this.entries = new Map();
        this.shuttingDown = false;
        this.shutdownPromise = null;
    }

    register(task) {
        if (this.entries.has(task.id)) {
            throw new Error(`MASTER_SUPERVISOR_DUPLICATE_TASK: ${task.id}`);
        }
        this.entries.set(task.id, {
            task,
            child: null,
            restartCount: 0,
            startedAt: 0,
            restartTimer: null
        });
    }

    spawnTask(entry) {
        if (this.shuttingDown || entry.child) return;

        const { task } = entry;
        const child = spawn(process.execPath, [this.runnerPath, task.tableKey, String(task.accountId)], {
            cwd: this.cwd,
            env: process.env,
            stdio: 'inherit',
            windowsHide: false
        });

        entry.child = child;
        entry.startedAt = Date.now();

        console.log(
            `MASTER_SUPERVISOR_CHILD_STARTED=${task.id} pid=${child.pid || 'unknown'} ` +
            `account=${task.accountName} table=${task.tableName}`
        );

        child.once('error', error => {
            console.error(`MASTER_SUPERVISOR_CHILD_ERROR=${task.id}: ${error?.message || error}`);
        });

        child.once('exit', (code, signal) => {
            const runtimeMs = Math.max(0, Date.now() - entry.startedAt);
            entry.child = null;

            if (this.shuttingDown) {
                console.log(
                    `MASTER_SUPERVISOR_CHILD_STOPPED=${task.id} code=${code ?? 'null'} signal=${signal || 'none'}`
                );
                return;
            }

            if (runtimeMs >= this.stableWindowMs) {
                entry.restartCount = 0;
            } else {
                entry.restartCount += 1;
            }

            const delay = Math.min(
                this.backoffBaseMs * (2 ** Math.max(0, entry.restartCount - 1)),
                this.backoffMaxMs
            );

            console.error(
                `MASTER_SUPERVISOR_CHILD_EXIT=${task.id} code=${code ?? 'null'} signal=${signal || 'none'} ` +
                `runtime_ms=${runtimeMs} restart_in_ms=${delay} attempt=${entry.restartCount}`
            );

            entry.restartTimer = setTimeout(() => {
                entry.restartTimer = null;
                this.spawnTask(entry);
            }, delay);
            entry.restartTimer.unref?.();
        });
    }

    async startAll() {
        const entries = Array.from(this.entries.values());
        for (let index = 0; index < entries.length; index += 1) {
            if (this.shuttingDown) break;
            this.spawnTask(entries[index]);
            if (index < entries.length - 1) {
                await sleep(this.staggerMs);
            }
        }
    }

    async shutdown() {
        if (this.shutdownPromise) return this.shutdownPromise;
        this.shuttingDown = true;

        this.shutdownPromise = (async () => {
            console.log('MASTER_SUPERVISOR_SHUTDOWN_REQUESTED=true');

            for (const entry of this.entries.values()) {
                if (entry.restartTimer) {
                    clearTimeout(entry.restartTimer);
                    entry.restartTimer = null;
                }
            }

            const liveChildren = Array.from(this.entries.values())
                .map(entry => entry.child)
                .filter(child => child && child.exitCode == null && child.signalCode == null);

            for (const child of liveChildren) {
                try {
                    child.kill('SIGINT');
                } catch (error) {
                    console.error(`MASTER_SUPERVISOR_CHILD_SIGNAL_FAILED=${child.pid || 'unknown'}: ${error?.message || error}`);
                }
            }

            const deadline = Date.now() + SHUTDOWN_GRACE_MS;
            while (Date.now() < deadline) {
                const pending = Array.from(this.entries.values()).some(entry => entry.child);
                if (!pending) break;
                await sleep(200);
            }

            for (const entry of this.entries.values()) {
                const child = entry.child;
                if (!child) continue;
                try {
                    child.kill('SIGTERM');
                    console.error(`MASTER_SUPERVISOR_CHILD_FORCE_STOP=${entry.task.id}`);
                } catch (_) {}
            }

            console.log('MASTER_SUPERVISOR_STOPPED=true');
        })();

        return this.shutdownPromise;
    }
}

async function main() {
    const tableFilter = optionalTableFilter();
    const staggerMs = positiveIntEnv('MASTER_SUPERVISOR_STAGGER_MS', DEFAULT_STAGGER_MS, { min: 250, max: 60000 });
    const backoffBaseMs = positiveIntEnv('MASTER_SUPERVISOR_BACKOFF_BASE_MS', DEFAULT_BACKOFF_BASE_MS, { min: 500, max: 60000 });
    const backoffMaxMs = positiveIntEnv('MASTER_SUPERVISOR_BACKOFF_MAX_MS', DEFAULT_BACKOFF_MAX_MS, { min: backoffBaseMs, max: 600000 });
    const stableWindowMs = positiveIntEnv('MASTER_SUPERVISOR_STABLE_WINDOW_MS', DEFAULT_STABLE_WINDOW_MS, { min: 5000, max: 3600000 });

    const dbPool = createDbPool();
    const supervisor = new MasterSupervisor({
        runnerPath: path.join(__dirname, 'run_live_bridge.js'),
        cwd: path.resolve(__dirname, '..'),
        staggerMs,
        backoffBaseMs,
        backoffMaxMs,
        stableWindowMs
    });

    const requestShutdown = () => {
        void supervisor.shutdown().finally(() => {
            void dbPool.end().finally(() => {
                process.exitCode = 0;
            });
        });
    };

    process.once('SIGINT', requestShutdown);
    process.once('SIGTERM', requestShutdown);

    try {
        const service = createBettingHouseService({
            dbPool,
            encryptionKey: process.env.BETTING_HOUSE_CREDENTIALS_KEY
        });
        const tasks = await discoverTasks(service, tableFilter);

        console.log('=== MASTER SUPERVISOR ===');
        console.log(`MASTER_SUPERVISOR_TASK_COUNT=${tasks.length}`);
        console.log(`MASTER_SUPERVISOR_STAGGER_MS=${staggerMs}`);
        console.log(`MASTER_SUPERVISOR_BACKOFF_BASE_MS=${backoffBaseMs}`);
        console.log(`MASTER_SUPERVISOR_BACKOFF_MAX_MS=${backoffMaxMs}`);
        console.log(
            `MASTER_SUPERVISOR_TABLE_FILTER=${tableFilter ? Array.from(tableFilter).join(',') : 'ALL_ENABLED'}`
        );

        for (const task of tasks) {
            console.log(
                `MASTER_SUPERVISOR_DISCOVERED=${task.id} account=${task.accountName} table=${task.tableName}`
            );
            supervisor.register(task);
        }

        if (tasks.length === 0) {
            throw new Error('MASTER_SUPERVISOR_NO_ACTIVE_TASKS');
        }

        await supervisor.startAll();
        console.log('MASTER_SUPERVISOR_READY=true');

        await new Promise(resolve => {
            const poll = setInterval(() => {
                if (supervisor.shuttingDown) {
                    clearInterval(poll);
                    resolve();
                }
            }, 500);
            poll.unref?.();
        });

        await supervisor.shutdown();
    } finally {
        await dbPool.end();
    }
}

main().catch(error => {
    console.error('MASTER_SUPERVISOR_FAILED:', error?.message || error);
    process.exitCode = 1;
});
