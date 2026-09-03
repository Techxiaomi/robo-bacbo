'use strict';

const path = require('path');
const { spawn } = require('child_process');
const mysql = require('mysql2/promise');

require('../env_loader').loadEnvFile(path.join(__dirname, '..', '..', '.env'));

const { writeSupervisorSnapshot } = require('../supervisor_telemetry_store');
const { discoverBoundTasks, envForTask } = require('../trader_bound_tasks');

const DEFAULT_STAGGER_MS = 3000;
const DEFAULT_BACKOFF_BASE_MS = 2000;
const DEFAULT_BACKOFF_MAX_MS = 60000;
const DEFAULT_STABLE_WINDOW_MS = 60000;
const DEFAULT_RECONCILE_INTERVAL_MS = 15000;
const CHILD_GRACEFUL_STOP_TIMEOUT_MS = 15000;
const WORKER_STATUSES = new Set(['STARTING', 'READY', 'BACKOFF', 'STOPPING', 'STOPPED', 'ERROR']);

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
    const values = raw.split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
    return values.length ? new Set(values) : null;
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

class MasterSupervisor {
    constructor({ runnerPath, cwd, staggerMs, backoffBaseMs, backoffMaxMs, stableWindowMs, reconcileIntervalMs }) {
        this.runnerPath = runnerPath;
        this.cwd = cwd;
        this.staggerMs = staggerMs;
        this.backoffBaseMs = backoffBaseMs;
        this.backoffMaxMs = backoffMaxMs;
        this.stableWindowMs = stableWindowMs;
        this.reconcileIntervalMs = reconcileIntervalMs;
        this.entries = new Map();
        this.telemetry = new Map();
        this.shuttingDown = false;
        this.shutdownPromise = null;
    }

    telemetryFor(task) {
        let item = this.telemetry.get(task.id);
        if (!item) {
            item = {
                session_id: task.id,
                account_id: task.accountId,
                account_name: task.accountName,
                table_key: task.tableKey,
                table_name: task.tableName,
                trader_ids: Array.from(task.traderIds || []),
                pid: null,
                status: 'STOPPED',
                restart_attempts: 0,
                last_error: null,
                desired: false,
                started_at: null,
                updated_at: new Date().toISOString()
            };
            this.telemetry.set(task.id, item);
        }
        item.account_name = task.accountName;
        item.table_name = task.tableName;
        item.trader_ids = Array.from(task.traderIds || []);
        return item;
    }

    setTelemetry(entry, status, patch = {}) {
        if (!WORKER_STATUSES.has(status)) {
            throw new Error(`MASTER_SUPERVISOR_TELEMETRY_STATUS_INVALID: ${status}`);
        }
        const item = this.telemetryFor(entry.task);
        Object.assign(item, patch, {
            status,
            desired: Boolean(entry.desired),
            restart_attempts: entry.restartCount,
            updated_at: new Date().toISOString()
        });
        this.publishSnapshot();
    }

    publishSnapshot({ running = !this.shuttingDown } = {}) {
        const now = Date.now();
        const workers = Array.from(this.telemetry.values())
            .map(item => ({
                ...item,
                uptime_ms: item.pid && item.started_at
                    ? Math.max(0, now - Date.parse(item.started_at))
                    : 0
            }))
            .sort((a, b) => {
                if (a.account_id !== b.account_id) return a.account_id - b.account_id;
                return a.table_key.localeCompare(b.table_key, 'en');
            });

        try {
            writeSupervisorSnapshot({
                version: 2,
                generated_at: new Date(now).toISOString(),
                supervisor: {
                    running,
                    pid: running ? process.pid : null,
                    reconcile_interval_ms: this.reconcileIntervalMs,
                    discovery_mode: 'ACTIVE_TRADER_BINDINGS',
                    table_filter: String(process.env.MASTER_SUPERVISOR_TABLE_KEYS || '').trim() || null
                },
                workers
            });
        } catch (error) {
            console.error(`MASTER_SUPERVISOR_TELEMETRY_WRITE_FAILED: ${error?.message || error}`);
        }
    }

