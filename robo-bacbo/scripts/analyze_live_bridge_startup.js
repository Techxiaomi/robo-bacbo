'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_LOG = path.join(__dirname, '..', '..', 'logs', 'backend.jsonl');

const MARKERS = Object.freeze([
    ['SESSION_START', /^SESSION_ID=/],
    ['PYTHON_FAULTHANDLER', /^LIVE_BRIDGE_PYTHON_FAULTHANDLER=true$/],
    ['CONTROLLED_BOOT', /^=== LIVE BRIDGE CONTROLLED ===$/],
    ['HOME_STAGE', /^BRASIL_DA_SORTE_STAGE=HOME$/],
    ['LOGIN_TRIGGERED', /^BRASIL_DA_SORTE_LOGIN_TRIGGERED=true$/],
    ['LOGIN_SUBMITTED', /^BRASIL_DA_SORTE_LOGIN_SUBMITTED=true$/],
    ['LOGIN_CONFIRMED', /^BRASIL_DA_SORTE_LOGIN_CONFIRMED=true$/],
    ['SESSION_REUSED', /^BRASIL_DA_SORTE_SESSION_REUSED=true$/],
    ['GAME_URL_STAGE', /^BRASIL_DA_SORTE_STAGE=GAME_URL$/],
    ['GAME_NAVIGATED', /^BRASIL_DA_SORTE_GAME_NAVIGATED_URL=/],
    ['PLAY_EVIDENCE', /^BRASIL_DA_SORTE_PLAY_EVIDENCE=/],
    ['PLAY_CLICK', /^BRASIL_DA_SORTE_PLAY_CLICK_METHOD=/],
    ['PLAY_TRIGGERED', /^BRASIL_DA_SORTE_PLAY_TRIGGERED=true$/],
    ['CONTEXT_ISOLATED', /^LIVE_BRIDGE_CONTEXT_ISOLATED=/],
    ['ADAPTER_PAGE_READY', /^LIVE_BRIDGE_ADAPTER_PAGE_READY=true$/],
    ['BRIDGE_READY', /^LIVE_BRIDGE_READY=true$/],
]);

function parseArgs(argv) {
    const args = { accountId: null, tableKey: null, logPath: DEFAULT_LOG };
    for (let index = 0; index < argv.length; index += 1) {
        const item = argv[index];
        if (item === '--account' && argv[index + 1]) args.accountId = Number(argv[++index]);
        else if (item === '--table' && argv[index + 1]) args.tableKey = String(argv[++index]).trim().toLowerCase();
        else if (item === '--log' && argv[index + 1]) args.logPath = path.resolve(argv[++index]);
    }
    if (!Number.isSafeInteger(args.accountId) || args.accountId <= 0) {
        throw new Error('STARTUP_PROFILE_ACCOUNT_REQUIRED');
    }
    if (!/^[a-z0-9_]+$/.test(args.tableKey || '')) {
        throw new Error('STARTUP_PROFILE_TABLE_REQUIRED');
    }
    return args;
}

function readJsonLines(logPath) {
    if (!fs.existsSync(logPath)) throw new Error(`STARTUP_PROFILE_LOG_NOT_FOUND: ${logPath}`);
    return fs.readFileSync(logPath, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => {
            try { return JSON.parse(line); } catch (_) { return null; }
        })
        .filter(Boolean)
        .filter(item => Number.isFinite(Date.parse(item.timestamp)) && typeof item.message === 'string');
}

function latestSession(records, accountId, tableKey) {
    const sessionId = `account-${accountId}:${tableKey}`;
    const candidates = records.filter(item => item.message === `SESSION_ID=${sessionId}`);
    if (candidates.length === 0) throw new Error(`STARTUP_PROFILE_SESSION_NOT_FOUND: ${sessionId}`);
    const start = candidates[candidates.length - 1];
    const pid = Number(start.pid);
    const startMs = Date.parse(start.timestamp);
    const nextSameSession = candidates.find(item => Date.parse(item.timestamp) > startMs && Number(item.pid) !== pid);
    const endMs = nextSameSession ? Date.parse(nextSameSession.timestamp) : Number.POSITIVE_INFINITY;
    return { sessionId, pid, startMs, endMs, start };
}

function markerFor(message) {
    for (const [name, pattern] of MARKERS) {
        if (pattern.test(message)) return name;
    }
    return null;
}

function profile(records, session) {
    const scoped = records.filter(item => {
        const ts = Date.parse(item.timestamp);
        return Number(item.pid) === session.pid && ts >= session.startMs && ts < session.endMs;
    });

    const events = [];
    const seen = new Set();
    for (const item of scoped) {
        const name = markerFor(item.message);
        if (!name || seen.has(name)) continue;
        seen.add(name);
        events.push({ name, timestamp: item.timestamp, ms: Date.parse(item.timestamp), message: item.message });
        if (name === 'BRIDGE_READY') break;
    }

    const start = events.find(item => item.name === 'SESSION_START');
    if (!start) throw new Error('STARTUP_PROFILE_SESSION_START_MISSING');

    let previous = start.ms;
    return events.map(event => {
        const row = {
            stage: event.name,
            delta_ms: event.ms - previous,
            elapsed_ms: event.ms - start.ms,
            timestamp: event.timestamp,
        };
        previous = event.ms;
        return row;
    });
}

function printProfile(session, rows) {
    console.log('=== LIVE BRIDGE STARTUP PROFILE ===');
    console.log(`SESSION_ID=${session.sessionId}`);
    console.log(`PID=${session.pid}`);
    for (const row of rows) {
        console.log(
            `STARTUP_PROFILE stage=${row.stage} delta_ms=${row.delta_ms} ` +
            `elapsed_ms=${row.elapsed_ms} timestamp=${row.timestamp}`
        );
    }

    const ready = rows.find(row => row.stage === 'BRIDGE_READY');
    if (!ready) {
        console.log('STARTUP_PROFILE_COMPLETE=false');
        return false;
    }

    const slowest = rows
        .filter(row => row.stage !== 'SESSION_START')
        .reduce((best, row) => (!best || row.delta_ms > best.delta_ms ? row : best), null);

    console.log(`STARTUP_PROFILE_READY_MS=${ready.elapsed_ms}`);
    if (slowest) {
        console.log(`STARTUP_PROFILE_SLOWEST_STAGE=${slowest.stage} delta_ms=${slowest.delta_ms}`);
    }
    console.log('STARTUP_PROFILE_COMPLETE=true');
    return true;
}

function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    const records = readJsonLines(args.logPath);
    const session = latestSession(records, args.accountId, args.tableKey);
    const rows = profile(records, session);
    printProfile(session, rows);
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`STARTUP_PROFILE_FAILED: ${error?.message || error}`);
        process.exitCode = 1;
    }
}

module.exports = Object.freeze({
    MARKERS,
    parseArgs,
    latestSession,
    markerFor,
    profile,
    printProfile,
});
