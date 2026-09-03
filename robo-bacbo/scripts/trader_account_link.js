'use strict';

const path = require('path');
const mysql = require('mysql2/promise');

require('../env_loader').loadEnvFile(path.join(__dirname, '..', '..', '.env'));

const {
    setTraderAccounts,
    clearTraderAccounts,
    listTraderAccountBindings
} = require('../trader_account_binding');

function createDbPool() {
    return mysql.createPool({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        waitForConnections: true,
        connectionLimit: 2,
        queueLimit: 0
    });
}

function usage() {
    console.log('Uso:');
    console.log('  node scripts/trader_account_link.js list');
    console.log('  node scripts/trader_account_link.js set <trader_id> <account_id> [account_id...]');
    console.log('  node scripts/trader_account_link.js clear <trader_id>');
}

function printBindings(items) {
    if (!Array.isArray(items) || items.length === 0) {
        console.log('TRADER_ACCOUNT_BINDING_COUNT=0');
        return;
    }
    console.log(`TRADER_ACCOUNT_BINDING_TRADER_COUNT=${items.length}`);
    for (const trader of items) {
        const accounts = trader.accounts.map(item => item.account_id).join(',') || '-';
        console.log(
            `TRADER_ACCOUNT_BINDING trader=${trader.trader_id} active=${trader.trader_active} ` +
            `table=${trader.table_code} accounts=${accounts} name=${trader.trader_name}`
        );
        for (const account of trader.accounts) {
            console.log(
                `  ACCOUNT id=${account.account_id} enabled=${account.account_enabled} ` +
                `table_enabled=${account.table_enabled} name=${account.account_name}`
            );
        }
    }
}

async function main() {
    const command = String(process.argv[2] || '').trim().toLowerCase();
    const dbPool = createDbPool();
    try {
        if (command === 'list') {
            printBindings(await listTraderAccountBindings(dbPool));
            return;
        }

        if (command === 'set') {
            const traderId = process.argv[3];
            const accountIds = process.argv.slice(4);
            if (!traderId || accountIds.length === 0) {
                usage();
                process.exitCode = 2;
                return;
            }
            const result = await setTraderAccounts(dbPool, traderId, accountIds);
            console.log(
                `TRADER_ACCOUNT_BINDING_SET trader=${result.trader.id} ` +
                `table=${result.trader.mesa_codigo} accounts=${result.accounts.map(item => item.id).join(',')}`
            );
            return;
        }

        if (command === 'clear') {
            const traderId = process.argv[3];
            if (!traderId) {
                usage();
                process.exitCode = 2;
                return;
            }
            const result = await clearTraderAccounts(dbPool, traderId);
            console.log(`TRADER_ACCOUNT_BINDING_CLEARED trader=${result.trader_id} removed=${result.removed}`);
            return;
        }

        usage();
        process.exitCode = 2;
    } finally {
        await dbPool.end();
    }
}

main().catch(error => {
    console.error('TRADER_ACCOUNT_BINDING_FAILED:', error?.message || error);
    process.exitCode = 1;
});
