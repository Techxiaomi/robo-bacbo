'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

require('../env_loader').loadEnvFile(path.join(__dirname, '..', '..', '.env'));

const FRESH_DB = 'bacbo_migration_fresh_test';
const GUARD_DB = 'bacbo_migration_guard_test';

function quoteIdentifier(value) {
    const text = String(value || '');
    if (!/^[A-Za-z0-9_]+$/.test(text)) {
        throw new Error(`VERIFY_INVALID_IDENTIFIER: ${text}`);
    }
    return `\`${text}\``;
}

function migrationFiles() {
    const dir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(dir)
        .filter(name => /^\d+.*\.sql$/i.test(name))
        .sort((a, b) => a.localeCompare(b));

    const expected = [
        '20260901_01_create_betting_houses.sql',
        '20260901_02_allow_multi_account_adapter_key.sql'
    ];

    for (let index = 0; index < expected.length; index += 1) {
        if (files[index] !== expected[index]) {
            throw new Error(
                `VERIFY_MIGRATION_ORDER_INVALID: expected=${expected.join(',')} actual=${files.join(',')}`
            );
        }
    }

    return { dir, files };
}

function connectionConfig(database) {
    const config = {
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        multipleStatements: true
    };
    if (database) config.database = database;
    return config;
}

async function applyMigrations(connection, dir, files) {
    for (const fileName of files) {
        const sql = fs.readFileSync(path.join(dir, fileName), 'utf8');
        console.log(`VERIFY_MIGRATION_APPLY=${fileName}`);
        await connection.query(sql);
    }
}

async function requireTable(connection, schema, table) {
    const [rows] = await connection.execute(
        `SELECT COUNT(*) AS total
         FROM information_schema.tables
         WHERE table_schema = ? AND table_name = ?`,
        [schema, table]
    );
    if (Number(rows[0]?.total || 0) !== 1) {
        throw new Error(`VERIFY_TABLE_MISSING: ${schema}.${table}`);
    }
}

async function requireForeignKey(connection, schema) {
    const [rows] = await connection.execute(
        `SELECT referenced_table_name, delete_rule
         FROM information_schema.referential_constraints
         WHERE constraint_schema = ?
           AND table_name = 'betting_house_tables'
           AND constraint_name = 'fk_betting_house_tables_house'`,
        [schema]
    );
    const row = rows[0];
    if (!row || row.referenced_table_name !== 'betting_houses' || row.delete_rule !== 'CASCADE') {
        throw new Error('VERIFY_FOREIGN_KEY_INVALID');
    }
}

async function requireAdapterIndexes(connection, schema) {
    const [rows] = await connection.execute(
        `SELECT index_name, non_unique
         FROM information_schema.statistics
         WHERE table_schema = ?
           AND table_name = 'betting_houses'
           AND index_name IN ('idx_betting_houses_adapter_key', 'uq_betting_houses_adapter_key')`,
        [schema]
    );

    const normal = rows.find(row => row.index_name === 'idx_betting_houses_adapter_key');
    const legacyUnique = rows.find(row => row.index_name === 'uq_betting_houses_adapter_key');

    if (!normal || Number(normal.non_unique) !== 1) {
        throw new Error('VERIFY_ADAPTER_INDEX_MISSING_OR_UNIQUE');
    }
    if (legacyUnique) {
        throw new Error('VERIFY_LEGACY_UNIQUE_INDEX_PRESENT');
    }
}

async function requireGuardSchemaEmpty(connection, schema) {
    const [rows] = await connection.execute(
        `SELECT COUNT(*) AS total
         FROM information_schema.tables
         WHERE table_schema = ?`,
        [schema]
    );
    if (Number(rows[0]?.total || 0) !== 0) {
        throw new Error('VERIFY_GUARD_SCHEMA_NOT_EMPTY');
    }
}

async function main() {
    const configuredDb = String(process.env.DB_NAME || '').trim();
    if (!configuredDb) throw new Error('VERIFY_DB_NAME_REQUIRED');
    if (configuredDb === FRESH_DB || configuredDb === GUARD_DB) {
        throw new Error('VERIFY_TEST_DATABASE_COLLIDES_WITH_CONFIGURED_DATABASE');
    }

    const { dir, files } = migrationFiles();
    const admin = await mysql.createConnection(connectionConfig());
    let fresh = null;
    let guard = null;

    try {
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(FRESH_DB)}`);
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(GUARD_DB)}`);
        await admin.query(
            `CREATE DATABASE ${quoteIdentifier(FRESH_DB)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
        );
        await admin.query(
            `CREATE DATABASE ${quoteIdentifier(GUARD_DB)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
        );

        fresh = await mysql.createConnection(connectionConfig(FRESH_DB));
        guard = await mysql.createConnection(connectionConfig(GUARD_DB));

        console.log('VERIFY_PHASE=FRESH_INSTALL_FIRST_PASS');
        await applyMigrations(fresh, dir, files);
        await requireTable(fresh, FRESH_DB, 'betting_houses');
        await requireTable(fresh, FRESH_DB, 'betting_house_tables');
        await requireForeignKey(fresh, FRESH_DB);
        await requireAdapterIndexes(fresh, FRESH_DB);

        console.log('VERIFY_PHASE=FRESH_INSTALL_SECOND_PASS');
        await applyMigrations(fresh, dir, files);
        await requireTable(fresh, FRESH_DB, 'betting_houses');
        await requireTable(fresh, FRESH_DB, 'betting_house_tables');
        await requireForeignKey(fresh, FRESH_DB);
        await requireAdapterIndexes(fresh, FRESH_DB);

        console.log('VERIFY_PHASE=INCREMENTAL_GUARD_ISOLATED');
        const guardSql = fs.readFileSync(
            path.join(dir, '20260901_02_allow_multi_account_adapter_key.sql'),
            'utf8'
        );
        await guard.query(guardSql);
        await requireGuardSchemaEmpty(guard, GUARD_DB);

        console.log('VERIFY_FRESH_INSTALL_SUCCESS=true');
        console.log('VERIFY_IDEMPOTENCY_SUCCESS=true');
        console.log('VERIFY_GUARD_SUCCESS=true');
    } finally {
        if (fresh) await fresh.end().catch(() => {});
        if (guard) await guard.end().catch(() => {});
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(FRESH_DB)}`).catch(() => {});
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(GUARD_DB)}`).catch(() => {});
        await admin.end().catch(() => {});
    }
}

main().catch(error => {
    console.error('VERIFY_BETTING_HOUSE_FRESH_INSTALL_FAILED:', error?.message || error);
    process.exitCode = 1;
});
