'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
const IV_BYTES = 12;

function decodeEncryptionKey(encodedKey) {
    const normalized = String(encodedKey || '').trim();
    if (!normalized) {
        throw new Error('BETTING_HOUSE_CREDENTIALS_KEY_NOT_CONFIGURED');
    }

    const key = Buffer.from(normalized, 'base64');
    if (key.length !== 32) {
        throw new Error('BETTING_HOUSE_CREDENTIALS_KEY_INVALID: expected 32 bytes encoded as base64');
    }

    return key;
}

function createCredentialVault({ encodedKey = process.env.BETTING_HOUSE_CREDENTIALS_KEY } = {}) {
    let keyCache = null;

    const getKey = () => {
        if (!keyCache) keyCache = decodeEncryptionKey(encodedKey);
        return keyCache;
    };

    function encrypt(plaintext) {
        const value = String(plaintext ?? '');
        if (!value) return null;

        const iv = crypto.randomBytes(IV_BYTES);
        const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
        const ciphertext = Buffer.concat([
            cipher.update(value, 'utf8'),
            cipher.final()
        ]);
        const authTag = cipher.getAuthTag();

        return [
            VERSION,
            iv.toString('base64'),
            authTag.toString('base64'),
            ciphertext.toString('base64')
        ].join(':');
    }

    function decrypt(payload) {
        const value = String(payload || '').trim();
        if (!value) return '';

        const parts = value.split(':');
        if (parts.length !== 4 || parts[0] !== VERSION) {
            throw new Error('BETTING_HOUSE_CREDENTIAL_PAYLOAD_INVALID');
        }

        const iv = Buffer.from(parts[1], 'base64');
        const authTag = Buffer.from(parts[2], 'base64');
        const ciphertext = Buffer.from(parts[3], 'base64');

        if (iv.length !== IV_BYTES || authTag.length !== 16) {
            throw new Error('BETTING_HOUSE_CREDENTIAL_PAYLOAD_INVALID');
        }

        const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
        decipher.setAuthTag(authTag);

        return Buffer.concat([
            decipher.update(ciphertext),
            decipher.final()
        ]).toString('utf8');
    }

    return Object.freeze({ encrypt, decrypt });
}

module.exports = {
    createCredentialVault,
    decodeEncryptionKey
};
