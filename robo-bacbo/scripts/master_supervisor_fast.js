'use strict';

const path = require('path');

require('../env_loader').loadEnvFile(path.join(__dirname, '..', '..', '.env'));

const {
    MasterSupervisor,
    positiveIntEnv,
    optionalTableFilter,
    createDbPool
} = require('./master_supervisor');
const { discoverBoundTasks } = require('../trader_bound_tasks');
const { writeSupervisorSnapshot } = require('../supervisor_telemetry_store');
const { watchSupervisorReconcileSignal } = require('../supervisor_reconcile_signal');

const DEFAULT_FAST_STAGGER_MS = 1000;
const DEFAULT_FAST_RECONCILE_INTERVAL_MS = 2000;
const DEFAULT_BACKOFF_BASE_MS = 2000;
const DEFAULT_BACKOFF_MAX_MS = 60000;
const DEFAULT_STABLE_WINDOW_MS = 60000;

async function main() {
    const tableFilter = optionalTableFilter();
    const staggerMs = positiveIntEnv(
        'MASTER_SUPERVISOR_STAGGER_MS',
        DEFAULT_FAST_STAGGER_MS,
        { min: 500, max: 60000 }
    );
    const reconcileIntervalMs = positiveIntEnv(
        'MASTER_SUPERVISOR_RECONCILE_INTERVAL_MS',
        DEFAULT_FAST_RECONCILE_INTERVAL_MS,
        { min: 500, max: 300000 }
    );
    const backoffBaseMs = positiveIntEnv(
        'MASTER_SUPERVISOR_BACKOFF_BASE_MS',
        DEFAULT_BACKOFF_BASE_MS,
        { min: 500, max: 60000 }
    );
    const backoffMaxMs = positiveIntEnv(
        'MASTER_SUPERVISOR_BACKOFF_MAX_MS',
        DEFAULT_BACKOFF_MAX_MS,
        { min: backoffBaseMs, max: 600000 }
    );
    const stableWindowMs = positiveIntEnv(
        'MASTER_SUPERVISOR_STABLE_WINDOW_MS',
        DEFAULT_STABLE_WINDOW_MS,
        { min: 5000, max: 3600000 }
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

    let pendingReason = null;
    let reconcilePromise = null;
    let stopping = false;
    let pollTimer = null;
    let stopWatcher = null;
    let resolveShutdown = null;
    const shutdownGate = new Promise(resolve => { resolveShutdown = resolve; });

    const requestReconcile = reason => {
        if (stopping || supervisor.shuttingDown) return Promise.resolve();
        pendingReason = String(reason || 'UNKNOWN').trim().toUpperCase() || 'UNKNOWN';
        if (reconcilePromise) return reconcilePromise;

        reconcilePromise = (async () => {
            while (pendingReason && !stopping && !supervisor.shuttingDown) {
                const currentReason = pendingReason;
                pendingReason = null;
                const startedAt = Date.now();
                try {
                    const tasks = await discoverBoundTasks(dbPool, tableFilter);
                    await supervisor.reconcile(tasks);
                    console.log(
                        `MASTER_SUPERVISOR_RECONCILE_COMPLETE reason=${currentReason} ` +
                        `desired=${tasks.length} elapsed_ms=${Date.now() - startedAt}`
                    );
                } catch (error) {
                    console.error(
                        `MASTER_SUPERVISOR_RECONCILE_FAILED reason=${currentReason}: ${error?.message || error}`
                    );
                    supervisor.publishSnapshot();
                }
            }
        })().finally(() => {
            reconcilePromise = null;
            if (pendingReason && !stopping && !supervisor.shuttingDown) {
                void requestReconcile(pendingReason);
            }
        });
        return reconcilePromise;
    };

    const requestShutdown = async () => {
        if (stopping) return;
        stopping = true;
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        if (stopWatcher) stopWatcher();
        stopWatcher = null;
        await supervisor.shutdown();
        resolveShutdown();
    };

    process.once('SIGINT', () => { void requestShutdown(); });
    process.once('SIGTERM', () => { void requestShutdown(); });

    try {
        console.log('=== MASTER SUPERVISOR FAST ===');
        console.log('MASTER_SUPERVISOR_DISCOVERY_MODE=ACTIVE_TRADER_BINDINGS');
        console.log('MASTER_SUPERVISOR_WAKE_MODE=FILE_EVENT_PLUS_POLL_FALLBACK');
        console.log(`MASTER_SUPERVISOR_STAGGER_MS=${staggerMs}`);
        console.log(`MASTER_SUPERVISOR_RECONCILE_INTERVAL_MS=${reconcileIntervalMs}`);
        console.log(`MASTER_SUPERVISOR_BACKOFF_BASE_MS=${backoffBaseMs}`);
        console.log(`MASTER_SUPERVISOR_BACKOFF_MAX_MS=${backoffMaxMs}`);
        console.log(
            `MASTER_SUPERVISOR_TABLE_FILTER=${tableFilter ? Array.from(tableFilter).join(',') : 'ALL_BOUND'}`
        );

        supervisor.publishSnapshot();
        await requestReconcile('STARTUP');
        console.log('MASTER_SUPERVISOR_READY=true');

        stopWatcher = watchSupervisorReconcileSignal(payload => {
            const reason = String(payload?.reason || 'WAKE_SIGNAL').trim().toUpperCase() || 'WAKE_SIGNAL';
            console.log(
                `MASTER_SUPERVISOR_WAKE_RECEIVED reason=${reason} ` +
                `source_pid=${payload?.source_pid || 'unknown'}`
            );
            void requestReconcile(`WAKE_${reason}`);
        });

        // Este timer e propositalmente referenciado: o Supervisor precisa permanecer
        // vivo mesmo com zero Auto-Traders ativos para perceber a proxima ativacao.
        pollTimer = setInterval(() => {
            void requestReconcile('POLL_FALLBACK');
        }, reconcileIntervalMs);

        await shutdownGate;
    } finally {
        if (pollTimer) clearInterval(pollTimer);
        if (stopWatcher) stopWatcher();
        try { await supervisor.shutdown(); } catch (_) {}
        await dbPool.end();
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error('MASTER_SUPERVISOR_FAST_FAILED:', error?.message || error);
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

module.exports = Object.freeze({
    DEFAULT_FAST_STAGGER_MS,
    DEFAULT_FAST_RECONCILE_INTERVAL_MS,
    main
});
