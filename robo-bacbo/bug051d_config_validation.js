'use strict';

const { validarFaixasHorarioConfiguracao } = require('./auto_trader_schedule');

const LIMITE_DECIMAL_DINHEIRO = 9_999_999_999.99;
const LIMITE_MULTIPLICADOR_GALE = 1000;
const LIMITE_PULOS = 1000;

function falha(campo, motivo) {
    return { ok: false, campo, motivo: `${campo}: ${motivo}` };
}

function numeroEstrito(valor) {
    return typeof valor === 'number' && Number.isFinite(valor);
}

function inteiroEstrito(valor) {
    return numeroEstrito(valor) && Number.isInteger(valor);
}

function multiploDeCinco(valor) {
    return numeroEstrito(valor)
        && Math.abs((valor / 5) - Math.round(valor / 5)) < 1e-9;
}

function validarConfiguracaoAutoTrader(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        return falha('config', 'deve ser um objeto JSON');
    }

    const stake = config.stake_inicial;
    if (
        !numeroEstrito(stake)
        || stake < 5
        || stake > LIMITE_DECIMAL_DINHEIRO
        || !multiploDeCinco(stake)
    ) {
        return falha(
            'stake_inicial',
            'deve ser número entre R$ 5,00 e o limite financeiro, em múltiplos exatos de R$ 5,00'
        );
    }

    const gale1 = config.gale_1_mult;
    const gale2 = config.gale_2_mult;
    if (!numeroEstrito(gale1) || gale1 < 1 || gale1 > LIMITE_MULTIPLICADOR_GALE) {
        return falha('gale_1_mult', 'deve ser número entre 1 e 1000');
    }
    if (!numeroEstrito(gale2) || gale2 < 1 || gale2 > LIMITE_MULTIPLICADOR_GALE) {
        return falha('gale_2_mult', 'deve ser número entre 1 e 1000');
    }
    if (gale2 < gale1) {
        return falha('gale_2_mult', 'não pode ser menor que gale_1_mult');
    }
    if ((stake * gale2) > LIMITE_DECIMAL_DINHEIRO) {
        return falha(
            'gale_2_mult',
            'com a stake configurada ultrapassa o limite financeiro representável'
        );
    }

    if (config.tie_stake_mode !== 'PERCENTUAL' && config.tie_stake_mode !== 'VALOR') {
        return falha('tie_stake_mode', 'deve ser PERCENTUAL ou VALOR');
    }
    if (config.tie_stake_mode === 'PERCENTUAL') {
        const percentual = config.tie_stake_percent;
        if (!numeroEstrito(percentual) || percentual <= 0 || percentual > 100) {
            return falha(
                'tie_stake_percent',
                'deve ser número maior que 0 e menor ou igual a 100'
            );
        }
    } else {
        const valorTie = config.tie_stake_value;
        if (
            !numeroEstrito(valorTie)
            || valorTie < 5
            || valorTie > LIMITE_DECIMAL_DINHEIRO
            || !multiploDeCinco(valorTie)
        ) {
            return falha(
                'tie_stake_value',
                'deve ser número entre R$ 5,00 e o limite financeiro, em múltiplos exatos de R$ 5,00'
            );
        }
        if ((valorTie * gale2) > LIMITE_DECIMAL_DINHEIRO) {
            return falha(
                'tie_stake_value',
                'com gale_2_mult ultrapassa o limite financeiro representável'
            );
        }
    }

    if (config.modo_camuflagem !== 'TODAS' && config.modo_camuflagem !== 'PULOS') {
        return falha('modo_camuflagem', 'deve ser TODAS ou PULOS');
    }
    if (config.modo_camuflagem === 'PULOS') {
        const minimo = config.camuflagem_pulos_min;
        const maximo = config.camuflagem_pulos_max;
        if (!inteiroEstrito(minimo) || minimo < 1 || minimo > LIMITE_PULOS) {
            return falha('camuflagem_pulos_min', 'deve ser inteiro entre 1 e 1000');
        }
        if (!inteiroEstrito(maximo) || maximo < minimo || maximo > LIMITE_PULOS) {
            return falha(
                'camuflagem_pulos_max',
                'deve ser inteiro maior ou igual ao mínimo e menor ou igual a 1000'
            );
        }
    }

    if (!inteiroEstrito(config.limite_entradas) || config.limite_entradas < 1) {
        return falha('limite_entradas', 'deve ser inteiro maior ou igual a 1');
    }

    if (
        !numeroEstrito(config.stop_win)
        || config.stop_win <= 0
        || config.stop_win > LIMITE_DECIMAL_DINHEIRO
    ) {
        return falha('stop_win', 'deve ser número positivo dentro do limite financeiro');
    }
    if (
        !numeroEstrito(config.stop_loss)
        || config.stop_loss <= 0
        || config.stop_loss > LIMITE_DECIMAL_DINHEIRO
    ) {
        return falha('stop_loss', 'deve ser número positivo dentro do limite financeiro');
    }

    if (typeof config.trailing_stop !== 'boolean') {
        return falha('trailing_stop', 'deve ser booleano');
    }
    if (config.trailing_stop === true) {
        if (
            !numeroEstrito(config.trailing_recuo)
            || config.trailing_recuo <= 0
            || config.trailing_recuo > LIMITE_DECIMAL_DINHEIRO
        ) {
            return falha(
                'trailing_recuo',
                'com Trailing Stop ativo deve ser número maior que zero dentro do limite financeiro'
            );
        }
    } else if (
        config.trailing_recuo !== undefined
        && (!numeroEstrito(config.trailing_recuo) || config.trailing_recuo < 0)
    ) {
        return falha('trailing_recuo', 'quando informado deve ser número maior ou igual a zero');
    }

    if (
        !inteiroEstrito(config.stop_reds_seguidos)
        || config.stop_reds_seguidos < 0
        || config.stop_reds_seguidos > 1000
    ) {
        return falha('stop_reds_seguidos', 'deve ser inteiro entre 0 e 1000');
    }
    if (config.stop_reds_seguidos > 0) {
        if (config.stop_reds_acao !== 'PAUSAR' && config.stop_reds_acao !== 'DESLIGAR') {
            return falha('stop_reds_acao', 'deve ser PAUSAR ou DESLIGAR');
        }
        if (
            config.stop_reds_acao === 'PAUSAR'
            && (!inteiroEstrito(config.stop_reds_pausa_min) || config.stop_reds_pausa_min < 1)
        ) {
            return falha(
                'stop_reds_pausa_min',
                'com ação PAUSAR deve ser inteiro maior ou igual a 1'
            );
        }
    }

    const horario = validarFaixasHorarioConfiguracao(config);
    if (!horario.ok) {
        return falha(horario.campo || 'faixas_horario', horario.motivo || 'configuração de horário inválida');
    }

    if (!Array.isArray(config.fontes_sinal)) {
        return falha('fontes_sinal', 'deve ser uma lista');
    }
    if (config.fontes_sinal.some(fonte => typeof fonte !== 'string' || !fonte.trim())) {
        return falha(
            'fontes_sinal',
            'não pode conter identificadores vazios ou não textuais'
        );
    }

    return { ok: true, campo: null, motivo: null };
}

module.exports = { validarConfiguracaoAutoTrader };
