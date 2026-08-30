'use strict';

const LIMITE_DECIMAL_DINHEIRO = 9_999_999_999.99;
const LIMITE_MULTIPLICADOR_GALE = 1000;
const LIMITE_PULOS = 1000;
const LIMITE_CONTADOR_ESTRATEGIA = 1_000_000;
const TIPOS_ALEATORIEDADE = new Set(['NENHUMA', 'PULOS', 'PROBABILIDADE']);

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

function horarioValido(valor) {
    return typeof valor === 'string'
        && /^([01]\d|2[0-3]):[0-5]\d$/.test(valor);
}

function validarEstrategiaAleatoriedade(config) {
    const usaContratoModerno = [
        'tipo_aleatoriedade',
        'gatilho_reds_virtuais',
        'sinais_por_onda',
        'pulo_min',
        'pulo_max',
        'chance_entrada_pct',
        'limite_ciclos'
    ].some(campo => Object.prototype.hasOwnProperty.call(config, campo));

    if (!usaContratoModerno) {
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
        return null;
    }

    const tipo = String(config.tipo_aleatoriedade || '').trim().toUpperCase();
    if (!TIPOS_ALEATORIEDADE.has(tipo)) {
        return falha('tipo_aleatoriedade', 'deve ser NENHUMA, PULOS ou PROBABILIDADE');
    }

    for (const campo of ['gatilho_reds_virtuais', 'sinais_por_onda', 'limite_ciclos']) {
        const valor = config[campo];
        if (!inteiroEstrito(valor) || valor < 0 || valor > LIMITE_CONTADOR_ESTRATEGIA) {
            return falha(campo, `deve ser inteiro entre 0 e ${LIMITE_CONTADOR_ESTRATEGIA}`);
        }
    }

    if (!inteiroEstrito(config.pulo_min) || config.pulo_min < 1 || config.pulo_min > LIMITE_PULOS) {
        return falha('pulo_min', 'deve ser inteiro entre 1 e 1000');
    }
    if (!inteiroEstrito(config.pulo_max) || config.pulo_max < config.pulo_min || config.pulo_max > LIMITE_PULOS) {
        return falha('pulo_max', 'deve ser inteiro maior ou igual ao mínimo e menor ou igual a 1000');
    }

    if (!numeroEstrito(config.chance_entrada_pct) || config.chance_entrada_pct < 1 || config.chance_entrada_pct > 100) {
        return falha('chance_entrada_pct', 'deve ser número entre 1 e 100');
    }

    return null;
}

function validarHorarios(config) {
    if (Array.isArray(config.faixas_horario)) {
        if (config.faixas_horario.length === 0) {
            return falha('faixas_horario', 'deve conter ao menos uma faixa');
        }
        if (config.faixas_horario.length > 100) {
            return falha('faixas_horario', 'não pode conter mais de 100 faixas');
        }

        for (let i = 0; i < config.faixas_horario.length; i++) {
            const faixa = config.faixas_horario[i];
            if (!faixa || typeof faixa !== 'object' || Array.isArray(faixa)) {
                return falha(`faixas_horario[${i}]`, 'deve ser um objeto com inicio e fim');
            }
            if (!horarioValido(faixa.inicio)) {
                return falha(
                    `faixas_horario[${i}].inicio`,
                    'deve usar o formato HH:MM entre 00:00 e 23:59'
                );
            }
            if (!horarioValido(faixa.fim)) {
                return falha(
                    `faixas_horario[${i}].fim`,
                    'deve usar o formato HH:MM entre 00:00 e 23:59'
                );
            }
        }
        return null;
    }

    if (!horarioValido(config.hora_inicio)) {
        return falha('hora_inicio', 'deve usar o formato HH:MM entre 00:00 e 23:59');
    }
    if (!horarioValido(config.hora_fim)) {
        return falha('hora_fim', 'deve usar o formato HH:MM entre 00:00 e 23:59');
    }
    return null;
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

    const erroAleatoriedade = validarEstrategiaAleatoriedade(config);
    if (erroAleatoriedade) return erroAleatoriedade;

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
    if (
        !numeroEstrito(config.trailing_recuo)
        || config.trailing_recuo < 0
        || config.trailing_recuo > LIMITE_DECIMAL_DINHEIRO
    ) {
        return falha(
            'trailing_recuo',
            'deve ser número maior ou igual a zero dentro do limite financeiro; zero mantém o Trailing Stop não armado'
        );
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

    const erroHorarios = validarHorarios(config);
    if (erroHorarios) return erroHorarios;

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
