'use strict';

const HORARIO_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const FAIXA_PADRAO = Object.freeze({ inicio: '00:00', fim: '23:59' });

function horarioValido(valor) {
    return typeof valor === 'string' && HORARIO_RE.test(valor.trim());
}

function faixaValida(faixa) {
    return Boolean(
        faixa
        && typeof faixa === 'object'
        && !Array.isArray(faixa)
        && horarioValido(faixa.inicio)
        && horarioValido(faixa.fim)
    );
}

function copiarFaixa(faixa) {
    return {
        inicio: String(faixa.inicio).trim(),
        fim: String(faixa.fim).trim()
    };
}

function validarFaixasHorarioConfiguracao(config) {
    const cf = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
    const possuiFaixas = Object.prototype.hasOwnProperty.call(cf, 'faixas_horario');

    if (possuiFaixas) {
        if (!Array.isArray(cf.faixas_horario) || cf.faixas_horario.length === 0) {
            return {
                ok: false,
                campo: 'faixas_horario',
                motivo: 'deve ser uma lista não vazia de faixas com inicio e fim em HH:MM',
                faixas: [],
                legado: false
            };
        }

        for (let indice = 0; indice < cf.faixas_horario.length; indice++) {
            const faixa = cf.faixas_horario[indice];
            if (!faixaValida(faixa)) {
                return {
                    ok: false,
                    campo: `faixas_horario[${indice}]`,
                    motivo: 'inicio e fim devem usar o formato HH:MM entre 00:00 e 23:59',
                    faixas: [],
                    legado: false
                };
            }
        }

        return {
            ok: true,
            campo: null,
            motivo: null,
            faixas: cf.faixas_horario.map(copiarFaixa),
            legado: false
        };
    }

    const possuiInicioLegado = Object.prototype.hasOwnProperty.call(cf, 'hora_inicio');
    const possuiFimLegado = Object.prototype.hasOwnProperty.call(cf, 'hora_fim');
    const inicio = possuiInicioLegado ? cf.hora_inicio : FAIXA_PADRAO.inicio;
    const fim = possuiFimLegado ? cf.hora_fim : FAIXA_PADRAO.fim;

    if (!horarioValido(inicio)) {
        return {
            ok: false,
            campo: 'hora_inicio',
            motivo: 'deve usar o formato HH:MM entre 00:00 e 23:59',
            faixas: [],
            legado: true
        };
    }
    if (!horarioValido(fim)) {
        return {
            ok: false,
            campo: 'hora_fim',
            motivo: 'deve usar o formato HH:MM entre 00:00 e 23:59',
            faixas: [],
            legado: true
        };
    }

    return {
        ok: true,
        campo: null,
        motivo: null,
        faixas: [{ inicio: String(inicio).trim(), fim: String(fim).trim() }],
        legado: true
    };
}

function normalizarConfigHorarios(config) {
    const base = config && typeof config === 'object' && !Array.isArray(config)
        ? { ...config }
        : {};
    const validacao = validarFaixasHorarioConfiguracao(base);
    if (!validacao.ok) {
        return { config: base, alterado: false, validacao };
    }

    const tinhaLegado = Object.prototype.hasOwnProperty.call(base, 'hora_inicio')
        || Object.prototype.hasOwnProperty.call(base, 'hora_fim');
    const tinhaFaixas = Array.isArray(base.faixas_horario);
    const faixasAnteriores = tinhaFaixas ? JSON.stringify(base.faixas_horario) : null;

    base.faixas_horario = validacao.faixas.map(copiarFaixa);
    delete base.hora_inicio;
    delete base.hora_fim;

    return {
        config: base,
        alterado: validacao.legado || tinhaLegado || faixasAnteriores !== JSON.stringify(base.faixas_horario),
        validacao
    };
}

function horarioParaMinutos(valor) {
    if (!horarioValido(valor)) return null;
    const [hora, minuto] = String(valor).trim().split(':').map(Number);
    return (hora * 60) + minuto;
}

function minutoDentroFaixa(minutoAtual, faixa) {
    if (!faixaValida(faixa)) return false;
    const inicio = horarioParaMinutos(faixa.inicio);
    const fim = horarioParaMinutos(faixa.fim);
    if (inicio === null || fim === null) return false;
    if (inicio === fim) return true;
    if (inicio < fim) return minutoAtual >= inicio && minutoAtual <= fim;
    return minutoAtual >= inicio || minutoAtual <= fim;
}

function dentroDeAlgumaFaixa(config, agora = new Date()) {
    const instante = agora instanceof Date ? agora : new Date(agora);
    if (Number.isNaN(instante.getTime())) return false;

    const validacao = validarFaixasHorarioConfiguracao(config);
    if (!validacao.ok || validacao.faixas.length === 0) return false;

    const minutoAtual = (instante.getHours() * 60) + instante.getMinutes();
    return validacao.faixas.some(faixa => minutoDentroFaixa(minutoAtual, faixa));
}

function descreverFaixasHorario(config) {
    const validacao = validarFaixasHorarioConfiguracao(config);
    if (!validacao.ok) return 'configuração inválida';
    return validacao.faixas.map(faixa => `${faixa.inicio}-${faixa.fim}`).join(', ');
}

module.exports = {
    FAIXA_PADRAO,
    horarioValido,
    faixaValida,
    validarFaixasHorarioConfiguracao,
    normalizarConfigHorarios,
    dentroDeAlgumaFaixa,
    descreverFaixasHorario
};
