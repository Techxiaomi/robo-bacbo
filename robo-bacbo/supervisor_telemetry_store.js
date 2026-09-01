'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_STATUS_FILE = path.join(PROJECT_ROOT, 'runtime', 'supervisor-status.json');
const STALE_AFTER_MS = 30000;

function statusFilePath() {
    const configured = String(process.env.MASTER_SUPERVISOR_STATUS_FILE || '').trim();
    return configured ? path.resolve(configured) : DEFAULT_STATUS_FILE;
}

function atomicWriteJson(filePath, payload) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, filePath);
}

function writeSupervisorSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
        throw new TypeError('SUPERVISOR_TELEMETRY_INVALID_SNAPSHOT');
    }
    atomicWriteJson(statusFilePath(), snapshot);
}

function readSupervisorSnapshot() {
    const filePath = statusFilePath();
    if (!fs.existsSync(filePath)) {
        return {
            available: false,
            stale: true,
            generated_at: null,
            supervisor: { running: false, pid: null },
            workers: []
        };
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const generatedAtMs = Date.parse(parsed.generated_at || '');
        const stale = !Number.isFinite(generatedAtMs) || Date.now() - generatedAtMs > STALE_AFTER_MS;
        return {
            ...parsed,
            available: true,
            stale
        };
    } catch (error) {
        return {
            available: false,
            stale: true,
            generated_at: null,
            supervisor: { running: false, pid: null },
            workers: [],
            error: `SUPERVISOR_TELEMETRY_READ_FAILED: ${error?.message || error}`
        };
    }
}

module.exports = Object.freeze({
    statusFilePath,
    writeSupervisorSnapshot,
    readSupervisorSnapshot
});
