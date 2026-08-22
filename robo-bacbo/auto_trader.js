'use strict';

const HORARIO_PADRAO = Object.freeze({ inicio: '00:00', fim: '23:59' });
const REGEX_HORARIO = /^([01]\d|2[0-3]):([0-5]\d)$/;

function horarioValido(valor) {
    const texto = String(valor || '').trim();
    return REGEX_HORARIO.test(texto) ? texto : null;
}

function normalizarFaixaHorario(faixa) {
    if (!faixa || typeof faixa !== 'object' || Array.isArray(faixa)) return null;
    const inicio = horarioValido(faixa.inicio);
    const fim = horarioValido(faixa.fim);
    if (!inicio || !fim) return null;
    return { inicio, fim };
}

function normalizarFaixasHorario(config = {}) {
    const cf = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
    const recebidas = Array.isArray(cf.faixas_horario) ? cf.faixas_horario : [];
    const normalizadas = recebidas.map(normalizarFaixaHorario).filter(Boolean);

    if (normalizadas.length > 0) return normalizadas;

    const inicioLegado = horarioValido(cf.hora_inicio);
    const fimLegado = horarioValido(cf.hora_fim);
    if (inicioLegado || fimLegado) {
        return [{
            inicio: inicioLegado || HORARIO_PADRAO.inicio,
            fim: fimLegado || HORARIO_PADRAO.fim
        }];
    }

    return [{ ...HORARIO_PADRAO }];
}

function normalizarConfigAutoTrader(config = {}) {
    const base = config && typeof config === 'object' && !Array.isArray(config)
        ? { ...config }
        : {};
    base.faixas_horario = normalizarFaixasHorario(base);
    delete base.hora_inicio;
    delete base.hora_fim;
    return base;
}

function horarioParaMinutos(valor) {
    const horario = horarioValido(valor);
    if (!horario) return null;
    const [hora, minuto] = horario.split(':').map(Number);
    return (hora * 60) + minuto;
}

function horarioDentroDaFaixa(faixa, minutoAtual) {
    const normalizada = normalizarFaixaHorario(faixa);
    if (!normalizada) return false;

    const inicio = horarioParaMinutos(normalizada.inicio);
    const fim = horarioParaMinutos(normalizada.fim);
    if (inicio === null || fim === null) return false;

    if (inicio === fim) return true;
    if (inicio < fim) return minutoAtual >= inicio && minutoAtual <= fim;
    return minutoAtual >= inicio || minutoAtual <= fim;
}

function traderDentroHorarioExecucao(config, agora = new Date()) {
    const instante = agora instanceof Date ? agora : new Date(agora);
    if (Number.isNaN(instante.getTime())) return false;

    const minutoAtual = (instante.getHours() * 60) + instante.getMinutes();
    return normalizarFaixasHorario(config)
        .some(faixa => horarioDentroDaFaixa(faixa, minutoAtual));
}

function formatarFaixasHorario(config) {
    return normalizarFaixasHorario(config)
        .map(faixa => `${faixa.inicio}-${faixa.fim}`)
        .join(', ');
}

module.exports = {
    horarioValido,
    normalizarFaixaHorario,
    normalizarFaixasHorario,
    normalizarConfigAutoTrader,
    traderDentroHorarioExecucao,
    formatarFaixasHorario
};