    register(task) {
        if (this.entries.has(task.id)) {
            throw new Error(`MASTER_SUPERVISOR_DUPLICATE_TASK: ${task.id}`);
        }
        const entry = {
            task,
            desired: true,
            child: null,
            restartCount: 0,
            startedAt: 0,
            restartTimer: null,
            forceStopTimer: null,
            intentionalStopReason: null
        };
        this.entries.set(task.id, entry);
        const telemetry = this.telemetryFor(task);
        telemetry.desired = true;
        telemetry.updated_at = new Date().toISOString();
        return entry;
    }

    cancelRestart(entry) {
        if (!entry.restartTimer) return;
        clearTimeout(entry.restartTimer);
        entry.restartTimer = null;
    }

    cancelForceStop(entry) {
        if (!entry.forceStopTimer) return;
        clearTimeout(entry.forceStopTimer);
        entry.forceStopTimer = null;
    }

    scheduleRestart(entry, code, signal) {
        if (this.shuttingDown || !entry.desired || entry.restartTimer || entry.intentionalStopReason) return;

        const runtimeMs = Math.max(0, Date.now() - entry.startedAt);
        if (runtimeMs >= this.stableWindowMs) {
            entry.restartCount = 0;
        } else {
            entry.restartCount += 1;
        }

        const delay = Math.min(
            this.backoffBaseMs * (2 ** Math.max(0, entry.restartCount - 1)),
            this.backoffMaxMs
        );
        const lastError = `process_exit code=${code ?? 'null'} signal=${signal || 'none'}`;

        console.error(
            `MASTER_SUPERVISOR_CHILD_EXIT=${entry.task.id} code=${code ?? 'null'} signal=${signal || 'none'} ` +
            `runtime_ms=${runtimeMs} restart_in_ms=${delay} attempt=${entry.restartCount}`
        );
        this.setTelemetry(entry, 'BACKOFF', {
            pid: null,
            last_error: lastError
        });

        entry.restartTimer = setTimeout(() => {
            entry.restartTimer = null;
            this.spawnTask(entry);
        }, delay);
    }

    handleChildTelemetry(entry, message) {
        if (!message || message.type !== 'telemetry') return;
        const status = String(message.status || '').trim().toUpperCase();
        if (!WORKER_STATUSES.has(status)) return;

        if (status === 'READY') {
            this.setTelemetry(entry, 'READY', { last_error: null });
            return;
        }
        if (status === 'ERROR') {
            this.setTelemetry(entry, 'ERROR', {
                last_error: String(message.error || 'LIVE_BRIDGE_ERROR').slice(0, 1000)
            });
        }
    }

    spawnTask(entry) {
        if (this.shuttingDown || !entry.desired || entry.child || entry.intentionalStopReason) return;

        const { task } = entry;
        const childEnv = envForTask(process.env, task);
        const child = spawn(process.execPath, [this.runnerPath, task.tableKey, String(task.accountId)], {
            cwd: this.cwd,
            env: childEnv,
            stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
            windowsHide: false
        });

        entry.child = child;
        entry.startedAt = Date.now();
        this.setTelemetry(entry, 'STARTING', {
            pid: child.pid || null,
            started_at: new Date(entry.startedAt).toISOString(),
            last_error: null
        });

        console.log(
            `MASTER_SUPERVISOR_CHILD_STARTED=${task.id} pid=${child.pid || 'unknown'} ` +
            `account=${task.accountName} table=${task.tableName} traders=${task.traderIds.join(',')} ` +
            `metrics_namespace=${childEnv.OPERATIONS_METRICS_NAMESPACE}`
        );

        child.on('message', message => this.handleChildTelemetry(entry, message));
        child.once('error', error => {
            const text = String(error?.message || error);
            console.error(`MASTER_SUPERVISOR_CHILD_ERROR=${task.id}: ${text}`);
            this.setTelemetry(entry, 'ERROR', { last_error: text });
        });

        child.once('close', (code, signal) => {
            const intentionalReason = entry.intentionalStopReason;
            this.cancelForceStop(entry);
            entry.child = null;
            entry.intentionalStopReason = null;

            if (this.shuttingDown) {
                this.setTelemetry(entry, 'STOPPED', { pid: null });
                console.log(
                    `MASTER_SUPERVISOR_CHILD_STOPPED=${task.id} code=${code ?? 'null'} signal=${signal || 'none'}`
                );
                return;
            }

            if (intentionalReason) {
                this.setTelemetry(entry, 'STOPPED', { pid: null });
                console.log(
                    `MASTER_SUPERVISOR_CHILD_STOPPED_INTENTIONAL=${task.id} reason=${intentionalReason} ` +
                    `code=${code ?? 'null'} signal=${signal || 'none'}`
                );
                if (!entry.desired) {
                    this.entries.delete(task.id);
                    return;
                }

                entry.restartTimer = setTimeout(() => {
                    entry.restartTimer = null;
                    this.spawnTask(entry);
                }, this.staggerMs);
                return;
            }

            this.scheduleRestart(entry, code, signal);
        });
    }

