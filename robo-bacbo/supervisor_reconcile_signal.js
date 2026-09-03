'use strict';

const fs = require('fs');
const path = require('path');

const SIGNAL_FILE = path.join(__dirname, '..', 'logs', 'master-supervisor.reconcile.signal.json');
const SIGNAL_BASENAME = path.basename(SIGNAL_FILE);

function ensureSignalDir() {
    fs.mkdirSync(path.dirname(SIGNAL_FILE), { recursive: true });
}

function normalizeMetadata(metadata = {}) {
    const result = {};
    for (const [key, value] of Object.entries(metadata || {})) {
        if (value == null) continue;
        if (Array.isArray(value)) result[key] = value.slice(0, 32);
        else if (['string', 'number', 'boolean'].includes(typeof value)) result[key] = value;
    }
    return result;
}

function signalSupervisorReconcile(reason = 'UNKNOWN', metadata = {}) {
    try {
        ensureSignalDir();
        const payload = {
            requested_at: new Date().toISOString(),
            reason: String(reason || 'UNKNOWN').trim().toUpperCase().slice(0, 96) || 'UNKNOWN',
            source_pid: process.pid,
            ...normalizeMetadata(metadata)
        };
        fs.writeFileSync(SIGNAL_FILE, `${JSON.stringify(payload)}\n`, 'utf8');
        return true;
    } catch (error) {
        console.warn(`MASTER_SUPERVISOR_WAKE_SIGNAL_FAILED: ${error?.message || error}`);
        return false;
    }
}

function readSupervisorReconcileSignal() {
    try {
        const raw = fs.readFileSync(SIGNAL_FILE, 'utf8').trim();
        if (!raw) return null;
        const payload = JSON.parse(raw);
        return payload && typeof payload === 'object' ? payload : null;
    } catch (_) {
        return null;
    }
}

function watchSupervisorReconcileSignal(callback, { debounceMs = 25 } = {}) {
    if (typeof callback !== 'function') throw new TypeError('SUPERVISOR_WAKE_CALLBACK_REQUIRED');
    ensureSignalDir();
    if (!fs.existsSync(SIGNAL_FILE)) fs.writeFileSync(SIGNAL_FILE, '{}\n', 'utf8');

    let timer = null;
    const watcher = fs.watch(path.dirname(SIGNAL_FILE), { persistent: false }, (_eventType, filename) => {
        if (filename && String(filename).toLowerCase() !== SIGNAL_BASENAME.toLowerCase()) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            callback(readSupervisorReconcileSignal());
        }, debounceMs);
    });

    return () => {
        if (timer) clearTimeout(timer);
        timer = null;
        try { watcher.close(); } catch (_) {}
    };
}

module.exports = Object.freeze({
    SIGNAL_FILE,
    signalSupervisorReconcile,
    readSupervisorReconcileSignal,
    watchSupervisorReconcileSignal
});
