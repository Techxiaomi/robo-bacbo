'use strict';

const CHECKS_OBRIGATORIOS = Object.freeze([
    'HOME_OPEN',
    'PUBLIC_BARRIERS_CLEARED',
    'LOGIN_FORM_FOUND',
    'LOGIN_CONFIRMED',
    'GAME_ROUTE_OPENED',
    'PLAY_CLICKED',
    'EVOLUTION_FRAME_FOUND',
    'BACBO_DOM_READY',
    'OVERLAYS_CLEARED',
    'BALANCE_READ'
]);

function normalizarChecks(valor) {
    if (!Array.isArray(valor)) {
        return [];
    }

    return valor.map(item => ({
        codigo: String(item?.codigo || '').trim().toUpperCase(),
        ok: item?.ok === true,
        detalhe: String(item?.detalhe || '').trim().slice(0, 300)
    }));
}

function validarRelatorioTesteConta(relatorio = {}) {
    const checks = normalizarChecks(relatorio.checks);
    const porCodigo = new Map(
        checks.map(item => [item.codigo, item])
    );
    const ausentes = [];
    const falhos = [];

    for (const codigo of CHECKS_OBRIGATORIOS) {
        const item = porCodigo.get(codigo);

        if (!item) {
            ausentes.push(codigo);
        } else if (item.ok !== true) {
            falhos.push(codigo);
        }
    }

    const saldoBruto = relatorio.saldo;
    const saldo = Number(saldoBruto);
    const saldoValido =
        saldoBruto !== null
        && saldoBruto !== undefined
        && saldoBruto !== ''
        && typeof saldoBruto !== 'boolean'
        && Number.isFinite(saldo)
        && saldo >= 0;

    if (!saldoValido && !falhos.includes('BALANCE_READ')) {
        falhos.push('BALANCE_READ');
    }

    const cliqueFinanceiro =
        relatorio.financial_clicks_executed === true
        || relatorio.bet_executed === true;

    if (cliqueFinanceiro) {
        falhos.push('FINANCIAL_ACTION_FORBIDDEN');
    }

    const ok =
        ausentes.length === 0
        && falhos.length === 0;

    return {
        ok,
        codigo: ok ? null : 'TESTE_CONTA_INCOMPLETO',
        checks,
        ausentes,
        falhos,
        saldo: saldoValido ? saldo : null,
        financial_clicks_executed: false,
        bet_executed: false
    };
}

module.exports = {
    CHECKS_OBRIGATORIOS,
    validarRelatorioTesteConta
};
