'use strict';

function calcularFichaSegura(valorDesejado) {
    const valor = Number(valorDesejado);
    if (!Number.isFinite(valor) || valor <= 0) return 0;

    let arredondado = Math.round(valor / 5) * 5;
    if (arredondado === 0) arredondado = 5;
    return arredondado;
}

function normalizarModoProtecao(config = {}) {
    const modo = String(config.tie_stake_mode || '').trim().toUpperCase();
    return modo === 'VALOR' || modo === 'PERCENTUAL' ? modo : '';
}

function validarPoliticaProtecao(config = {}) {
    const modo = normalizarModoProtecao(config);
    if (!modo) return { ok: false, motivo: 'Modo de proteção no empate não configurado' };

    if (modo === 'PERCENTUAL') {
        const percentual = Number(config.tie_stake_percent);
        if (!Number.isFinite(percentual) || percentual <= 0 || percentual > 100) {
            return { ok: false, motivo: 'Percentual de proteção no empate deve ser maior que 0 e até 100%' };
        }
        return { ok: true, modo, valor_base: percentual };
    }

    const valor = Number(config.tie_stake_value);
    if (!Number.isFinite(valor) || valor <= 0) {
        return { ok: false, motivo: 'Valor de proteção no empate deve ser maior que zero' };
    }
    return { ok: true, modo, valor_base: valor };
}

function multiplicadorNivel(config = {}, nivel = 0) {
    if (Number(nivel) === 1) {
        const mult = Number(config.gale_1_mult);
        return Number.isFinite(mult) && mult > 0 ? mult : 2;
    }
    if (Number(nivel) === 2) {
        const mult = Number(config.gale_2_mult);
        return Number.isFinite(mult) && mult > 0 ? mult : 4;
    }
    return 1;
}

function alvoExecutor(entrada) {
    if (entrada === 'Player') return 'PlayerWon';
    if (entrada === 'Banker') return 'BankerWon';
    if (entrada === 'Tie') return 'Tie';
    return '';
}

function calcularPlanoAposta(config = {}, estrategia = {}, nivel = 0) {
    const alvo = alvoExecutor(estrategia.entrada);
    if (!alvo) return { ok: false, motivo: 'Alvo principal inválido' };

    const mult = multiplicadorNivel(config, nivel);
    const stakeBase = Number(config.stake_inicial);
    const valorPrincipal = calcularFichaSegura(stakeBase * mult);
    if (valorPrincipal <= 0) return { ok: false, motivo: 'Stake principal inválida' };

    const protegerEmpate = estrategia.protegerEmpate === true
        || estrategia.proteger_empate === true
        || Number(estrategia.proteger_empate) === 1;

    let valorEmpate = 0;
    if (protegerEmpate && estrategia.entrada !== 'Tie') {
        const politica = validarPoliticaProtecao(config);
        if (!politica.ok) return politica;

        const tieBaseBruto = politica.modo === 'PERCENTUAL'
            ? stakeBase * (Number(config.tie_stake_percent) / 100)
            : Number(config.tie_stake_value);

        valorEmpate = calcularFichaSegura(tieBaseBruto * mult);
        if (valorEmpate <= 0) {
            return { ok: false, motivo: 'Proteção no empate não pode ser representada pelas fichas disponíveis' };
        }
    }

    const apostas = [{ alvo, valor: valorPrincipal }];
    if (valorEmpate > 0) apostas.push({ alvo: 'Tie', valor: valorEmpate });

    return {
        ok: true,
        nivel: Number(nivel) || 0,
        multiplicador: mult,
        valor_principal: valorPrincipal,
        valor_empate: valorEmpate,
        exposicao_etapa: valorPrincipal + valorEmpate,
        apostas
    };
}

function extrairRazaoEmpate(valor) {
    const texto = String(valor || '').trim();
    const match = texto.match(/(\d+(?:[.,]\d+)?)/);
    if (!match) return 0;
    const numero = Number(match[1].replace(',', '.'));
    return Number.isFinite(numero) && numero > 0 ? numero : 0;
}

function calcularPnLEtapa({ resultado, alvoPrincipal, valorPrincipal, valorEmpate = 0, multiplicadorEmpate = '' }) {
    const principal = Math.max(0, Number(valorPrincipal) || 0);
    const empate = Math.max(0, Number(valorEmpate) || 0);
    const vencedor = String(resultado || '');
    const alvo = String(alvoPrincipal || '');

    if (principal <= 0) return 0;

    if (alvo === 'Tie') {
        if (vencedor !== 'Tie') return -principal;
        const razao = extrairRazaoEmpate(multiplicadorEmpate);
        return razao > 0 ? principal * razao : 0;
    }

    if (vencedor === alvo) {
        return principal - empate;
    }

    if (vencedor === 'Tie') {
        const razao = extrairRazaoEmpate(multiplicadorEmpate);
        return (empate * razao) - (principal * 0.10);
    }

    return -(principal + empate);
}

module.exports = {
    calcularFichaSegura,
    normalizarModoProtecao,
    validarPoliticaProtecao,
    multiplicadorNivel,
    alvoExecutor,
    calcularPlanoAposta,
    extrairRazaoEmpate,
    calcularPnLEtapa
};
