'use strict';

const ESTADO_DORMINDO = 'DORMINDO';
const ESTADO_ONDA_ATIVA = 'ONDA_ATIVA';
const TIPOS_ALEATORIEDADE = new Set(['NENHUMA', 'PULOS', 'PROBABILIDADE']);

function inteiroNaoNegativo(valor, padrao = 0, maximo = 1000000) {
    const numero = Number(valor);
    if (!Number.isFinite(numero)) return padrao;
    return Math.min(maximo, Math.max(0, Math.trunc(numero)));
}

function inteiroPositivo(valor, padrao = 1, maximo = 1000000) {
    const numero = Number(valor);
    if (!Number.isFinite(numero)) return padrao;
    return Math.min(maximo, Math.max(1, Math.trunc(numero)));
}

function horarioValido(valor) {
    const texto = String(valor || '').trim();
    return /^([01]\d|2[0-3]):([0-5]\d)$/.test(texto) ? texto : null;
}

function horarioParaMinutos(valor) {
    const horario = horarioValido(valor);
    if (!horario) return null;
    const [hora, minuto] = horario.split(':').map(Number);
    return (hora * 60) + minuto;
}

function normalizarFaixasHorario(config = {}) {
    const faixasBrutas = Array.isArray(config.faixas_horario) ? config.faixas_horario : [];
    const faixas = [];

    for (const faixa of faixasBrutas) {
        if (!faixa || typeof faixa !== 'object') continue;
        const inicio = horarioValido(faixa.inicio);
        const fim = horarioValido(faixa.fim);
        if (!inicio || !fim) continue;
        faixas.push({ inicio, fim });
    }

    if (faixas.length > 0) return faixas;

    const inicioLegado = horarioValido(config.hora_inicio) || '00:00';
    const fimLegado = horarioValido(config.hora_fim) || '23:59';
    return [{ inicio: inicioLegado, fim: fimLegado }];
}

function normalizarTipoAleatoriedade(config = {}) {
    const informado = String(config.tipo_aleatoriedade || '').trim().toUpperCase();
    if (TIPOS_ALEATORIEDADE.has(informado)) return informado;

    const legado = String(config.modo_camuflagem || '').trim().toUpperCase();
    return legado === 'PULOS' ? 'PULOS' : 'NENHUMA';
}

function normalizarConfigAutoTrader(config = {}) {
    const base = config && typeof config === 'object' ? { ...config } : {};
    const tipoAleatoriedade = normalizarTipoAleatoriedade(base);
    const puloMin = inteiroPositivo(base.pulo_min ?? base.camuflagem_pulos_min, 1);
    const puloMax = Math.max(
        puloMin,
        inteiroPositivo(base.pulo_max ?? base.camuflagem_pulos_max, Math.max(3, puloMin))
    );
    const chanceNumero = Number(base.chance_entrada_pct);
    const chanceEntrada = Number.isFinite(chanceNumero)
        ? Math.min(100, Math.max(1, chanceNumero))
        : 100;

    delete base.hora_inicio;
    delete base.hora_fim;
    delete base.modo_camuflagem;
    delete base.camuflagem_pulos_min;
    delete base.camuflagem_pulos_max;

    return {
        ...base,
        faixas_horario: normalizarFaixasHorario(config),
        gatilho_reds_virtuais: inteiroNaoNegativo(config.gatilho_reds_virtuais, 0),
        sinais_por_onda: inteiroNaoNegativo(config.sinais_por_onda, 0),
        tipo_aleatoriedade: tipoAleatoriedade,
        pulo_min: puloMin,
        pulo_max: puloMax,
        chance_entrada_pct: chanceEntrada,
        limite_ciclos: inteiroNaoNegativo(config.limite_ciclos, 0)
    };
}

function faixaContemMinuto(faixa, minutoAtual) {
    const inicio = horarioParaMinutos(faixa && faixa.inicio);
    const fim = horarioParaMinutos(faixa && faixa.fim);
    if (inicio === null || fim === null) return false;
    if (inicio === fim) return true;
    if (inicio < fim) return minutoAtual >= inicio && minutoAtual <= fim;
    return minutoAtual >= inicio || minutoAtual <= fim;
}

