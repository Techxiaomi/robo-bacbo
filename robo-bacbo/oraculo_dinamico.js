'use strict';

const ORACULO_NGRAMS = Object.freeze([3, 4, 5, 6]);
const ORACULO_Z95 = 1.96;

function normalizarResultadoOraculo(valor) {
    const texto = String(valor || '').trim().toUpperCase();
    if (texto === 'P' || texto === 'PLAYER' || texto === 'PLAYERWON' || texto === 'JOGADOR') return 'P';
    if (texto === 'B' || texto === 'BANKER' || texto === 'BANKERWON' || texto === 'BANCA') return 'B';
    if (texto === 'T' || texto === 'TIE' || texto === 'TIEWON' || texto === 'EMPATE') return 'T';
    return '';
}

function normalizarSessaoOraculo(valor) {
    if (valor === null || valor === undefined) return '';
    return String(valor).trim();
}

function normalizarSerieOraculo(dados) {
    return (Array.isArray(dados) ? dados : []).map((item, index) => {
        const timestampBruto = item && (item.timestamp_ms ?? item.timestamp ?? item.data_hora ?? item.instant);
        const timestampNumero = Number(timestampBruto);
        const timestampMs = Number.isFinite(timestampNumero)
            ? (timestampNumero < 1e12 ? timestampNumero * 1000 : timestampNumero)
            : Date.parse(String(timestampBruto || ''));
        return {
            id: item && item.id !== undefined ? item.id : index,
            resultado: normalizarResultadoOraculo(item && (item.resultado ?? item.winner ?? item.type)),
            id_sessao: normalizarSessaoOraculo(item && item.id_sessao),
            timestamp_ms: Number.isFinite(timestampMs) ? timestampMs : 0
        };
    });
}

function extrairMesaAtual(dados, limite = 20) {
    const serie = normalizarSerieOraculo(dados);
    if (serie.length === 0) return [];
    const ultimo = serie[serie.length - 1];
    if (!ultimo.resultado || !ultimo.id_sessao) return [];
    const saida = [];
    for (let i = serie.length - 1; i >= 0 && saida.length < Math.max(1, Number(limite) || 20); i--) {
        const item = serie[i];
        if (!item.resultado || item.id_sessao !== ultimo.id_sessao) break;
        saida.unshift(item);
    }
    return saida;
}

function wilsonLowerBound95(sucessos, total) {
    const n = Number(total);
    const wins = Number(sucessos);
    if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(wins) || wins < 0) return 0;
    const p = Math.max(0, Math.min(1, wins / n));
    const z2 = ORACULO_Z95 * ORACULO_Z95;
    const denominador = 1 + (z2 / n);
    const centro = p + (z2 / (2 * n));
    const margem = ORACULO_Z95 * Math.sqrt((p * (1 - p) + (z2 / (4 * n))) / n);
    return Math.max(0, ((centro - margem) / denominador) * 100);
}

function mesmaSessaoOraculo(dados, inicio, fimInclusive) {
    if (!Array.isArray(dados) || inicio < 0 || fimInclusive >= dados.length || inicio > fimInclusive) return false;
    const sessao = normalizarSessaoOraculo(dados[inicio] && dados[inicio].id_sessao);
    if (!sessao) return false;
    for (let i = inicio; i <= fimInclusive; i++) {
        if (normalizarSessaoOraculo(dados[i] && dados[i].id_sessao) !== sessao) return false;
    }
    return true;
}

function avaliarCenarioNormalizadoOraculo(historico, padrao, lado, gales) {
    const serie = Array.isArray(historico) ? historico : [];
    const recorte = (Array.isArray(padrao) ? padrao : []).map(normalizarResultadoOraculo);
    const alvo = normalizarResultadoOraculo(lado);
    const gale = Math.max(0, Math.min(2, Math.trunc(Number(gales) || 0)));
    const horizonte = gale + 1;
    const n = recorte.length;
    let amostras = 0;
    let acertos = 0;

    if (n < 1 || recorte.some(item => !item) || (alvo !== 'P' && alvo !== 'B')) {
        return { n, lado: alvo, amostras: 0, acertos: 0, taxa_bruta: 0, confianca_wilson: 0 };
    }

    for (let i = 0; i + n + horizonte <= serie.length; i++) {
        const fimJanela = i + n + horizonte - 1;
        if (!mesmaSessaoOraculo(serie, i, fimJanela)) continue;

        let match = true;
        for (let p = 0; p < n; p++) {
            if (normalizarResultadoOraculo(serie[i + p] && serie[i + p].resultado) !== recorte[p]) {
                match = false;
                break;
            }
        }
        if (!match) continue;

        amostras++;
        for (let passo = 0; passo < horizonte; passo++) {
            if (normalizarResultadoOraculo(serie[i + n + passo] && serie[i + n + passo].resultado) === alvo) {
                acertos++;
                break;
            }
        }
    }

    return {
        n,
        lado: alvo,
        amostras,
        acertos,
        taxa_bruta: amostras > 0 ? (acertos / amostras) * 100 : 0,
        confianca_wilson: wilsonLowerBound95(acertos, amostras)
    };
}

