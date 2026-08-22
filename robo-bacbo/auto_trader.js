'use strict';

const FAIXA_PADRAO = Object.freeze({ inicio: '00:00', fim: '23:59' });

function horarioValido(valor) {
    return /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(valor || '').trim());
}

function horarioParaMinutos(valor) {
    if (!horarioValido(valor)) return null;
    const [hora, minuto] = String(valor).trim().split(':').map(Number);
    return (hora * 60) + minuto;
}

function normalizarFaixaHorario(faixa) {
    if (!faixa || typeof faixa !== 'object' || Array.isArray(faixa)) return null;

    const inicio = String(faixa.inicio || '').trim();
    const fim = String(faixa.fim || '').trim();
    if (!horarioValido(inicio) || !horarioValido(fim)) return null;

    return { inicio, fim };
}

function normalizarFaixasHorario(config = {}) {
    const cf = config && typeof config === 'object' ? config : {};
    const faixasNovas = Array.isArray(cf.faixas_horario)
        ? cf.faixas_horario.map(normalizarFaixaHorario).filter(Boolean)
        : [];

    if (faixasNovas.length > 0) return faixasNovas;

    // Compatibilidade com motores antigos que ainda possuem apenas hora_inicio/hora_fim.
    const inicioLegado = horarioValido(cf.hora_inicio) ? String(cf.hora_inicio).trim() : FAIXA_PADRAO.inicio;
    const fimLegado = horarioValido(cf.hora_fim) ? String(cf.hora_fim).trim() : FAIXA_PADRAO.fim;
    return [{ inicio: inicioLegado, fim: fimLegado }];
}

function normalizarConfigHorariosAutoTrader(config = {}) {
    const normalizada = config && typeof config === 'object' && !Array.isArray(config)
        ? { ...config }
        : {};

    normalizada.faixas_horario = normalizarFaixasHorario(normalizada);
    delete normalizada.hora_inicio;
    delete normalizada.hora_fim;
    return normalizada;
}

function horarioDentroDaFaixa(faixa, minutoAtual) {
    const inicio = horarioParaMinutos(faixa.inicio);
    const fim = horarioParaMinutos(faixa.fim);
    if (inicio === null || fim === null) return false;

    // Mantém o comportamento legado: início == fim representa operação durante todo o dia.
    if (inicio === fim) return true;
    if (inicio < fim) return minutoAtual >= inicio && minutoAtual <= fim;

    // Faixa atravessando meia-noite, por exemplo 22:00 -> 02:00.
    return minutoAtual >= inicio || minutoAtual <= fim;
}

function traderDentroHorarioExecucao(config, agora = new Date()) {
    const minutoAtual = (agora.getHours() * 60) + agora.getMinutes();
    return normalizarFaixasHorario(config).some(faixa => horarioDentroDaFaixa(faixa, minutoAtual));
}

function formatarFaixasHorario(config) {
    return normalizarFaixasHorario(config)
        .map(faixa => `${faixa.inicio}-${faixa.fim}`)
        .join(', ');
}

module.exports = {
    normalizarFaixasHorario,
    normalizarConfigHorariosAutoTrader,
    traderDentroHorarioExecucao,
    formatarFaixasHorario
};
