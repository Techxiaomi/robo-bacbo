'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeAccountIds,
    liveBridgeAdapterSupported,
    SUPPORTED_LIVE_BRIDGE_ADAPTERS
} = require('../trader_account_binding');

test('normaliza IDs de contas sem duplicatas e em ordem', () => {
    assert.deepEqual(normalizeAccountIds(['4', 1, '4', 1]), [1, 4]);
});

test('vinculo aceita somente adapters com Live Bridge homologado', () => {
    assert.equal(SUPPORTED_LIVE_BRIDGE_ADAPTERS.has('brasil-da-sorte'), true);
    assert.equal(liveBridgeAdapterSupported('brasil-da-sorte'), true);
    assert.equal(liveBridgeAdapterSupported(' BRASIL-DA-SORTE '), true);
    assert.equal(liveBridgeAdapterSupported('adapter-futuro'), false);
    assert.equal(liveBridgeAdapterSupported(''), false);
});
