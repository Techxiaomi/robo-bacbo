'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const sourcePath = path.join(__dirname, '..', 'auto_trader_activation_bootstrap.js');
const source = fs.readFileSync(sourcePath, 'utf8');

function activationSyncBalanceBlock() {
    const match = source.match(
        /for \(const accountId of context\.accountIds\) \{[\s\S]*?publisher\.publish\(channel, JSON\.stringify\(\{[\s\S]*?action:\s*'sync_balance',[\s\S]*?\}\)\);[\s\S]*?\}/m
    );
    assert.ok(match, 'bootstrap deve conter publicacao de sync_balance por conta');
    return match[0];
}

test('etapa 4: sync_balance da ativacao envia identidade roteada completa', () => {
    const block = activationSyncBalanceBlock();

    assert.match(block, /routed_account_id:\s*accountId/);
    assert.match(block, /routed_session_id:\s*taskId\(accountId,\s*context\.tableKey\)/);
    assert.match(block, /routed_table_key:\s*context\.tableKey/);
});

test('etapa 4: identidade roteada permanece coerente com o canal account+table', () => {
    const block = activationSyncBalanceBlock();

    assert.match(
        block,
        /channelsFor\(accountId,\s*context\.tableKey\)\.command/
    );
    assert.match(block, /request_id:\s*requestId/);
});
