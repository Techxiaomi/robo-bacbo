'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

require('../env_loader').loadEnvFile(path.join(__dirname, '..', '..', '.env'));

const FRESH_PREFIX = '__migration_verify_fresh';
const GUARD_PREFIX = '__migration_verify_guard';

function quoteIdentifier(value) {
    const text = String(value || '');
    if (!/^[A-Za-z0-9_]+$/.test(text)) {
        throw new Error(`VERIFY_INVALID_IDENTIFIER: ${text}`);
    }
    return `\`${text}\``;
}

function namesFor(prefix) {
    const houses = `${prefix}_betting_houses`;
    return Object.freeze({
        houses,
        tables: `${prefix}_betting_house_tables`,
        foreignKey: `${prefix}_fk_house`,
        adapterIndex: `idx_${houses}_adapter_key`,
        legacyUniqueIndex: `uq_${houses}_adapter_key`
    });
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

function connectionConfig() {
    const database = String(process.env.DB_NAME || '').trim();
    if (!database) throw new Error('VERIFY_DB_NAME_REQUIRED');

    return {
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database,
        multipleStatements: true
    };
}

function transformMigrationSql(sql, names) {
    return String(sql)
        .replaceAll('fk_betting_house_tables_house', names.foreignKey)
        .replaceAll('betting_house_tables', names.tables)
        .replaceAll('betting_houses', names.houses);
}

async function applyMigrations(connection, dir, files, names) {
    for (const fileName of files) {
        const originalSql = fs.readFileSync(path.join(dir, fileName), 'utf8');
        const sql = transformMigrationSql(originalSql, names);
        console.log(`VERIFY_MIGRATION_APPLY=${fileName}`);
        await connection.query(sql);
    }
}

async function cleanupTables(connection, names) {
    await connection.query(`DROP TABLE IF EXISTS ${quoteIdentifier(names.tables)}`);
    await connection.query(`DROP TABLE IF EXISTS ${quoteIdentifier(names.houses)}`);
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

async function requireForeignKey(connection, schema, names) {
    const [rows] = await connection.execute(
        `SELECT referenced_table_name, delete_rule
         FROM information_schema.referential_constraints
         WHERE constraint_schema = ?
           AND table_name = ?
           AND constraint_name = ?`,
        [schema, names.tables, names.foreignKey]
    );
    const row = rows[0];
    if (!row || row.referenced_table_name !== names.houses || row.delete_rule !== 'CASCADE') {
        throw new Error('VERIFY_FOREIGN_KEY_INVALID');
    }
}

async function requireAdapterIndexes(connection, schema, names) {
    const [rows] = await connection.execute(
        `SELECT index_name, non_unique
         FROM information_schema.statistics
         WHERE table_schema = ?
           AND table_name = ?
           AND index_name IN (?, ?)`,
        [schema, names.houses, names.adapterIndex, names.legacyUniqueIndex]
    );

    const normal = rows.find(row => row.index_name === names.adapterIndex);
    const legacyUnique = rows.find(row => row.index_name === names.legacyUniqueIndex);

    if (!normal || Number(normal.non_unique) !== 1) {
        throw new Error('VERIFY_ADAPTER_INDEX_MISSING_OR_UNIQUE');
    }
    if (legacyUnique) {
        throw new Error('VERIFY_LEGACY_UNIQUE_INDEX_PRESENT');
    }
}

async function requirePrefixedTablesAbsent(connection, schema, names) {
    const [rows] = await connection.execute(
        `SELECT COUNT(*) AS total
         FROM information_schema.tables
         WHERE table_schema = ?
           AND table_name IN (?, ?)`,
        [schema, names.houses, names.tables]
    );
    if (Number(rows[0]?.total || 0) !== 0) {
        throw new Error('VERIFY_GUARD_CREATED_TABLES_UNEXPECTEDLY');
    }
}

async function main() {
    const schema = String(process.env.DB_NAME || '').trim();
    if (!schema) throw new Error('VERIFY_DB_NAME_REQUIRED');

    const freshNames = namesFor(FRESH_PREFIX);
    const guardNames = namesFor(GUARD_PREFIX);
    const { dir, files } = migrationFiles();
    const connection = await mysql.createConnection(connectionConfig());

    try {
        console.log('VERIFY_MODE=ISOLATED_PREFIXED_TABLES');
        console.log(`VERIFY_SCHEMA=${schema}`);

        await cleanupTables(connection, guardNames);
        await cleanupTables(connection, freshNames);

        console.log('VERIFY_PHASE=FRESH_INSTALL_FIRST_PASS');
        await applyMigrations(connection, dir, files, freshNames);
        await requireTable(connection, schema, freshNames.houses);
        await requireTable(connection, schema, freshNames.tables);
        await requireForeignKey(connection, schema, freshNames);
        await requireAdapterIndexes(connection, schema, freshNames);

        console.log('VERIFY_PHASE=FRESH_INSTALL_SECOND_PASS');
        await applyMigrations(connection, dir, files, freshNames);
        await requireTable(connection, schema, freshNames.houses);
        await requireTable(connection, schema, freshNames.tables);
        await requireForeignKey(connection, schema, freshNames);
        await requireAdapterIndexes(connection, schema, freshNames);

        console.log('VERIFY_PHASE=INCREMENTAL_GUARD_ISOLATED');
        const guardSqlOriginal = fs.readFileSync(
            path.join(dir, '20260901_02_allow_multi_account_adapter_key.sql'),
            'utf8'
        );
        const guardSql = transformMigrationSql(guardSqlOriginal, guardNames);
        await connection.query(guardSql);
        await requirePrefixedTablesAbsent(connection, schema, guardNames);

        console.log('VERIFY_FRESH_INSTALL_SUCCESS=true');
        console.log('VERIFY_IDEMPOTENCY_SUCCESS=true');
        console.log('VERIFY_GUARD_SUCCESS=true');
    } finally {
        await cleanupTables(connection, guardNames).catch(() => {});
        await cleanupTables(connection, freshNames).catch(() => {});
        await connection.end().catch(() => {});
    }
}

main().catch(error => {
    console.error('VERIFY_BETTING_HOUSE_FRESH_INSTALL_FAILED:', error?.message || error);
    process.exitCode = 1;
});
