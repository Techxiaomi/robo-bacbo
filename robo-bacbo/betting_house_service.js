'use strict';

const { createCredentialVault } = require('./betting_house_credential_vault');
const { createBettingHouseRepository } = require('./betting_house_repository');

const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;

function requiredString(value, field, maxLength) {
    const normalized = String(value ?? '').trim();
    if (!normalized || normalized.length > maxLength) {
        const error = new Error(`BETTING_HOUSE_INVALID_${field.toUpperCase()}`);
        error.statusCode = 400;
        throw error;
    }
    return normalized;
}

function optionalString(value, maxLength) {
    const normalized = String(value ?? '').trim();
    if (normalized.length > maxLength) {
        const error = new Error('BETTING_HOUSE_FIELD_TOO_LONG');
        error.statusCode = 400;
        throw error;
    }
    return normalized;
}

function normalizedKey(value, field) {
    const normalized = requiredString(value, field, 80).toLowerCase();
    if (!KEY_PATTERN.test(normalized)) {
        const error = new Error(`BETTING_HOUSE_INVALID_${field.toUpperCase()}`);
        error.statusCode = 400;
        throw error;
    }
    return normalized;
}

function normalizedUrl(value, field) {
    const normalized = requiredString(value, field, 2048);
    let parsed;
    try {
        parsed = new URL(normalized);
    } catch (_) {
        parsed = null;
    }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
        const error = new Error(`BETTING_HOUSE_INVALID_${field.toUpperCase()}`);
        error.statusCode = 400;
        throw error;
    }
    return normalized;
}

function normalizeTable(input = {}) {
    return {
        table_key: normalizedKey(input.table_key, 'table_key'),
        display_name: requiredString(input.display_name, 'display_name', 120),
        game_url: normalizedUrl(input.game_url, 'game_url'),
        enabled: input.enabled !== false
    };
}

function parseId(value, field = 'id') {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) {
        const error = new Error(`BETTING_HOUSE_INVALID_${field.toUpperCase()}`);
        error.statusCode = 400;
        throw error;
    }
    return id;
}

