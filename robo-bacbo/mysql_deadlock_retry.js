'use strict';

const MYSQL_DEADLOCK_ERRNO = 1213;
const MYSQL_DEADLOCK_CODE = 'ER_LOCK_DEADLOCK';
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 50;

function isMysqlDeadlock(error) {
    if (!error || typeof error !== 'object') return false;
    if (String(error.code || '').toUpperCase() === MYSQL_DEADLOCK_CODE) return true;
    if (Number(error.errno) === MYSQL_DEADLOCK_ERRNO) return true;
    return Number(error.sqlState) === 40001
        && /deadlock/i.test(String(error.message || ''));
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function withMysqlDeadlockRetry(operation, {
    attempts = DEFAULT_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    onRetry = null,
    sleepFn = sleep
} = {}) {
    if (typeof operation !== 'function') {
        throw new TypeError('MYSQL_DEADLOCK_RETRY_OPERATION_REQUIRED');
    }

    const maxAttempts = Math.max(1, Math.min(10, Number(attempts) || DEFAULT_ATTEMPTS));
    const baseDelay = Math.max(0, Math.min(5000, Number(baseDelayMs) || 0));

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await operation(attempt);
        } catch (error) {
            const retryable = isMysqlDeadlock(error) && attempt < maxAttempts;
            if (!retryable) throw error;

            const delayMs = baseDelay * (2 ** (attempt - 1));
            if (typeof onRetry === 'function') {
                onRetry({ attempt, nextAttempt: attempt + 1, delayMs, error });
            }
            if (delayMs > 0) await sleepFn(delayMs);
        }
    }

    throw new Error('MYSQL_DEADLOCK_RETRY_EXHAUSTED');
}

module.exports = {
    MYSQL_DEADLOCK_ERRNO,
    MYSQL_DEADLOCK_CODE,
    DEFAULT_ATTEMPTS,
    DEFAULT_BASE_DELAY_MS,
    isMysqlDeadlock,
    withMysqlDeadlockRetry
};
