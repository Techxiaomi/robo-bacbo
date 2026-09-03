'use strict';

const crypto = require('crypto');
const { createClient } = require('redis');
const { obterMesaRuntime } = require('./mesa_runtime_context');
const { criarControleDiarioAutoTrader } = require('./bug051b_daily_counter');
const { criarBarreiraSaldoFrescoStops } = require('./bug051c_balance_barrier');
const { validarConfiguracaoAutoTrader } = require('./bug051d_config_validation');
const { parseScopedBalance, aggregateTraderBalance, maxAgeMs } = require('./continuous_trader_balance');
const { resolveRiskPolicy } = require('./risk_policy');

const INSTALL_MARK = Symbol.for('robo-bacbo.multi-account-financial-authorization');
const DEFAULT_REFRESH_TIMEOUT_MS = 12000;
const DEFAULT_REFRESH_POLL_MS = 100;

function multiAccountEnabled() {
    return String(process.env.AUTO_TRADER_MULTI_ACCOUNT_ROUTER_ENABLED || '').trim().toLowerCase() === 'true';
}

function redisUrl() {
    return String(process.env.REDIS_URL || 'redis://127.0.0.1:6379').trim()
        || 'redis://127.0.0.1:6379';
}

function positiveIntEnv(name, fallback, min = 1, max = 120000) {
    const raw = Number(process.env[name]);
    if (!Number.isFinite(raw)) return fallback;
    const value = Math.trunc(raw);
    return value >= min && value <= max ? value : fallback;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function avaliarTrailingStopTrader(trader, variacao) {
    const cf = trader?.config || {};
    const trailingAtivo = cf.trailing_stop === true;
    const recuoBruto = Number(cf.trailing_recuo);
    const lucroBruto = Number(variacao);
    const picoAnteriorBruto = Math.max(0, Number(trader?.trailing_pico_lucro) || 0);
    const picoAnterior = Math.round(picoAnteriorBruto * 100) / 100;

    if (!trailingAtivo || !Number.isFinite(recuoBruto) || recuoBruto <= 0 || !Number.isFinite(lucroBruto)) {
        return {
            acionado: false,
            pico_lucro: picoAnterior,
            limite_disparo: null,
            recuo: Number.isFinite(recuoBruto) && recuoBruto > 0
                ? Math.round(recuoBruto * 100) / 100
                : 0
        };
    }

    const recuo = Math.round(recuoBruto * 100) / 100;
    const lucroAtual = Math.round(lucroBruto * 100) / 100;
    const picoLucro = Math.max(picoAnterior, lucroAtual > 0 ? lucroAtual : 0);
    if (picoLucro <= 0) {
        return { acionado: false, pico_lucro: 0, limite_disparo: null, recuo };
    }

    const limiteDisparo = Math.round((picoLucro - recuo) * 100) / 100;
    return {
        acionado: lucroAtual <= limiteDisparo,
        pico_lucro: picoLucro,
        limite_disparo: limiteDisparo,
        recuo
    };
}

function avaliarLimitesFinanceirosTrader(trader, saldoAtual) {
    const saldoInicial = Number(trader?.saldo_inicial);
    const saldo = Number(saldoAtual);
    const picoAnterior = Math.max(0, Number(trader?.trailing_pico_lucro) || 0);

    if (!Number.isFinite(saldoInicial) || saldoInicial < 0 || !Number.isFinite(saldo) || saldo < 0) {
        return {
            permitido: false,
            motivo: 'SALDO_INDISPONIVEL',
            variacao: null,
            saldo_atual: Number.isFinite(saldo) ? saldo : null,
            trailing_pico_lucro: picoAnterior,
            trailing_limite_disparo: null,
            trailing_recuo: 0
        };
    }

    const riskPolicy = resolveRiskPolicy({ configJson: trader?.config });
    if (!riskPolicy.valid) {
        return {
            permitido: false,
            motivo: 'INVALID_RISK_POLICY',
            invalid_field: riskPolicy.field,
            variacao: null,
            saldo_atual: saldo,
            trailing_pico_lucro: picoAnterior,
            trailing_limite_disparo: null,
            trailing_recuo: 0
        };
    }

    const stopWin = riskPolicy.trader_limits.stop_win;
    const stopLoss = riskPolicy.trader_limits.stop_loss;
    const variacao = Math.round((saldo - saldoInicial) * 100) / 100;
    const trailing = avaliarTrailingStopTrader(trader, variacao);
    const base = {
        variacao,
        saldo_atual: saldo,
        trailing_pico_lucro: trailing.pico_lucro,
        trailing_limite_disparo: trailing.limite_disparo,
        trailing_recuo: trailing.recuo
    };

    if (variacao >= stopWin) {
        return { permitido: false, motivo: 'STOP_WIN', ...base };
    }
    if (variacao <= -stopLoss) {
        return { permitido: false, motivo: 'STOP_LOSS', ...base };
    }
    if (trailing.acionado) {
        return { permitido: false, motivo: 'TRAILING_STOP', ...base };
    }
    return { permitido: true, motivo: null, ...base };
}

class ScopedTraderBalanceAuthorization {
    constructor({ dbPool, tableKey, freshnessMs = maxAgeMs(), log = console }) {
        if (!dbPool || typeof dbPool.query !== 'function') throw new TypeError('MULTI_ACCOUNT_AUTH_DB_INVALID');
        this.dbPool = dbPool;
        this.tableKey = String(tableKey || '').trim().toLowerCase();
        this.freshnessMs = Number(freshnessMs);
        this.log = log;
        this.snapshots = new Map();
        this.subscriber = null;
        this.publisher = null;
        this.startPromise = null;
        this.refreshFlights = new Map();
        this.refreshTimeoutMs = positiveIntEnv('MULTI_ACCOUNT_BALANCE_REFRESH_TIMEOUT_MS', DEFAULT_REFRESH_TIMEOUT_MS, 1000, 60000);
        this.refreshPollMs = positiveIntEnv('MULTI_ACCOUNT_BALANCE_REFRESH_POLL_MS', DEFAULT_REFRESH_POLL_MS, 25, 1000);
        this.daily = criarControleDiarioAutoTrader({
            dbPool,
            timezone: process.env.AUTO_TRADER_TIMEZONE || process.env.TZ || 'America/Sao_Paulo'
        });
        this.balanceBarrier = criarBarreiraSaldoFrescoStops({ dbPool });
    }

    record(channel, message, now = Date.now()) {
        const snapshot = parseScopedBalance(channel, message, now);
        if (!snapshot || snapshot.table_key !== this.tableKey) return false;
        this.snapshots.set(snapshot.account_id, snapshot);
        return true;
    }

    snapshotForTrader(trader, now = Date.now()) {
        const aggregate = aggregateTraderBalance(trader, this.snapshots, {
            now,
            freshnessMs: this.freshnessMs
        });
        if (!aggregate.complete) {
            return Object.freeze({
                fresco: false,
                saldo_atual: null,
                motivo: aggregate.reason,
                account_ids: aggregate.account_ids || []
            });
        }
        const oldest = Math.min(...aggregate.accounts.map(item => Number(item.updated_at)));
        return Object.freeze({
            fresco: true,
            saldo_atual: aggregate.total,
            atualizado_em: oldest,
            motivo: null,
            account_ids: aggregate.account_ids
        });
    }

    async start() {
        if (this.subscriber?.isReady && this.publisher?.isReady) return true;
        if (this.startPromise) return this.startPromise;
        this.startPromise = (async () => {
            const subscriber = createClient({ url: redisUrl() });
            const publisher = createClient({ url: redisUrl() });
            subscriber.on('error', error => {
                this.log.error(`MULTI_ACCOUNT_AUTH_REDIS_ERROR: ${error?.message || error}`);
            });
            publisher.on('error', error => {
                this.log.error(`MULTI_ACCOUNT_AUTH_REDIS_PUBLISH_ERROR: ${error?.message || error}`);
            });
            await Promise.all([subscriber.connect(), publisher.connect()]);
            const pattern = `auto_trader_responses:*:${this.tableKey}`;
            await subscriber.pSubscribe(pattern, (message, channel) => {
                this.record(channel, message);
            });
            this.subscriber = subscriber;
            this.publisher = publisher;
            this.log.log(`MULTI_ACCOUNT_AUTH_BALANCE_READY=true table=${this.tableKey} pattern=${pattern}`);
            return true;
        })();
        try {
            return await this.startPromise;
        } finally {
            this.startPromise = null;
        }
    }

    async refreshTraderBalance(trader) {
        const traderId = Number(trader?.id);
        const initial = this.snapshotForTrader(trader);
        if (initial.fresco) return initial;
        if (!['MISSING_ACCOUNT_BALANCE', 'STALE_ACCOUNT_BALANCE'].includes(initial.motivo)) return initial;

        const accountIds = [...(initial.account_ids || [])];
        if (!Number.isSafeInteger(traderId) || traderId <= 0 || accountIds.length === 0) return initial;

        const flightKey = `${this.tableKey}:${traderId}`;
        const existing = this.refreshFlights.get(flightKey);
        if (existing) return existing;

        const flight = (async () => {
            await this.start();
            const requestId = crypto.randomUUID();
            this.log.log(
                `MULTI_ACCOUNT_AUTH_BALANCE_REFRESH_REQUESTED trader=${traderId} table=${this.tableKey} ` +
                `accounts=${accountIds.join(',')} reason=${initial.motivo}`
            );

            await Promise.all(accountIds.map(accountId => this.publisher.publish(
                `auto_trader_commands:${accountId}:${this.tableKey}`,
                JSON.stringify({ action: 'sync_balance', request_id: requestId })
            )));

            const deadline = Date.now() + this.refreshTimeoutMs;
            while (Date.now() <= deadline) {
                const refreshed = this.snapshotForTrader(trader);
                if (refreshed.fresco) {
                    this.log.log(
                        `MULTI_ACCOUNT_AUTH_BALANCE_REFRESHED trader=${traderId} table=${this.tableKey} ` +
                        `accounts=${refreshed.account_ids.join(',')} balance=${refreshed.saldo_atual.toFixed(2)}`
                    );
                    return refreshed;
                }
                await sleep(this.refreshPollMs);
            }

            const finalSnapshot = this.snapshotForTrader(trader);
            this.log.warn(
                `MULTI_ACCOUNT_AUTH_BALANCE_REFRESH_FAILED trader=${traderId} table=${this.tableKey} ` +
                `accounts=${accountIds.join(',')} reason=${finalSnapshot.motivo || 'TIMEOUT'}`
            );
            return finalSnapshot;
        })();

        this.refreshFlights.set(flightKey, flight);
        try {
            return await flight;
        } finally {
            if (this.refreshFlights.get(flightKey) === flight) this.refreshFlights.delete(flightKey);
        }
    }

    async autorizar(trader) {
        try {
            await this.start();
        } catch (error) {
            this.log.error(`MULTI_ACCOUNT_AUTH_REJECTED trader=${trader?.id || 'n/a'} reason=REDIS_NOT_READY ${error.message}`);
            return false;
        }

        const riskPolicy = resolveRiskPolicy({ configJson: trader?.config });
        if (!riskPolicy.valid) {
            this.log.error(
                `MULTI_ACCOUNT_AUTH_REJECTED trader=${trader?.id || 'n/a'} ` +
                `reason=INVALID_RISK_POLICY field=${riskPolicy.field}`
            );
            return false;
        }

        const validacaoConfig = validarConfiguracaoAutoTrader(trader?.config);
        if (!validacaoConfig.ok) {
            this.log.error(
                `MULTI_ACCOUNT_AUTH_REJECTED trader=${trader?.id || 'n/a'} reason=CONFIG_INVALID ${validacaoConfig.motivo}`
            );
            return false;
        }

        try {
            await this.daily.garantirDataOperacional(trader);
        } catch (error) {
            this.log.error(`MULTI_ACCOUNT_AUTH_REJECTED trader=${trader?.id || 'n/a'} reason=DAILY_COUNTER ${error.message}`);
            return false;
        }

        try {
            const causal = await this.balanceBarrier.garantirSaldoPosteriorUltimaLiquidacao(trader);
            if (!causal.permitido) {
                this.log.warn(`MULTI_ACCOUNT_AUTH_REJECTED trader=${trader?.id || 'n/a'} reason=POST_SETTLEMENT_BALANCE_UNCONFIRMED`);
                return false;
            }
        } catch (error) {
            this.log.error(`MULTI_ACCOUNT_AUTH_REJECTED trader=${trader?.id || 'n/a'} reason=POST_SETTLEMENT_BALANCE_ERROR ${error.message}`);
            return false;
        }

        let snapshot = this.snapshotForTrader(trader);
        if (!snapshot.fresco && ['MISSING_ACCOUNT_BALANCE', 'STALE_ACCOUNT_BALANCE'].includes(snapshot.motivo)) {
            try {
                snapshot = await this.refreshTraderBalance(trader);
            } catch (error) {
                this.log.error(
                    `MULTI_ACCOUNT_AUTH_BALANCE_REFRESH_ERROR trader=${trader?.id || 'n/a'} ` +
                    `reason=${error?.message || error}`
                );
                return false;
            }
        }
        if (!snapshot.fresco) {
            this.log.warn(
                `MULTI_ACCOUNT_AUTH_REJECTED trader=${trader?.id || 'n/a'} reason=${snapshot.motivo || 'BALANCE_UNAVAILABLE'} ` +
                `accounts=${(snapshot.account_ids || []).join(',') || '-'}`
            );
            return false;
        }

        const avaliacao = avaliarLimitesFinanceirosTrader(trader, snapshot.saldo_atual);
        if (avaliacao.motivo === 'SALDO_INDISPONIVEL') {
            this.log.warn(`MULTI_ACCOUNT_AUTH_REJECTED trader=${trader.id} reason=SALDO_INDISPONIVEL`);
            return false;
        }
        if (avaliacao.motivo === 'INVALID_RISK_POLICY') {
            this.log.error(
                `MULTI_ACCOUNT_AUTH_REJECTED trader=${trader.id} ` +
                `reason=INVALID_RISK_POLICY field=${avaliacao.invalid_field || 'unknown'}`
            );
            return false;
        }

        trader.saldo_atual = avaliacao.saldo_atual;
        const picoAnterior = Math.max(0, Number(trader.trailing_pico_lucro) || 0);
        const picoAvaliado = Math.max(0, Number(avaliacao.trailing_pico_lucro) || 0);
        if (picoAvaliado > picoAnterior) {
            try {
                const [result] = await this.dbPool.query(
                    'UPDATE auto_traders SET trailing_pico_lucro=? WHERE id=? AND mesa_id=? AND ativo=true',
                    [picoAvaliado, trader.id, trader.mesa_id]
                );
                if (Number(result?.affectedRows) !== 1) throw new Error('TRADER_NOT_ACTIVE');
                trader.trailing_pico_lucro = picoAvaliado;
            } catch (error) {
                this.log.error(`MULTI_ACCOUNT_AUTH_REJECTED trader=${trader.id} reason=TRAILING_PERSIST ${error.message}`);
                return false;
            }
        }

        if (avaliacao.permitido) {
            this.log.log(
                `MULTI_ACCOUNT_AUTH_APPROVED trader=${trader.id} accounts=${snapshot.account_ids.join(',')} ` +
                `balance=${snapshot.saldo_atual.toFixed(2)} variation=${avaliacao.variacao.toFixed(2)} ` +
                `trader_stop_loss=${riskPolicy.trader_limits.stop_loss.toFixed(2)} ` +
                `trader_stop_win=${riskPolicy.trader_limits.stop_win.toFixed(2)}`
            );
            return true;
        }

        trader.ativo = false;
        trader.status_operacao = avaliacao.motivo;
        try {
            await this.dbPool.query(
                'UPDATE auto_traders SET ativo=false, status_operacao=?, saldo_atual=? WHERE id=? AND mesa_id=?',
                [avaliacao.motivo, trader.saldo_atual, trader.id, trader.mesa_id]
            );
        } catch (error) {
            this.log.error(`MULTI_ACCOUNT_AUTH_STOP_PERSIST_FAILED trader=${trader.id} reason=${avaliacao.motivo}: ${error.message}`);
        }
        this.log.warn(
            `MULTI_ACCOUNT_AUTH_REJECTED trader=${trader.id} reason=${avaliacao.motivo} ` +
            `balance=${trader.saldo_atual.toFixed(2)} variation=${Number(avaliacao.variacao || 0).toFixed(2)}`
        );
        return false;
    }
}

let installed = false;
let authorization = null;

async function installMultiAccountFinancialAuthorization() {
    if (installed) return authorization;
    if (!multiAccountEnabled()) return null;

    const arbiter = require('./auto_trader_round_arbiter');
    if (arbiter[INSTALL_MARK]) return authorization;
    const originalCreate = arbiter.criarArbitroFinanceiroAutoTrader;
    if (typeof originalCreate !== 'function') throw new Error('MULTI_ACCOUNT_AUTH_ARBITER_FACTORY_UNAVAILABLE');

    const runtime = obterMesaRuntime();
    const tableKey = String(runtime?.codigo || '').trim().toLowerCase();

    arbiter.criarArbitroFinanceiroAutoTrader = function createWithScopedAuthorization(deps = {}) {
        authorization = new ScopedTraderBalanceAuthorization({
            dbPool: deps.dbPool,
            tableKey,
            freshnessMs: maxAgeMs(),
            log: deps.log || console
        });
        void authorization.start().catch(error => {
            (deps.log || console).error(`MULTI_ACCOUNT_AUTH_START_FAILED: ${error?.message || error}`);
        });
        return originalCreate({
            ...deps,
            autorizarNovaEntradaFinanceiraTrader: trader => authorization.autorizar(trader)
        });
    };

    Object.defineProperty(arbiter, INSTALL_MARK, {
        value: true,
        enumerable: false,
        configurable: false,
        writable: false
    });
    installed = true;
    console.log(`MULTI_ACCOUNT_FINANCIAL_AUTHORIZATION_INSTALLED=true table=${tableKey}`);
    return authorization;
}

module.exports = {
    multiAccountEnabled,
    avaliarTrailingStopTrader,
    avaliarLimitesFinanceirosTrader,
    ScopedTraderBalanceAuthorization,
    installMultiAccountFinancialAuthorization
};