function traderDentroHorarioExecucao(config, agora = new Date()) {
    const data = agora instanceof Date ? agora : new Date(agora);
    if (Number.isNaN(data.getTime())) return false;
    const minutoAtual = (data.getHours() * 60) + data.getMinutes();
    return normalizarFaixasHorario(config).some(faixa => faixaContemMinuto(faixa, minutoAtual));
}

function formatarFaixasHorario(config) {
    return normalizarFaixasHorario(config)
        .map(faixa => `${faixa.inicio}-${faixa.fim}`)
        .join(', ');
}

function normalizarEstadoCiclo(trader = {}) {
    const estadoBruto = String(trader.estado_ciclo || '').trim().toUpperCase();
    const estadoCiclo = estadoBruto === ESTADO_ONDA_ATIVA ? ESTADO_ONDA_ATIVA : ESTADO_DORMINDO;
    return {
        estado_ciclo: estadoCiclo,
        reds_virtuais_observados: inteiroNaoNegativo(trader.reds_virtuais_observados, 0),
        sinais_operados_onda: inteiroNaoNegativo(trader.sinais_operados_onda, 0),
        ciclos_concluidos: inteiroNaoNegativo(trader.ciclos_concluidos, 0),
        pulos_restantes: inteiroNaoNegativo(trader.pulos_restantes, 0)
    };
}

function estadoInicialCiclo() {
    return {
        estado_ciclo: ESTADO_DORMINDO,
        reds_virtuais_observados: 0,
        sinais_operados_onda: 0,
        ciclos_concluidos: 0,
        pulos_restantes: 0
    };
}

function configuracaoCicloMudou(anterior = {}, nova = {}) {
    const a = normalizarConfigAutoTrader(anterior);
    const b = normalizarConfigAutoTrader(nova);
    const chaves = [
        'gatilho_reds_virtuais',
        'sinais_por_onda',
        'tipo_aleatoriedade',
        'pulo_min',
        'pulo_max',
        'chance_entrada_pct',
        'limite_ciclos'
    ];
    return chaves.some(chave => a[chave] !== b[chave]);
}

function estadoAlterado(a, b) {
    return a.estado_ciclo !== b.estado_ciclo
        || a.reds_virtuais_observados !== b.reds_virtuais_observados
        || a.sinais_operados_onda !== b.sinais_operados_onda
        || a.ciclos_concluidos !== b.ciclos_concluidos
        || a.pulos_restantes !== b.pulos_restantes;
}

function processarResultadoDormindo(trader, tipoResultado) {
    const config = normalizarConfigAutoTrader(trader && trader.config || {});
    const anterior = normalizarEstadoCiclo(trader);
    const estado = { ...anterior };
    const tipo = String(tipoResultado || '').trim().toUpperCase();

    if (estado.estado_ciclo !== ESTADO_DORMINDO || config.gatilho_reds_virtuais <= 0) {
        return { mudou: false, acordou: false, estado };
    }

    if (tipo !== 'RED') {
        return { mudou: false, acordou: false, estado };
    }

    estado.reds_virtuais_observados++;
    let acordou = false;
    if (estado.reds_virtuais_observados >= config.gatilho_reds_virtuais) {
        estado.estado_ciclo = ESTADO_ONDA_ATIVA;
        estado.reds_virtuais_observados = 0;
        estado.sinais_operados_onda = 0;
        estado.pulos_restantes = 0;
        acordou = true;
    }

    return { mudou: estadoAlterado(anterior, estado), acordou, estado };
}

function randomNormalizado(randomFn) {
    let valor = 0.5;
    try { valor = Number(randomFn()); } catch (e) {}
    if (!Number.isFinite(valor)) return 0.5;
    if (valor <= 0) return 0;
    if (valor >= 1) return 0.999999999;
    return valor;
}

