'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

require('../env_loader').loadEnvFile(path.join(__dirname, '..', '..', '.env'));

async function main() {
    const migrationsDir = path.join(__dirname, '..', 'migrations');
    const migrationFiles = fs.readdirSync(migrationsDir)
        .filter(name => /^\d+.*\.sql$/i.test(name))
        .sort((a, b) => a.localeCompare(b));

    if (migrationFiles.length === 0) {
        throw new Error('BETTING_HOUSE_MIGRATION_NOT_FOUND');
    }

    const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        multipleStatements: true
    });

    try {
        for (const fileName of migrationFiles) {
            const sqlPath = path.join(migrationsDir, fileName);
            const sql = fs.readFileSync(sqlPath, 'utf8');
            console.log(`BETTING_HOUSE_MIGRATION_APPLY=${fileName}`);
            await connection.query(sql);
        }
        console.log(`BETTING_HOUSE_MIGRATION_SUCCESS=${migrationFiles.length}`);
    } finally {
        await connection.end();
    }
}

main().catch(error => {
    console.error('BETTING_HOUSE_MIGRATION_FAILED:', error?.message || error);
    process.exitCode = 1;
});
