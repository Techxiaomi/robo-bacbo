'use strict';

const fs = require('fs');
const path = require('path');
const { getTechnicalRiskCaps } = require('./technical_risk_caps');
const { resolveRiskPolicy } = require('./risk_policy');

function readDryRunLauncherState(projectRoot) {
    const relativeSource = path.join('atalhos', '07_SIGNAL_ROUTER.cmd');
    const launcherPath = path.join(projectRoot, relativeSource);

    try {
        const source = fs.readFileSync(launcherPath, 'utf8');
        const match = source.match(/set\s+"SIGNAL_ROUTER_FINANCIAL_DRY_RUN=(true|false)"/i);
        if (!match) {
            return Object.freeze({
                configured: false,
                dry_run: null,
                source: relativeSource,
                reason: 'DRY_RUN_SETTING_NOT_FOUND'
            });
        }
        return Object.freeze({
            configured: true,
            dry_run: String(match[1]).toLowerCase() === 'true',
            source: relativeSource,
            reason: null
        });
    } catch (error) {
        return Object.freeze({
            configured: false,
            dry_run: null,
            source: relativeSource,
            reason: `DRY_RUN_LAUNCHER_UNREADABLE:${error?.code || 'ERROR'}`
        });
    }
}

function mapTraderRiskPolicy(row) {
    const traderId = Number(row?.id);
    const policy = resolveRiskPolicy({ configJson: row?.config_json });

    if (!policy.valid) {
        return Object.freeze({
            trader_id: Number.isSafeInteger(traderId) ? traderId : null,
            trader_name: String(row?.nome || '').trim() || `Trader ${traderId || '?'}`,
            status_operacao: String(row?.status_operacao || '').trim() || null,
            valid: false,
            code: 'INVALID_RISK_POLICY',
            invalid_field: policy.field || null,
            stop_loss: null,
            stop_win: null,
            source: 'auto_traders.config_json'
        });
    }

    return Object.freeze({
        trader_id: traderId,
        trader_name: String(row?.nome || '').trim() || `Trader ${traderId}`,
        status_operacao: String(row?.status_operacao || '').trim() || null,
        valid: true,
        code: 'RISK_POLICY_VALID',
        invalid_field: null,
        stop_loss: policy.trader_limits.stop_loss,
        stop_win: policy.trader_limits.stop_win,
        source: 'auto_traders.config_json'
    });
}

async function readRiskPolicyObservability({ dbPool, projectRoot }) {
    if (!dbPool || typeof dbPool.query !== 'function') {
        throw new TypeError('RISK_POLICY_OBSERVABILITY_DB_INVALID');
    }

    const caps = getTechnicalRiskCaps();
    const dryRun = readDryRunLauncherState(projectRoot);
    const [rows] = await dbPool.query(
        `SELECT id, nome, config_json, status_operacao
         FROM auto_traders
         WHERE ativo=true
         ORDER BY id`
    );
    const traders = Object.freeze((Array.isArray(rows) ? rows : []).map(mapTraderRiskPolicy));
    const invalidTraderPolicy = traders.some(item => item.valid !== true);
    const dryRunLocked = dryRun.configured === true && dryRun.dry_run === true;

    return Object.freeze({
        ok: dryRunLocked && !invalidTraderPolicy,
        fail_closed: !dryRunLocked || invalidTraderPolicy,
        business_policy: Object.freeze({
            source: 'auto_traders.config_json',
            active_traders: traders
        }),
        technical_caps: Object.freeze({
            global_router_cap: caps.global_router_cap,
            per_bridge_cap: caps.per_bridge_cap,
            source: 'robo-bacbo/technical_risk_caps.js'
        }),
        financial_mode: Object.freeze({
            dry_run: dryRun.dry_run,
            configured: dryRun.configured,
            source: dryRun.source,
            reason: dryRun.reason,
            real_dispatch_blocked: dryRunLocked
        })
    });
}

module.exports = {
    readDryRunLauncherState,
    mapTraderRiskPolicy,
    readRiskPolicyObservability
};