    requestGracefulStop(entry, reason) {
        if (!entry.child || entry.intentionalStopReason) return;

        this.cancelRestart(entry);
        entry.intentionalStopReason = reason;
        const child = entry.child;
        this.setTelemetry(entry, 'STOPPING');

        console.log(`MASTER_SUPERVISOR_CHILD_STOP_REQUESTED=${entry.task.id} reason=${reason}`);

        const forceStop = () => {
            if (entry.child !== child) return;
            const error = `graceful_shutdown_timeout reason=${reason}`;
            console.error(`MASTER_SUPERVISOR_CHILD_GRACE_TIMEOUT=${entry.task.id} reason=${reason}`);
            this.setTelemetry(entry, 'ERROR', { last_error: error });
            try {
                child.kill('SIGTERM');
            } catch (killError) {
                console.error(
                    `MASTER_SUPERVISOR_CHILD_FORCE_STOP_FAILED=${entry.task.id}: ${killError?.message || killError}`
                );
            }
        };

        entry.forceStopTimer = setTimeout(forceStop, CHILD_GRACEFUL_STOP_TIMEOUT_MS);

        if (child.connected && typeof child.send === 'function') {
            child.send(
                { type: 'graceful_shutdown', reason, task_id: entry.task.id },
                error => {
                    if (!error) return;
                    console.error(
                        `MASTER_SUPERVISOR_CHILD_IPC_FAILED=${entry.task.id}: ${error?.message || error}`
                    );
                    forceStop();
                }
            );
            return;
        }

        console.error(`MASTER_SUPERVISOR_CHILD_IPC_UNAVAILABLE=${entry.task.id}`);
        forceStop();
    }

    async startEntries(entries) {
        for (let index = 0; index < entries.length; index += 1) {
            if (this.shuttingDown) break;
            const entry = entries[index];
            if (entry.desired && !entry.child && !entry.restartTimer && !entry.intentionalStopReason) {
                this.spawnTask(entry);
            }
            if (index < entries.length - 1) {
                await sleep(this.staggerMs);
            }
        }
    }

    async reconcile(tasks) {
        if (this.shuttingDown) return;

        const desiredById = new Map(tasks.map(task => [task.id, task]));
        let keepCount = 0;
        let stopCount = 0;
        const startEntries = [];

        for (const [id, entry] of this.entries) {
            if (desiredById.has(id)) continue;
            if (!entry.desired) continue;

            entry.desired = false;
            stopCount += 1;
            this.cancelRestart(entry);
            if (entry.child) {
                this.requestGracefulStop(entry, 'TRADER_BINDING_INACTIVE');
            } else {
                this.setTelemetry(entry, 'STOPPED', { pid: null });
                this.entries.delete(id);
            }
        }

        for (const task of tasks) {
            const existing = this.entries.get(task.id);
            if (!existing) {
                const entry = this.register(task);
                startEntries.push(entry);
                continue;
            }

            existing.task = task;
            const wasDesired = existing.desired;
            existing.desired = true;
            this.telemetryFor(task).desired = true;

            if (existing.child || existing.restartTimer || existing.intentionalStopReason) {
                keepCount += 1;
                if (!wasDesired) {
                    console.log(`MASTER_SUPERVISOR_TASK_REENABLED=${task.id}`);
                }
                continue;
            }

            startEntries.push(existing);
        }

        console.log(
            `MASTER_SUPERVISOR_RECONCILE desired=${tasks.length} ` +
            `start=${startEntries.length} stop=${stopCount} keep=${keepCount}`
        );

        await this.startEntries(startEntries);
        this.publishSnapshot();
    }

