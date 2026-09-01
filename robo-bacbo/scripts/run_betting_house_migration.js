'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

require('../env_loader').loadEnvFile(path.join(__dirname, '..', '..', '.env'));

async function main() {
    const sqlPath = path.join(
        __dirname,
        '..',
        'migrations',
        '20260901_create_betting_houses.sql'
    );
    const sql = fs.readFileSync(sqlPath, 'utf8');

    const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        multipleStatements: true
    });

    try {
        await connection.query(sql);
        console.log('BETTING_HOUSE_MIGRATION_SUCCESS');
    } finally {
        await connection.end();
    }
}

main().catch(error => {
    console.error('BETTING_HOUSE_MIGRATION_FAILED:', error?.message || error);
    process.exitCode = 1;
});
