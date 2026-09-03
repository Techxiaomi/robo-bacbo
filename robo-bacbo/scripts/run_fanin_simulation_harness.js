'use strict';

const crypto = require('crypto');
const path = require('path');
const { createClient } = require('redis');

require('../env_loader').loadEnvFile(path.join(__dirname, '..', '..', '.env'));

const { ResultFanIn } = require('../signal_result_fanin');

const TABLE_KEY = String(process.env.FANIN_SIM_TABLE_KEY || 'bacbo_int').trim().toLowerCase();
const ACCOUNT_IDS = String(process.env.FANIN_SIM_ACCOUNT_IDS || '1,4')
    .split(',')
    .map(value => Number(String(value).trim()))
    .filter(value => Number.isSafeInteger(value) && value > 0);
const TIMEOUT_MS = Number(process.env.FANIN_SIM_TIMEOUT_MS || 5000);

function assertConfig() {
    if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(TABLE_KEY)) {
        throw new Error(`FANIN_SIM_TABLE_KEY_INVALID: ${TABLE_KEY}`);
    }
    if (ACCOUNT_IDS.length < 2 || new Set(ACCOUNT_IDS).size !== ACCOUNT_IDS.length) {
        throw new Error('FANIN_SIM_ACCOUNT_IDS_INVALID');
    }
    if (!Number.isSafeInteger(TIMEOUT_MS) || TIMEOUT_MS < 1000 || TIMEOUT_MS > 30000) {
        throw new Error(`FANIN_SIM_TIMEOUT_MS_INVALID: ${TIMEOUT_MS}`);
    }
}

function redisUrl() {
    return String(process.env.REDIS_URL || 'redis://127.0.0.1:6379').trim()
        || 'redis://127.0.0.1:6379';
}

function buildSyntheticOrderId(runId, accountId) {
    const digest = crypto.createHash('sha256')
        .update(`fanin-harness-v1|${runId}|${accountId}|${TABLE_KEY}`)
        .digest('hex')
        .slice(0, 32);
    return `sim-${digest}`;
}

function buildTargets(runId) {
    return ACCOUNT_IDS.map(accountId => ({
        account_id: accountId,
        session_id: `account-${accountId}:${TABLE_KEY}`,
        order_id: buildSyntheticOrderId(runId, accountId),
        response_channel: `auto_trader_responses:${accountId}:${TABLE_KEY}`,
        command_channel: `auto_trader_commands:${accountId}:${TABLE_KEY}`
    }));
}

function syntheticBetResult(target) {
    return {
        action: 'bet_result',
        order_id: target.order_id,
        status: 'EXECUTADA',
        motivo: 'SYNTHETIC_FANIN_HARNESS_NO_FINANCIAL_DISPATCH',
        simulation: true,
        confirmacao: {
            metodo: 'SYNTHETIC_FANIN_HARNESS',
            saldo_antes: 0,
            saldo_depois: 0,
            debito_observado: 0,
            exposicao_esperada: 0
        }
    };
}

async function main() {
    assertConfig();

    const runId = `fanin-sim-${Date.now()}-${process.pid}`;
    const targets = buildTargets(runId);
    const publisher = createClient({ url: redisUrl() });
    const subscriber = publisher.duplicate();
    let finalResult = null;
    let resolveFinal;
    let rejectFinal;
    const finalPromise = new Promise((resolve, reject) => {
        resolveFinal = resolve;
        rejectFinal = reject;
    });

    const fanin = new ResultFanIn({
        timeoutMs: TIMEOUT_MS,
        publish: async consolidated => {
            finalResult = consolidated;
            resolveFinal(consolidated);
        }
    });

    const timer = setTimeout(() => {
        rejectFinal(new Error('FANIN_SIM_HARNESS_TIMEOUT'));
    }, TIMEOUT_MS + 1500);
    timer.unref?.();

    try {
        await Promise.all([publisher.connect(), subscriber.connect()]);

        for (const target of targets) {
            await subscriber.subscribe(target.response_channel, message => {
                let payload;
                try { payload = JSON.parse(String(message || '')); }
                catch (_) { return; }
                void fanin.accept(target.response_channel, payload).catch(error => {
                    rejectFinal(error);
                });
            });
        }

        const numsub = await publisher.sendCommand([
            'PUBSUB',
            'NUMSUB',
            ...targets.map(target => target.command_channel)
        ]);

        console.log('=== FANIN SIMULATION HARNESS ===');
        console.log(`FANIN_SIM_RUN_ID=${runId}`);
        console.log(`FANIN_SIM_TABLE_KEY=${TABLE_KEY}`);
        console.log(`FANIN_SIM_ACCOUNTS=${ACCOUNT_IDS.join(',')}`);
        console.log(`FANIN_SIM_COMMAND_NUMSUB=${JSON.stringify(numsub)}`);
        console.log('FANIN_SIM_FINANCIAL_DISPATCH=0');
        console.log('FANIN_SIM_GLOBAL_SIGNAL_PUBLISH=0');

        fanin.register({
            signalId: runId,
            tableKey: TABLE_KEY,
            targets: targets.map(target => ({
                account_id: target.account_id,
                session_id: target.session_id,
                order_id: target.order_id,
                response_channel: target.response_channel
            }))
        });

        for (const target of targets) {
            console.log(
                `FANIN_SIM_EXPECTED_TARGET account=${target.account_id} ` +
                `order_id=${target.order_id} channel=${target.response_channel}`
            );
        }

        for (const target of targets) {
            const payload = syntheticBetResult(target);
            const subscribers = await publisher.publish(
                target.response_channel,
                JSON.stringify(payload)
            );
            console.log(
                `FANIN_SIM_SYNTHETIC_RESPONSE account=${target.account_id} ` +
                `order_id=${target.order_id} subscribers=${subscribers}`
            );
        }

        const result = await finalPromise;
        if (!result || result.status !== 'FULL_SUCCESS') {
            throw new Error(`FANIN_SIM_AGGREGATE_INVALID: ${result?.status || '<null>'}`);
        }
        if (result.executor_status !== 'EXECUTADA') {
            throw new Error(`FANIN_SIM_EXECUTOR_STATUS_INVALID: ${result.executor_status}`);
        }
        if (Number(result.expected_accounts) !== targets.length) {
            throw new Error(
                `FANIN_SIM_EXPECTED_ACCOUNT_COUNT_INVALID: ${result.expected_accounts}`
            );
        }
        if (Number(result.success_accounts) !== targets.length) {
            throw new Error(
                `FANIN_SIM_SUCCESS_ACCOUNT_COUNT_INVALID: ${result.success_accounts}`
            );
        }

        console.log(
            `FANIN_SIM_COMPLETE status=${result.status} ` +
            `executor_status=${result.executor_status} ` +
            `success=${result.success_accounts}/${result.expected_accounts}`
        );
        console.log('FANIN_SIMULATION_SUCCESS=true');
    } finally {
        clearTimeout(timer);
        fanin.close();
        await Promise.allSettled([
            subscriber.isOpen ? subscriber.quit() : Promise.resolve(),
            publisher.isOpen ? publisher.quit() : Promise.resolve()
        ]);
        if (!finalResult) {
            console.log('FANIN_SIMULATION_SUCCESS=false');
        }
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error('FANIN_SIMULATION_HARNESS_FAILED:', error?.message || error);
        process.exitCode = 1;
    });
}

module.exports = {
    buildSyntheticOrderId,
    buildTargets,
    syntheticBetResult
};