    async shutdown() {
        if (this.shutdownPromise) return this.shutdownPromise;
        this.shuttingDown = true;

        this.shutdownPromise = (async () => {
            console.log('MASTER_SUPERVISOR_SHUTDOWN_REQUESTED=true');

            for (const entry of this.entries.values()) {
                entry.desired = false;
                this.cancelRestart(entry);
                if (entry.child && !entry.intentionalStopReason) {
                    this.requestGracefulStop(entry, 'SUPERVISOR_SHUTDOWN');
                } else if (!entry.child) {
                    this.setTelemetry(entry, 'STOPPED', { pid: null });
                }
            }

            const deadline = Date.now() + CHILD_GRACEFUL_STOP_TIMEOUT_MS + 3000;
            while (Date.now() < deadline) {
                const pending = Array.from(this.entries.values()).some(entry => entry.child);
                if (!pending) break;
                await sleep(200);
            }

            for (const entry of this.entries.values()) {
                this.cancelForceStop(entry);
                const child = entry.child;
                if (!child) continue;
                try {
                    child.kill('SIGTERM');
                    console.error(`MASTER_SUPERVISOR_CHILD_FORCE_STOP=${entry.task.id}`);
                } catch (_) {}
            }

            this.publishSnapshot({ running: false });
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
    const reconcileIntervalMs = positiveIntEnv(
        'MASTER_SUPERVISOR_RECONCILE_INTERVAL_MS',
        DEFAULT_RECONCILE_INTERVAL_MS,
        { min: 5000, max: 300000 }
    );

    const dbPool = createDbPool();
    const supervisor = new MasterSupervisor({
        runnerPath: path.join(__dirname, 'run_live_bridge.js'),
        cwd: path.resolve(__dirname, '..'),
        staggerMs,
        backoffBaseMs,
        backoffMaxMs,
        stableWindowMs,
        reconcileIntervalMs
    });

    const requestShutdown = () => {
        void supervisor.shutdown();
    };

    process.once('SIGINT', requestShutdown);
    process.once('SIGTERM', requestShutdown);

    try {
        console.log('=== MASTER SUPERVISOR ===');
        console.log('MASTER_SUPERVISOR_DISCOVERY_MODE=ACTIVE_TRADER_BINDINGS');
        console.log(`MASTER_SUPERVISOR_STAGGER_MS=${staggerMs}`);
        console.log(`MASTER_SUPERVISOR_BACKOFF_BASE_MS=${backoffBaseMs}`);
        console.log(`MASTER_SUPERVISOR_BACKOFF_MAX_MS=${backoffMaxMs}`);
        console.log(`MASTER_SUPERVISOR_RECONCILE_INTERVAL_MS=${reconcileIntervalMs}`);
        console.log(
            `MASTER_SUPERVISOR_TABLE_FILTER=${tableFilter ? Array.from(tableFilter).join(',') : 'ALL_BOUND'}`
        );

        supervisor.publishSnapshot();
        const initialTasks = await discoverBoundTasks(dbPool, tableFilter);
        console.log(`MASTER_SUPERVISOR_TASK_COUNT=${initialTasks.length}`);
        for (const task of initialTasks) {
            console.log(
                `MASTER_SUPERVISOR_DISCOVERED=${task.id} account=${task.accountName} ` +
                `table=${task.tableName} traders=${task.traderIds.join(',')}`
            );
        }

        await supervisor.reconcile(initialTasks);
        console.log('MASTER_SUPERVISOR_READY=true');

        while (!supervisor.shuttingDown) {
            await sleep(reconcileIntervalMs);
            if (supervisor.shuttingDown) break;

            try {
                const tasks = await discoverBoundTasks(dbPool, tableFilter);
                await supervisor.reconcile(tasks);
            } catch (error) {
                console.error(`MASTER_SUPERVISOR_RECONCILE_FAILED: ${error?.message || error}`);
                supervisor.publishSnapshot();
            }
        }

        await supervisor.shutdown();
    } finally {
        await dbPool.end();
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error('MASTER_SUPERVISOR_FAILED:', error?.message || error);
        try {
            writeSupervisorSnapshot({
                version: 2,
                generated_at: new Date().toISOString(),
                supervisor: { running: false, pid: null, discovery_mode: 'ACTIVE_TRADER_BINDINGS' },
                workers: [],
                error: String(error?.message || error)
            });
        } catch (_) {}
        process.exitCode = 1;
    });
}

module.exports = {
    MasterSupervisor,
    positiveIntEnv,
    optionalTableFilter,
    createDbPool,
    main
};
