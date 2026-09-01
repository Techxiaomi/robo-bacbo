'use strict';

const TERMINAL_STATUSES = new Set(['EXECUTADA', 'FALHOU', 'EXPIRADA', 'AMBIGUA']);

function normalizeTerminalStatus(value) {
    const status = String(value || '').trim().toUpperCase();
    return TERMINAL_STATUSES.has(status) ? status : '';
}

function aggregateStatus(results) {
    const items = Array.isArray(results) ? results : [];
    const success = items.filter(item => item.status === 'EXECUTADA').length;
    if (items.length > 0 && success === items.length) return 'FULL_SUCCESS';
    if (success > 0) return 'PARTIAL_SUCCESS';
    return 'FAILED';
}

function executorStatusForAggregate(results, aggregate) {
    if (aggregate === 'FULL_SUCCESS') return 'EXECUTADA';
    if (aggregate === 'PARTIAL_SUCCESS') return 'AMBIGUA';

    const statuses = new Set((Array.isArray(results) ? results : []).map(item => item.status));
    if (statuses.has('AMBIGUA') || statuses.has('TIMEOUT')) return 'AMBIGUA';
    if (statuses.size === 1 && statuses.has('EXPIRADA')) return 'EXPIRADA';
    return 'FALHOU';
}

function representativeConfirmation(results) {
    const successful = (Array.isArray(results) ? results : [])
        .filter(item => item.status === 'EXECUTADA' && item.confirmacao && typeof item.confirmacao === 'object')
        .sort((a, b) => a.account_id - b.account_id);
    if (successful.length === 0) return null;

    const representative = successful[0];
    const confirmations = successful.map(item => item.confirmacao);
    const sum = field => confirmations.reduce((total, item) => {
        const value = Number(item?.[field]);
        return total + (Number.isFinite(value) ? value : 0);
    }, 0);

    return {
        ...representative.confirmacao,
        metodo: 'MULTI_ACCOUNT_FANIN',
        conta_representativa: representative.account_id,
        multi_account: {
            contas_sucesso: successful.length,
            saldo_antes_total: Number(sum('saldo_antes').toFixed(2)),
            saldo_depois_total: Number(sum('saldo_depois').toFixed(2)),
            debito_observado_total: Number(sum('debito_observado').toFixed(2)),
            exposicao_esperada_total: Number(sum('exposicao_esperada').toFixed(2))
        }
    };
}

