'use strict';

const path = require('path');
const express = require('express');
const mysql = require('mysql2/promise');

require('../env_loader').loadEnvFile(path.join(__dirname, '..', '..', '.env'));

const { installBettingHouseApi } = require('../betting_house_api');
const { readSupervisorSnapshot } = require('../supervisor_telemetry_store');

async function main() {
    const host = '127.0.0.1';
    const port = Number(process.env.BETTING_HOUSE_API_DEV_PORT || 3010);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        throw new Error('BETTING_HOUSE_API_DEV_PORT_INVALID');
    }

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

    installBettingHouseApi(app, {
        dbPool,
        encryptionKey: process.env.BETTING_HOUSE_CREDENTIALS_KEY
    });

    app.get('/api/supervisor/status', (req, res) => {
        const snapshot = readSupervisorSnapshot();
        res.set('Cache-Control', 'no-store');
        res.json({
            ...snapshot,
            healthy: Boolean(
                snapshot.available &&
                !snapshot.stale &&
                snapshot.supervisor?.running === true
            )
        });
    });

    const publicDir = path.join(__dirname, '..', 'public');
    app.use(express.static(publicDir));

    app.get('/', (req, res) => res.redirect('/accesses'));
    app.get('/accesses', (req, res) => {
        res.sendFile(path.join(publicDir, 'accesses.html'));
    });
    app.get('/betting-houses', (req, res) => {
        res.sendFile(path.join(publicDir, 'betting-houses.html'));
    });
    app.get('/supervisor', (req, res) => {
        res.sendFile(path.join(publicDir, 'supervisor-status.html'));
    });

    const server = app.listen(port, host, () => {
        console.log(`BETTING_HOUSE_API_DEV_READY http://${host}:${port}`);
        console.log(`ACCESSES_UI_READY http://${host}:${port}/accesses`);
        console.log(`BETTING_HOUSE_UI_READY http://${host}:${port}/betting-houses`);
        console.log(`SUPERVISOR_UI_READY http://${host}:${port}/supervisor`);
    });

    const shutdown = async () => {
        await new Promise(resolve => server.close(resolve));
        await dbPool.end();
    };

    process.once('SIGINT', () => {
        void shutdown().finally(() => process.exit(0));
    });
    process.once('SIGTERM', () => {
        void shutdown().finally(() => process.exit(0));
    });
}

main().catch(error => {
    console.error('BETTING_HOUSE_API_DEV_FAILED:', error?.message || error);
    process.exitCode = 1;
});