function avaliarSinalOnda(trader, randomFn = Math.random) {
    const config = normalizarConfigAutoTrader(trader && trader.config || {});
    const anterior = normalizarEstadoCiclo(trader);
    const estado = { ...anterior };

    if (config.limite_ciclos > 0 && estado.ciclos_concluidos >= config.limite_ciclos) {
        return {
            permitido: false,
            auto_stop: true,
            motivo: 'LIMITE_CICLOS',
            persistir: false,
            estado
        };
    }

    if (estado.estado_ciclo === ESTADO_DORMINDO) {
        if (config.gatilho_reds_virtuais > 0) {
            return {
                permitido: false,
                auto_stop: false,
                motivo: 'DORMINDO',
                persistir: false,
                estado
            };
        }
        estado.estado_ciclo = ESTADO_ONDA_ATIVA;
        estado.reds_virtuais_observados = 0;
        estado.sinais_operados_onda = 0;
    }

    if (config.tipo_aleatoriedade === 'PROBABILIDADE') {
        const sorteioPct = randomNormalizado(randomFn) * 100;
        return {
            permitido: sorteioPct < config.chance_entrada_pct,
            auto_stop: false,
            motivo: sorteioPct < config.chance_entrada_pct ? null : 'PROBABILIDADE',
            sorteio_pct: sorteioPct,
            persistir: estadoAlterado(anterior, estado),
            estado
        };
    }

    if (config.tipo_aleatoriedade === 'PULOS') {
        if (estado.pulos_restantes > 0) {
            estado.pulos_restantes--;
            return {
                permitido: false,
                auto_stop: false,
                motivo: 'PULO',
                persistir: true,
                estado
            };
        }

        const amplitude = config.pulo_max - config.pulo_min + 1;
        estado.pulos_restantes = config.pulo_min
            + Math.floor(randomNormalizado(randomFn) * amplitude);
        return {
            permitido: true,
            auto_stop: false,
            motivo: null,
            persistir: true,
            estado
        };
    }

    return {
        permitido: true,
        auto_stop: false,
        motivo: null,
        persistir: estadoAlterado(anterior, estado),
        estado
    };
}

function avancarAposSinalOperado(trader) {
    const config = normalizarConfigAutoTrader(trader && trader.config || {});
    const anterior = normalizarEstadoCiclo(trader);
    const estado = { ...anterior };

    if (estado.estado_ciclo !== ESTADO_ONDA_ATIVA) {
        estado.estado_ciclo = ESTADO_ONDA_ATIVA;
    }

    estado.sinais_operados_onda++;
    let cicloConcluido = false;
    let autoStop = false;

    if (config.sinais_por_onda > 0 && estado.sinais_operados_onda >= config.sinais_por_onda) {
        cicloConcluido = true;
        estado.ciclos_concluidos++;
        estado.estado_ciclo = ESTADO_DORMINDO;
        estado.reds_virtuais_observados = 0;
        estado.sinais_operados_onda = 0;
        estado.pulos_restantes = 0;
        autoStop = config.limite_ciclos > 0 && estado.ciclos_concluidos >= config.limite_ciclos;
    }

    return {
        mudou: estadoAlterado(anterior, estado),
        ciclo_concluido: cicloConcluido,
        auto_stop: autoStop,
        estado
    };
}

function aplicarEstadoCiclo(trader, estadoBruto) {
    if (!trader) return null;
    const estado = normalizarEstadoCiclo(estadoBruto || {});
    trader.estado_ciclo = estado.estado_ciclo;
    trader.reds_virtuais_observados = estado.reds_virtuais_observados;
    trader.sinais_operados_onda = estado.sinais_operados_onda;
    trader.ciclos_concluidos = estado.ciclos_concluidos;
    trader.pulos_restantes = estado.pulos_restantes;
    return estado;
}

module.exports = {
    ESTADO_DORMINDO,
    ESTADO_ONDA_ATIVA,
    normalizarFaixasHorario,
    normalizarConfigAutoTrader,
    traderDentroHorarioExecucao,
    formatarFaixasHorario,
    normalizarEstadoCiclo,
    estadoInicialCiclo,
    configuracaoCicloMudou,
    processarResultadoDormindo,
    avaliarSinalOnda,
    avancarAposSinalOperado,
    aplicarEstadoCiclo
};