class ResultFanIn {
    constructor({ publish, timeoutMs = 210000, now = () => Date.now() } = {}) {
        if (typeof publish !== 'function') throw new TypeError('SIGNAL_FANIN_PUBLISH_REQUIRED');
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000) {
            throw new TypeError('SIGNAL_FANIN_TIMEOUT_INVALID');
        }
        this.publish = publish;
        this.timeoutMs = timeoutMs;
        this.now = now;
        this.bySignal = new Map();
        this.byOrderId = new Map();
    }

    register({ signalId, tableKey, targets }) {
        const id = String(signalId || '').trim();
        const table = String(tableKey || '').trim();
        const items = Array.isArray(targets) ? targets : [];
        if (!id || !table || items.length === 0) throw new Error('SIGNAL_FANIN_EXPECTATION_INVALID');
        if (this.bySignal.has(id)) throw new Error(`SIGNAL_FANIN_EXPECTATION_EXISTS: ${id}`);

        const accounts = new Map();
        for (const item of items) {
            const accountId = Number(item.account_id);
            const orderId = String(item.order_id || '').trim().toLowerCase();
            const responseChannel = String(item.response_channel || '').trim();
            if (!Number.isSafeInteger(accountId) || accountId <= 0 || !orderId || !responseChannel) {
                throw new Error('SIGNAL_FANIN_TARGET_INVALID');
            }
            if (accounts.has(accountId) || this.byOrderId.has(orderId)) {
                throw new Error('SIGNAL_FANIN_TARGET_COLLISION');
            }
            const account = {
                account_id: accountId,
                session_id: String(item.session_id || ''),
                order_id: orderId,
                response_channel: responseChannel,
                status: 'PENDING',
                motivo: '',
                confirmacao: null,
                completed_at: null
            };
            accounts.set(accountId, account);
            this.byOrderId.set(orderId, { signal_id: id, account_id: accountId });
        }

        const expectation = {
            signal_id: id,
            table_key: table,
            created_at: this.now(),
            accounts,
            timer: null,
            finalized: false
        };
        expectation.timer = setTimeout(() => {
            void this.expire(id).catch(error => {
                console.error(`SIGNAL_FANIN_TIMEOUT_FINALIZE_FAILED signal=${id}: ${error?.message || error}`);
            });
        }, this.timeoutMs);
        expectation.timer.unref?.();
        this.bySignal.set(id, expectation);
        return expectation;
    }

    async accept(channel, payload) {
        const data = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
        if (!data || String(data.action || '').trim() !== 'bet_result') return false;
        const orderId = String(data.order_id || '').trim().toLowerCase();
        const status = normalizeTerminalStatus(data.status);
        if (!orderId || !status) return false;

        const lookup = this.byOrderId.get(orderId);
        if (!lookup) return false;
        const expectation = this.bySignal.get(lookup.signal_id);
        if (!expectation || expectation.finalized) return false;
        const account = expectation.accounts.get(lookup.account_id);
        if (!account || account.status !== 'PENDING') return false;
        if (String(channel || '') !== account.response_channel) return false;

        account.status = status;
        account.motivo = String(data.motivo || '').slice(0, 300);
        account.confirmacao = data.confirmacao && typeof data.confirmacao === 'object' ? data.confirmacao : null;
        account.completed_at = this.now();
        return this._finalizeIfComplete(expectation);
    }

    async markDispatchFailure(orderId, reason) {
        const id = String(orderId || '').trim().toLowerCase();
        const lookup = this.byOrderId.get(id);
        if (!lookup) return false;
        const expectation = this.bySignal.get(lookup.signal_id);
        if (!expectation || expectation.finalized) return false;
        const account = expectation.accounts.get(lookup.account_id);
        if (!account || account.status !== 'PENDING') return false;
        account.status = 'FALHOU';
        account.motivo = String(reason || 'DISPATCH_FAILED').slice(0, 300);
        account.completed_at = this.now();
        return this._finalizeIfComplete(expectation);
    }

    async expire(signalId) {
        const expectation = this.bySignal.get(String(signalId || '').trim());
        if (!expectation || expectation.finalized) return false;
        for (const account of expectation.accounts.values()) {
            if (account.status === 'PENDING') {
                account.status = 'TIMEOUT';
                account.motivo = 'SIGNAL_FANIN_RESULT_TIMEOUT';
                account.completed_at = this.now();
            }
        }
        return this._finalize(expectation);
    }

    async _finalizeIfComplete(expectation) {
        const pending = Array.from(expectation.accounts.values()).some(item => item.status === 'PENDING');
        if (pending) return true;
        return this._finalize(expectation);
    }

    async _finalize(expectation) {
        if (expectation.finalized) return false;
        expectation.finalized = true;
        if (expectation.timer) clearTimeout(expectation.timer);

        const accounts = Array.from(expectation.accounts.values())
            .sort((a, b) => a.account_id - b.account_id)
            .map(item => ({
                account_id: item.account_id,
                session_id: item.session_id,
                order_id: item.order_id,
                status: item.status,
                motivo: item.motivo,
                confirmacao: item.confirmacao
            }));
        const aggregate = aggregateStatus(accounts);
        const success = accounts.filter(item => item.status === 'EXECUTADA').length;
        const consolidated = {
            action: 'multi_account_bet_result',
            signal_id: expectation.signal_id,
            order_id: expectation.signal_id,
            table_key: expectation.table_key,
            status: aggregate,
            executor_status: executorStatusForAggregate(accounts, aggregate),
            expected_accounts: accounts.length,
            success_accounts: success,
            failed_accounts: accounts.length - success,
            accounts,
            confirmacao: aggregate === 'FULL_SUCCESS' ? representativeConfirmation(accounts) : null,
            completed_at: this.now()
        };

        for (const account of accounts) this.byOrderId.delete(account.order_id);
        this.bySignal.delete(expectation.signal_id);
        await this.publish(consolidated);
        return consolidated;
    }

    close() {
        for (const expectation of this.bySignal.values()) {
            if (expectation.timer) clearTimeout(expectation.timer);
        }
        this.bySignal.clear();
        this.byOrderId.clear();
    }
}

module.exports = {
    TERMINAL_STATUSES,
    aggregateStatus,
    executorStatusForAggregate,
    representativeConfirmation,
    ResultFanIn
};
