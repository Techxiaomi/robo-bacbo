'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const mysql = require('mysql2/promise');

require('../env_loader').loadEnvFile(path.join(__dirname, '..', '..', '.env'));

const { installBettingHouseApi } = require('../betting_house_api');
const { readSupervisorSnapshot } = require('../supervisor_telemetry_store');
const { readRiskPolicyObservability } = require('../risk_policy_observability');
const { updateTechnicalCaps } = require('../system_config_service');

const projectRoot = path.join(__dirname, '..', '..');
const runtimeDir = path.join(projectRoot, 'runtime');
const sessionFile = path.join(runtimeDir, 'session.json');
const armFile = path.join(runtimeDir, 'auto-trader.arm');
const disarmScript = path.join(projectRoot, 'tools', 'Disarm-AutoTrader.ps1');

function stripUtf8Bom(text) { return String(text || '').replace(/^\uFEFF/, ''); }

function readFinancialSafetyStatus() {
    const armedForNextStartup = fs.existsSync(armFile);
    let runtimeActive = false;
    let sessionReadable = true;
    if (fs.existsSync(sessionFile)) {
        try {
            const rawSession = fs.readFileSync(sessionFile, 'utf8');
            const session = JSON.parse(stripUtf8Bom(rawSession));
            runtimeActive = String(session?.auto_trader || '').trim().toUpperCase() === 'ON';
        } catch {
            sessionReadable = false;
            runtimeActive = true;
        }
    }
    return {
        blocked: !armedForNextStartup && !runtimeActive,
        armed_for_next_startup: armedForNextStartup,
        runtime_active: runtimeActive,
        session_readable: sessionReadable,
        mode: (!armedForNextStartup && !runtimeActive) ? 'BLOCKED' : 'FINANCIAL_ENABLED'
    };
}

function removeArmToken() {
    try { fs.rmSync(armFile, { force: true }); return true; } catch { return false; }
}

function scheduleRuntimeDisarm() {
    setTimeout(() => {
        try {
            const child = spawn('powershell.exe', ['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',disarmScript], {
                detached: true, stdio: 'ignore', windowsHide: true
            });
            child.unref();
        } catch (error) {
            console.error('FINANCIAL_SAFETY_DISARM_SPAWN_FAILED', error?.message || error);
        }
    }, 150);
}

async function main() {
    const host = '127.0.0.1';
    const port = Number(process.env.BETTING_HOUSE_API_DEV_PORT || 3010);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('BETTING_HOUSE_API_DEV_PORT_INVALID');

    const dbPool = mysql.createPool({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        waitForConnections: true,
        connectionLimit: 4,
        queueLimit: 0
    });

    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '64kb' }));
    installBettingHouseApi(app, { dbPool, encryptionKey: process.env.BETTING_HOUSE_CREDENTIALS_KEY });

    app.get('/api/supervisor/status', (req, res) => {
        const snapshot = readSupervisorSnapshot();
        res.set('Cache-Control', 'no-store');
        res.json({ ...snapshot, healthy: Boolean(snapshot.available && !snapshot.stale && snapshot.supervisor?.running === true) });
    });

    app.get('/api/financial-safety/status', (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.json(readFinancialSafetyStatus());
    });

    app.get('/api/financial-safety/risk-policy', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { res.json(await readRiskPolicyObservability({ dbPool, projectRoot })); }
        catch (error) {
            console.error('RISK_POLICY_OBSERVABILITY_FAILED', error?.message || error);
            res.status(503).json({ ok: false, fail_closed: true, reason: 'RISK_POLICY_OBSERVABILITY_UNAVAILABLE' });
        }
    });

    app.put('/api/financial-safety/system-config', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        if (req.body?.financial_dry_run === false) {
            res.status(409).json({ ok: false, reason: 'FINANCIAL_DRY_RUN_DISABLE_FORBIDDEN' });
            return;
        }
        try {
            const config = await updateTechnicalCaps({
                dbPool,
                globalRouterCap: req.body?.global_router_cap,
                perBridgeCap: req.body?.per_bridge_cap
            });
            console.warn(
                'SYSTEM_CONFIG_UPDATED',
                `global_router_cap=${config.global_router_cap.toFixed(2)}`,
                `per_bridge_cap=${config.per_bridge_cap.toFixed(2)}`,
                'financial_dry_run=true'
            );
            res.json({ ok: true, config });
        } catch (error) {
            res.status(400).json({ ok: false, reason: error?.message || 'SYSTEM_CONFIG_UPDATE_FAILED' });
        }
    });

    app.post('/api/financial-safety/disarm', (req, res) => {
        const before = readFinancialSafetyStatus();
        if (!removeArmToken()) {
            res.status(500).json({ ok: false, blocked: false, reason: 'ARM_TOKEN_REMOVE_FAILED' });
            return;
        }
        const runtimeMustStop = before.runtime_active === true;
        const after = readFinancialSafetyStatus();
        console.warn('FINANCIAL_SAFETY_DISARM_REQUESTED', `runtime_active=${before.runtime_active}`, `armed_for_next_startup=${before.armed_for_next_startup}`, `runtime_stop=${runtimeMustStop}`);
        res.status(runtimeMustStop ? 202 : 200).json({
            ok: true,
            blocked: runtimeMustStop ? false : after.blocked,
            runtime_stop_requested: runtimeMustStop,
            message: runtimeMustStop ? 'Bloqueio solicitado. A stack sera encerrada para garantir fail-closed.' : 'Execucao financeira bloqueada.'
        });
        if (runtimeMustStop) scheduleRuntimeDisarm();
    });

    const publicDir = path.join(__dirname, '..', 'public');
    app.use(express.static(publicDir));
    app.get('/', (req, res) => res.redirect('/accesses'));
    app.get('/accesses', (req, res) => {
        try {
            const page = fs.readFileSync(path.join(publicDir, 'accesses.html'), 'utf8');
            res.type('html').send(page.replace('</body>', '<script src="/risk-policy-admin.js"></script>\n</body>'));
        } catch (error) {
            res.status(500).send('ACCESSES_UI_UNAVAILABLE');
        }
    });
    app.get('/betting-houses', (req, res) => res.sendFile(path.join(publicDir, 'betting-houses.html')));
    app.get('/supervisor', (req, res) => res.sendFile(path.join(publicDir, 'supervisor-status.html')));

    const server = app.listen(port, host, () => {
        console.log(`BETTING_HOUSE_API_DEV_READY http://${host}:${port}`);
        console.log(`ACCESSES_UI_READY http://${host}:${port}/accesses`);
        console.log(`BETTING_HOUSE_UI_READY http://${host}:${port}/betting-houses`);
        console.log(`SUPERVISOR_UI_READY http://${host}:${port}/supervisor`);
    });
    const shutdown = async () => { await new Promise(resolve => server.close(resolve)); await dbPool.end(); };
    process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
    process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
}

main().catch(error => {
    console.error('BETTING_HOUSE_API_DEV_FAILED:', error?.message || error);
    process.exitCode = 1;
});
