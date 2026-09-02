'use strict';

const { accountIdsFromConfig, normalizeAccountIds } = require('./trader_bound_tasks');
const { evaluateAggregateExposure } = require('./signal_router_risk_gate');
const { readSystemConfig } = require('./system_config_service');

function freezeScope(value) {
    return Object.freeze({
        trader_id: Number(value.trader_id),
        table_key: String(value.table_key || '').trim().toLowerCase(),
        account_ids: Object.freeze(normalizeAccountIds(value.account_ids)),
        risk: value.risk ? Object.freeze({ ...value.risk }) : null
    });
}

function filterTargetsByAccountIds(targets, accountIds) {
    const allowed = new Set(normalizeAccountIds(accountIds));
    return (Array.isArray(targets) ? targets : [])
        .filter(target => allowed.has(Number(target?.account_id)))
        .slice()
        .sort((a, b) => Number(a.account_id) - Number(b.account_id));
}

class FinancialTraderScopeResolver {
    constructor({ dbPool, log = console }) {
        if (!dbPool || typeof dbPool.query !== 'function') throw new TypeError('SIGNAL_ROUTER_TRADER_SCOPE_DB_INVALID');
        this.dbPool = dbPool;
        this.log = log;
    }

    async resolve(signal) {
        if (!signal || signal.action !== 'place_bet') throw new Error('SIGNAL_ROUTER_TRADER_SCOPE_FINANCIAL_SIGNAL_REQUIRED');
        const signalId = String(signal.signal_id || '').trim().toLowerCase();
        const tableKey = String(signal.table_key || '').trim().toLowerCase();
        if (!signalId || !tableKey) throw new Error('SIGNAL_ROUTER_TRADER_SCOPE_SIGNAL_INVALID');

        const [rows] = await this.dbPool.query(
            `SELECT ao.trader_id, at.config_json, at.saldo_inicial, at.saldo_atual,
                    at.ativo, at.status_operacao, LOWER(m.codigo) AS table_key
             FROM auditoria_ordens ao
             INNER JOIN auto_traders at ON at.id = ao.trader_id AND at.mesa_id = ao.mesa_id
             INNER JOIN mesas m ON m.id = ao.mesa_id AND m.ativo = true
             WHERE LOWER(ao.executor_order_id) = ? AND LOWER(m.codigo) = ?
             ORDER BY ao.id DESC LIMIT 2`,
            [signalId, tableKey]
        );
        if (!Array.isArray(rows) || rows.length !== 1) throw new Error('SIGNAL_ROUTER_TRADER_SCOPE_ORDER_NOT_UNIQUE');

        const row = rows[0];
        const traderId = Number(row.trader_id);
        const resolvedTable = String(row.table_key || '').trim().toLowerCase();
        const active = row.ativo === true || row.ativo === 1;
        const status = String(row.status_operacao || '').trim().toUpperCase();
        if (!Number.isSafeInteger(traderId) || traderId <= 0) throw new Error('SIGNAL_ROUTER_TRADER_SCOPE_TRADER_INVALID');
        if (resolvedTable !== tableKey) throw new Error('SIGNAL_ROUTER_TRADER_SCOPE_TABLE_MISMATCH');
        if (!active || status !== 'OPERANDO') throw new Error('SIGNAL_ROUTER_TRADER_SCOPE_TRADER_NOT_OPERATING');

        let accountIds = accountIdsFromConfig(row.config_json);
        if (accountIds.length === 0) {
            const [bindings] = await this.dbPool.query(
                `SELECT betting_house_id AS account_id FROM auto_trader_account_bindings
                 WHERE auto_trader_id = ? ORDER BY betting_house_id`,
                [traderId]
            );
            accountIds = normalizeAccountIds((bindings || []).map(item => item.account_id));
        }
        if (accountIds.length === 0) throw new Error('SIGNAL_ROUTER_TRADER_SCOPE_NO_ACCOUNTS');

        const placeholders = accountIds.map(() => '?').join(',');
        const [eligibleRows] = await this.dbPool.query(
            `SELECT h.id AS account_id
             FROM betting_houses h
             INNER JOIN betting_house_tables ht ON ht.betting_house_id = h.id AND ht.enabled = true
             WHERE h.enabled = true AND h.id IN (${placeholders}) AND LOWER(ht.table_key) = ?
             ORDER BY h.id`,
            [...accountIds, tableKey]
        );
        const eligibleAccountIds = normalizeAccountIds((eligibleRows || []).map(item => item.account_id));
        const systemConfig = await readSystemConfig({ dbPool: this.dbPool });
        const technicalCaps = {
            global_router_cap: systemConfig.global_router_cap,
            per_bridge_cap: systemConfig.per_bridge_cap
        };

        const risk = evaluateAggregateExposure({
            perAccountExposure: Number(signal.exposure_cents) / 100,
            eligibleAccountIds,
            saldoInicial: row.saldo_inicial,
            saldoAtual: row.saldo_atual,
            configJson: row.config_json,
            technicalCaps
        });

        const limits = risk.trader_limits || {};
        const caps = risk.technical_caps || {};
        this.log.log(
            `RISK_POLICY_HIERARCHY trader=${traderId} table=${tableKey} approved=${risk.approved === true} ` +
            `reason=${risk.reason || 'APPROVED'} trader_stop_loss=${Number.isFinite(Number(limits.stop_loss)) ? Number(limits.stop_loss).toFixed(2) : 'n/a'} ` +
            `trader_stop_win=${Number.isFinite(Number(limits.stop_win)) ? Number(limits.stop_win).toFixed(2) : 'n/a'} ` +
            `technical_global_cap=${Number.isFinite(Number(caps.global_exposure)) ? Number(caps.global_exposure).toFixed(2) : 'n/a'} ` +
            `technical_bridge_cap=${Number.isFinite(Number(caps.per_bridge_exposure)) ? Number(caps.per_bridge_exposure).toFixed(2) : 'n/a'} ` +
            `config_source=${systemConfig.source} per_account_exposure=${Number.isFinite(Number(risk.per_account_exposure)) ? Number(risk.per_account_exposure).toFixed(2) : 'n/a'} ` +
            `aggregate_exposure=${Number.isFinite(Number(risk.aggregate_exposure)) ? Number(risk.aggregate_exposure).toFixed(2) : 'n/a'} ` +
            `saldo_atual=${Number.isFinite(Number(risk.saldo_atual)) ? Number(risk.saldo_atual).toFixed(2) : 'n/a'}`
        );

        if (!risk.approved) {
            throw new Error(`EXPOSURE_REJECTED reason=${risk.reason} trader=${traderId} aggregate=${Number(risk.aggregate_exposure || 0).toFixed(2)}`);
        }

        return freezeScope({ trader_id: traderId, table_key: tableKey, account_ids: eligibleAccountIds, risk });
    }
}

module.exports = { filterTargetsByAccountIds, FinancialTraderScopeResolver };