function avaliarCenarioOraculo(historico, padrao, lado, gales) {
    return avaliarCenarioNormalizadoOraculo(
        normalizarSerieOraculo(historico),
        padrao,
        lado,
        gales
    );
}

function montarCenariosOraculo(historico, mesaAtual, gales) {
    const serie = normalizarSerieOraculo(historico);
    const mesa = extrairMesaAtual(mesaAtual, 20);
    const cenarios = [];
    for (const n of ORACULO_NGRAMS) {
        if (mesa.length < n) continue;
        const padrao = mesa.slice(-n).map(item => item.resultado);
        for (const lado of ['P', 'B']) {
            cenarios.push(avaliarCenarioNormalizadoOraculo(serie, padrao, lado, gales));
        }
    }
    return cenarios;
}

function ordenarCenariosOraculo(a, b) {
    if (b.taxa_bruta !== a.taxa_bruta) return b.taxa_bruta - a.taxa_bruta;
    if (b.n !== a.n) return b.n - a.n;
    if (b.amostras !== a.amostras) return b.amostras - a.amostras;
    return String(a.lado).localeCompare(String(b.lado));
}

function melhorCenarioOraculo(cenarios) {
    const lista = (Array.isArray(cenarios) ? cenarios : []).filter(item => (
        item
        && Number.isFinite(Number(item.taxa_bruta))
        && Number(item.amostras) >= 3
    ));
    return lista.length > 0 ? [...lista].sort(ordenarCenariosOraculo)[0] : null;
}

function direcaoForteOraculo(cenarios, n, confiancaMinima) {
    const lista = (Array.isArray(cenarios) ? cenarios : [])
        .filter(item => item && Number(item.n) === Number(n) && Number(item.amostras) > 0)
        .sort(ordenarCenariosOraculo);
    if (lista.length < 2) return null;
    const primeiro = lista[0];
    const segundo = lista[1];
    if (primeiro.confianca_wilson < confiancaMinima) return null;
    if (Math.abs(primeiro.confianca_wilson - segundo.confianca_wilson) < 1e-12) return null;
    return primeiro;
}

function arredondar1Oraculo(valor) {
    const numero = Number(valor);
    return Number.isFinite(numero) ? Number(numero.toFixed(1)) : 0;
}

function rejeicaoMesaOraculo(detalhe, melhorConfianca, mensagem, extra = {}) {
    return {
        status: 'REJEITADO',
        motivo: 'MESA_INSTAVEL',
        detalhe: String(detalhe || 'MESA_INSTAVEL'),
        melhor_confianca: arredondar1Oraculo(melhorConfianca),
        mensagem: String(mensagem || 'Mesa Instável. Aguarde.'),
        ...extra
    };
}

function decidirOraculo(cenarios, mesaAtual, confiancaMinima) {
    const minimo = Number(confiancaMinima);
    const mesa = extrairMesaAtual(mesaAtual, 20);
    if (!Number.isFinite(minimo) || minimo < 0 || minimo > 100) {
        throw new Error('confianca_minima_invalida');
    }
    if (mesa.length < 6) {
        return rejeicaoMesaOraculo(
            'DADOS_ATUAIS_INSUFICIENTES',
            0,
            'Ainda não há seis resultados contínuos na sessão atual para formar N-Grams N-3 a N-6.'
        );
    }

    const empatesUltimos5 = mesa.slice(-5).filter(item => item.resultado === 'T').length;
    if (empatesUltimos5 >= 2) {
        return rejeicaoMesaOraculo(
            'EMPATES_EXCESSIVOS',
            0,
            'Mesa Instável: dois ou mais empates foram observados nos últimos cinco giros.',
            { empates_ultimos_5: empatesUltimos5 }
        );
    }

    const melhor = melhorCenarioOraculo(cenarios);
    if (!melhor) {
        return rejeicaoMesaOraculo(
            'DADOS_HISTORICOS_INSUFICIENTES',
            0,
            'A janela histórica não possui pelo menos 3 ocorrências completas para validar os N-Grams da mesa atual.'
        );
    }

    if (melhor.taxa_bruta < minimo) {
        return rejeicaoMesaOraculo(
            'ABAIXO_DA_META',
            melhor.taxa_bruta,
            'A maior probabilidade histórica no momento não atinge seu alvo. Aguarde.'
        );
    }

    return {
        status: 'APROVADO',
        sugerido: melhor.lado,
        confianca_wilson: arredondar1Oraculo(melhor.taxa_bruta),
        amostras_base: Number(melhor.amostras) || 0,
        padrao_vencedor: 'N-' + melhor.n,
        mensagem: 'Sinal forte detectado.'
    };
}

function analisarOraculo({ historico, mesaAtual, gales, confiancaMinima }) {
    const gale = Number(gales);
    if (!Number.isInteger(gale) || gale < 0 || gale > 2) throw new Error('gales_invalidos');
    const mesa = extrairMesaAtual(mesaAtual, 20);
    const cenarios = montarCenariosOraculo(historico, mesa, gale);
    return decidirOraculo(cenarios, mesa, confiancaMinima);
}

module.exports = {
    normalizarResultadoOraculo,
    extrairMesaAtual,
    wilsonLowerBound95,
    avaliarCenarioOraculo,
    montarCenariosOraculo,
    decidirOraculo,
    analisarOraculo
};