function createBettingHouseService({ dbPool, encryptionKey } = {}) {
    const repository = createBettingHouseRepository({ dbPool });
    const vault = createCredentialVault({ encodedKey: encryptionKey });

    async function listHouses(options) {
        return repository.listHouses(options);
    }

    async function getHouse(id) {
        const house = await repository.getHouseById(parseId(id));
        if (!house) {
            const error = new Error('BETTING_HOUSE_NOT_FOUND');
            error.statusCode = 404;
            throw error;
        }
        return house;
    }

    async function createHouse(input = {}) {
        const tables = Array.isArray(input.tables) ? input.tables.map(normalizeTable) : [];
        const uniqueKeys = new Set(tables.map(table => table.table_key));
        if (uniqueKeys.size !== tables.length) {
            const error = new Error('BETTING_HOUSE_DUPLICATE_TABLE_KEY');
            error.statusCode = 400;
            throw error;
        }

        return repository.createHouse({
            name: requiredString(input.name, 'name', 120),
            adapter_key: normalizedKey(input.adapter_key, 'adapter_key'),
            home_url: normalizedUrl(input.home_url, 'home_url'),
            username: optionalString(input.username, 190),
            password_encrypted: input.password ? vault.encrypt(String(input.password)) : null,
            session_state_file: optionalString(input.session_state_file, 500),
            enabled: input.enabled !== false,
            tables
        });
    }

    async function updateHouse(idValue, input = {}) {
        const id = parseId(idValue);
        const patch = {};

        if (Object.prototype.hasOwnProperty.call(input, 'name')) {
            patch.name = requiredString(input.name, 'name', 120);
        }
        if (Object.prototype.hasOwnProperty.call(input, 'adapter_key')) {
            patch.adapter_key = normalizedKey(input.adapter_key, 'adapter_key');
        }
        if (Object.prototype.hasOwnProperty.call(input, 'home_url')) {
            patch.home_url = normalizedUrl(input.home_url, 'home_url');
        }
        if (Object.prototype.hasOwnProperty.call(input, 'username')) {
            patch.username = optionalString(input.username, 190) || null;
        }
        if (Object.prototype.hasOwnProperty.call(input, 'session_state_file')) {
            patch.session_state_file = optionalString(input.session_state_file, 500) || null;
        }
        if (Object.prototype.hasOwnProperty.call(input, 'enabled')) {
            patch.enabled = input.enabled === true;
        }
        if (Object.prototype.hasOwnProperty.call(input, 'password') && String(input.password) !== '') {
            patch.password_encrypted = vault.encrypt(String(input.password));
        }

        const house = await repository.updateHouse(id, patch);
        if (!house) {
            const error = new Error('BETTING_HOUSE_NOT_FOUND');
            error.statusCode = 404;
            throw error;
        }
        return house;
    }

    async function deactivateHouse(idValue) {
        const ok = await repository.deactivateHouse(parseId(idValue));
        if (!ok) {
            const error = new Error('BETTING_HOUSE_NOT_FOUND');
            error.statusCode = 404;
            throw error;
        }
        return { success: true };
    }

    async function createTable(houseIdValue, input = {}) {
        const houseId = parseId(houseIdValue, 'house_id');
        await getHouse(houseId);
        return repository.createTable(houseId, normalizeTable(input));
    }

    async function updateTable(houseIdValue, tableIdValue, input = {}) {
        const houseId = parseId(houseIdValue, 'house_id');
        const tableId = parseId(tableIdValue, 'table_id');
        const patch = {};

        if (Object.prototype.hasOwnProperty.call(input, 'table_key')) {
            patch.table_key = normalizedKey(input.table_key, 'table_key');
        }
        if (Object.prototype.hasOwnProperty.call(input, 'display_name')) {
            patch.display_name = requiredString(input.display_name, 'display_name', 120);
        }
        if (Object.prototype.hasOwnProperty.call(input, 'game_url')) {
            patch.game_url = normalizedUrl(input.game_url, 'game_url');
        }
        if (Object.prototype.hasOwnProperty.call(input, 'enabled')) {
            patch.enabled = input.enabled === true;
        }

        const table = await repository.updateTable(houseId, tableId, patch);
        if (!table) {
            const error = new Error('BETTING_HOUSE_TABLE_NOT_FOUND');
            error.statusCode = 404;
            throw error;
        }
        return table;
    }

    async function deactivateTable(houseIdValue, tableIdValue) {
        const ok = await repository.deactivateTable(
            parseId(houseIdValue, 'house_id'),
            parseId(tableIdValue, 'table_id')
        );
        if (!ok) {
            const error = new Error('BETTING_HOUSE_TABLE_NOT_FOUND');
            error.statusCode = 404;
            throw error;
        }
        return { success: true };
    }

    async function getRuntimeConfig(idValue) {
        const secret = await repository.getRuntimeSecretById(parseId(idValue));
        if (!secret || secret.enabled !== true) {
            const error = new Error('BETTING_HOUSE_NOT_AVAILABLE');
            error.statusCode = 404;
            throw error;
        }

        return Object.freeze({
            id: secret.id,
            name: secret.name,
            adapter_key: secret.adapter_key,
            home_url: secret.home_url,
            username: secret.username,
            password: secret.password_encrypted ? vault.decrypt(secret.password_encrypted) : '',
            session_state_file: secret.session_state_file,
            tables: secret.tables.map(table => Object.freeze({ ...table }))
        });
    }

    return Object.freeze({
        listHouses,
        getHouse,
        createHouse,
        updateHouse,
        deactivateHouse,
        createTable,
        updateTable,
        deactivateTable,
        getRuntimeConfig
    });
}

module.exports = {
    createBettingHouseService
};
