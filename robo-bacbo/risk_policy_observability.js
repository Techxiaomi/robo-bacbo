'use strict';

const { resolveRiskPolicy } = require('./risk_policy');
const { readSystemConfig } = require('./system_config_service');

function mapTraderRiskPolicy(row, technicalCaps) {
    const traderId = Number(row?.id);
    const policy = resolveRiskPolicy({ configJson: row?.config_json, technicalCaps });
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

async function readRiskPolicyObservability({ dbPool }) {
    if (!dbPool || typeof dbPool.query !== 'function') throw new TypeError('RISK_POLICY_OBSERVABILITY_DB_INVALID');
    const systemConfig = await readSystemConfig({ dbPool });
    const technicalCaps = {
        global_router_cap: systemConfig.global_router_cap,
        per_bridge_cap: systemConfig.per_bridge_cap
    };
    const [rows] = await dbPool.query(
        `SELECT id, nome, config_json, status_operacao
         FROM auto_traders WHERE ativo=true ORDER BY id`
    );
    const traders = Object.freeze((Array.isArray(rows) ? rows : []).map(row => mapTraderRiskPolicy(row, technicalCaps)));
    const invalidTraderPolicy = traders.some(item => item.valid !== true);

    return Object.freeze({
        ok: systemConfig.financial_dry_run === true && !invalidTraderPolicy,
        fail_closed: systemConfig.fail_closed === true || invalidTraderPolicy,
        business_policy: Object.freeze({ source: 'auto_traders.config_json', active_traders: traders }),
        technical_caps: Object.freeze({
            global_router_cap: systemConfig.global_router_cap,
            per_bridge_cap: systemConfig.per_bridge_cap,
            source: systemConfig.source === 'system_configs' ? 'system_configs' : 'safe-defaults'
        }),
        financial_mode: Object.freeze({
            dry_run: true,
            configured: true,
            source: systemConfig.source === 'system_configs' ? 'system_configs.financial_dry_run' : 'safe-defaults',
            reason: systemConfig.reason,
            real_dispatch_blocked: true,
            immutable: true
        })
    });
}

module.exports = { mapTraderRiskPolicy, readRiskPolicyObservability };
