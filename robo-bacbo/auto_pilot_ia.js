'use strict';

const crypto = require('crypto');
const { obterMesaRuntime } = require('./mesa_runtime_context');

const RESULTADOS_VALIDOS = new Set(['Player', 'Banker', 'Tie']);
const ALVOS = ['Player', 'Banker'];

function numeroLimitado(valor, padrao, min, max) {
    const n = Number(valor);
    if (!Number.isFinite(n)) return padrao;
    return Math.min(max, Math.max(min, n));
}

function inteiroLimitado(valor, padrao, min, max) {
    return Math.trunc(numeroLimitado(valor, padrao, min, max));
}

function normalizarConfigAutoTuning(config = {}) {
    const perfilBruto = String(config.perfil_selecao || 'BALANCEADO').trim().toUpperCase();
    const perfil = ['CONSERVADOR', 'BALANCEADO', 'AGRESSIVO'].includes(perfilBruto)
        ? perfilBruto
        : 'BALANCEADO';

    const tamMin = inteiroLimitado(config.tam_min, 3, 2, 6);
    const tamMax = inteiroLimitado(config.tam_max, 5, tamMin, 6);

    return {
        ativo: config.ativo === true || config.ativo === 1,
        perfil_selecao: perfil,
        range: inteiroLimitado(config.range, 1000, 100, 10000),
        trigger: inteiroLimitado(config.trigger, 150, 10, 100000),
        tam_min: tamMin,
        tam_max: tamMax,
        assert_min: numeroLimitado(config.assert_min, 95, 50, 100),
        ocorr_min: inteiroLimitado(config.ocorr_min, 10, 1, 100000),
        gales: inteiroLimitado(config.gales, 2, 0, 2),
        proteger_empate: config.proteger_empate !== false,
        blacklist: String(config.blacklist || '').trim(),
        shadow_giros: inteiroLimitado(config.shadow_giros, 0, 0, 5000),
        shadow_live_ocorrencias: inteiroLimitado(config.shadow_live_ocorrencias, 0, 0, 100),
        shadow_live_max_candidatos: inteiroLimitado(config.shadow_live_max_candidatos, 10, 1, 50),
        max_padroes: inteiroLimitado(config.max_padroes, 4, 1, 100),
        drop_reds: inteiroLimitado(config.drop_reds, 2, 0, 100),
        drop_assert: numeroLimitado(config.drop_assert, 85, 0, 100),
        ttl_horas: numeroLimitado(config.ttl_horas, 4, 0.25, 720),
        max_reservas: inteiroLimitado(
            config.max_reservas,
            Math.max(20, inteiroLimitado(config.max_padroes, 4, 1, 100) * 5),
            0,
            500
        )
    };
}

function simboloCurto(valor) {
    if (valor === 'Player') return 'P';
    if (valor === 'Banker') return 'B';
    if (valor === 'Tie') return 'T';
    return String(valor || '').trim().toUpperCase();
}

function normalizarTokenPadrao(token) {
    const t = String(token || '').trim().toUpperCase();
    if (t === 'P' || t === 'PLAYER' || t === 'AZUL') return 'P';
    if (t === 'B' || t === 'BANKER' || t === 'BANCA' || t === 'VERMELHO') return 'B';
    if (t === 'T' || t === 'TIE' || t === 'EMPATE') return 'T';
    return '';
}

function padraoCanonico(padrao) {
    return (Array.isArray(padrao) ? padrao : [])
        .map(simboloCurto)
        .filter(Boolean)
        .join(',');
}

function parseBlacklist(texto) {
    const bruto = String(texto || '').trim();
    if (!bruto) return new Set();

    // Separadores explícitos entre padrões: ponto-e-vírgula, quebra de linha ou pipe.
    // Se não houver nenhum deles, o texto inteiro é tratado como um único padrão.
    const blocos = /[;|\n]/.test(bruto) ? bruto.split(/[;|\n]+/) : [bruto];
    const saida = new Set();

    for (const bloco of blocos) {
        const tokens = String(bloco)
            .split(/[>,\s\-]+/)
            .map(normalizarTokenPadrao)
            .filter(Boolean);
        if (tokens.length > 0) saida.add(tokens.join(','));
    }

    return saida;
}

function wilsonLowerBound(vitorias, total, z = 1.96) {
    const n = Number(total);
    const wins = Number(vitorias);
    if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(wins)) return 0;

    const p = Math.min(1, Math.max(0, wins / n));
    const z2 = z * z;
    const denominador = 1 + (z2 / n);
    const centro = p + (z2 / (2 * n));
    const margem = z * Math.sqrt((p * (1 - p) + (z2 / (4 * n))) / n);
    return Math.max(0, (centro - margem) / denominador);
}

function mesmaSessao(dados, inicio, fimInclusive) {
    if (!Array.isArray(dados) || inicio < 0 || fimInclusive >= dados.length || inicio > fimInclusive) return false;
    const sessao = dados[inicio]?.id_sessao;
    for (let i = inicio; i <= fimInclusive; i++) {
        if (!dados[i] || dados[i].id_sessao !== sessao) return false;
    }
    return true;
}

function ocorrenciasPadrao(dados, padrao, alvo, config, inicioIndice = 0, fimIndiceExclusivo = null) {
    const arr = Array.isArray(dados) ? dados : [];
    const seq = Array.isArray(padrao) ? padrao.map(String) : [];
    const alvoNormalizado = String(alvo || '');
    const gales = Math.max(0, Math.trunc(Number(config?.gales) || 0));
    const protegerEmpate = config?.proteger_empate !== false;
    const inicio = Math.max(0, Math.trunc(Number(inicioIndice) || 0));
    const fim = Math.min(
        arr.length,
        fimIndiceExclusivo === null || fimIndiceExclusivo === undefined
            ? arr.length
            : Math.max(inicio, Math.trunc(Number(fimIndiceExclusivo) || 0))
    );

    if (seq.length === 0 || !ALVOS.includes(alvoNormalizado)) {
        return { ocorrencias: 0, greens: 0, reds: 0, ties: 0, assertividade: 0, recente_assertividade: 0, resultados: [] };
    }

    const resultados = [];

    for (let i = inicio; i + seq.length < fim; i++) {
        const fimPadrao = i + seq.length - 1;
        if (!mesmaSessao(arr, i, fimPadrao)) continue;

        let match = true;
        for (let p = 0; p < seq.length; p++) {
            if (String(arr[i + p]?.resultado || '') !== String(seq[p])) {
                match = false;
                break;
            }
        }
        if (!match) continue;

        const sessao = arr[i].id_sessao;
        let indiceResultado = i + seq.length;
        let desfecho = null;

        for (let nivel = 0; nivel <= gales && indiceResultado < fim; nivel++, indiceResultado++) {
            const giro = arr[indiceResultado];
            if (!giro || giro.id_sessao !== sessao) break;

            const resultado = String(giro.resultado || '');
            if (resultado === alvoNormalizado) {
                desfecho = { tipo: 'GREEN', nivel, indice: indiceResultado };
                break;
            }
            if (resultado === 'Tie' && protegerEmpate) {
                desfecho = { tipo: 'TIE', nivel, indice: indiceResultado };
                break;
            }

            if (nivel === gales) {
                desfecho = { tipo: 'RED', nivel, indice: indiceResultado };
            }
        }

        if (!desfecho) continue;
        resultados.push(desfecho);
    }

    const greens = resultados.filter(r => r.tipo === 'GREEN').length;
    const ties = resultados.filter(r => r.tipo === 'TIE').length;
    const reds = resultados.filter(r => r.tipo === 'RED').length;
    const ocorrencias = resultados.length;
    const vitorias = greens + ties;
    const janelaRecente = resultados.slice(-Math.max(3, Math.ceil(ocorrencias * 0.30)));
    const recentesWin = janelaRecente.filter(r => r.tipo === 'GREEN' || r.tipo === 'TIE').length;

    return {
        ocorrencias,
        greens,
        reds,
        ties,
        assertividade: ocorrencias > 0 ? (vitorias / ocorrencias) * 100 : 0,
        recente_assertividade: janelaRecente.length > 0 ? (recentesWin / janelaRecente.length) * 100 : 0,
        resultados
    };
}

function pesosPerfil(perfil) {
    if (perfil === 'CONSERVADOR') {
        return { wilson: 0.55, assert: 0.12, amostra: 0.23, recente: 0.10, complexidade: 1.8, diversidade: 0.68 };
    }
    if (perfil === 'AGRESSIVO') {
        return { wilson: 0.34, assert: 0.36, amostra: 0.12, recente: 0.18, complexidade: 0.7, diversidade: 0.90 };
    }
    return { wilson: 0.45, assert: 0.25, amostra: 0.18, recente: 0.12, complexidade: 1.2, diversidade: 0.78 };
}

function scoreEstatistico(metricas, config, tamanhoPadrao, incumbent = false) {
    const ocorrencias = Math.max(0, Number(metricas?.ocorrencias) || 0);
    const vitorias = Math.max(0, (Number(metricas?.greens) || 0) + (Number(metricas?.ties) || 0));
    const assertividade = Math.max(0, Math.min(100, Number(metricas?.assertividade) || 0));
    const recente = Math.max(0, Math.min(100, Number(metricas?.recente_assertividade) || 0));
    const wilson = wilsonLowerBound(vitorias, ocorrencias) * 100;
    const referenciaAmostra = Math.max(50, (Number(config?.ocorr_min) || 10) * 10);
    const amostraScore = ocorrencias <= 0
        ? 0
        : Math.min(100, (Math.log1p(ocorrencias) / Math.log1p(referenciaAmostra)) * 100);
    const pesos = pesosPerfil(config?.perfil_selecao || 'BALANCEADO');
    const penalidadeComplexidade = Math.max(0, Number(tamanhoPadrao) - 2) * pesos.complexidade;
    const bonusIncumbente = incumbent ? 1.5 : 0;

    const score = (
        (wilson * pesos.wilson)
        + (assertividade * pesos.assert)
        + (amostraScore * pesos.amostra)
        + (recente * pesos.recente)
        - penalidadeComplexidade
        + bonusIncumbente
    );

    return {
        score: Math.max(0, Math.min(100, score)),
        wilson,
        amostra_score: amostraScore,
        penalidade_complexidade: penalidadeComplexidade,
        bonus_incumbente: bonusIncumbente
    };
}

function sufixoComum(a, b) {
    let n = 0;
    while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
    return n;
}

function prefixoComum(a, b) {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
}

function similaridadePadroes(a, b) {
    const pa = Array.isArray(a?.padrao) ? a.padrao.map(String) : [];
    const pb = Array.isArray(b?.padrao) ? b.padrao.map(String) : [];
    if (pa.length === 0 || pb.length === 0) return 0;

    const entradaIgual = String(a?.entrada || '') === String(b?.entrada || '');
    if (!entradaIgual) return 0;

    const menor = Math.min(pa.length, pb.length);
    const maior = Math.max(pa.length, pb.length);
    const prefixo = prefixoComum(pa, pb) / menor;
    const sufixo = sufixoComum(pa, pb) / menor;

    let alinhados = 0;
    const offsetA = pa.length - menor;
    const offsetB = pb.length - menor;
    for (let i = 0; i < menor; i++) {
        if (pa[offsetA + i] === pb[offsetB + i]) alinhados++;
    }
    const alinhamento = alinhados / menor;
    const tamanho = menor / maior;

    return Math.max(prefixo, sufixo, alinhamento * tamanho);
}

function selecionarPortfolio(candidatos, maxPadroes, perfil = 'BALANCEADO') {
    const max = Math.max(1, Math.trunc(Number(maxPadroes) || 1));
    const limiar = pesosPerfil(perfil).diversidade;
    const ordenados = [...(Array.isArray(candidatos) ? candidatos : [])]
        .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0)
            || (Number(b.ocorrencias) || 0) - (Number(a.ocorrencias) || 0)
            || String(a.id || '').localeCompare(String(b.id || '')));

    const selecionados = [];
    const adiados = [];

    for (const candidato of ordenados) {
        if (selecionados.length >= max) break;
        const redundante = selecionados.some(sel => similaridadePadroes(sel, candidato) >= limiar);
        if (redundante) adiados.push(candidato);
        else selecionados.push(candidato);
    }

    // Se a diversidade não preencher o limite, completa por qualidade em vez de deixar capacidade ociosa.
    for (const candidato of adiados) {
        if (selecionados.length >= max) break;
        selecionados.push(candidato);
    }

    return selecionados;
}

function idCandidato(roboId, padrao, entrada, config) {
    const base = [
        Number(roboId),
        padraoCanonico(padrao),
        String(entrada),
        Number(config.gales),
        config.proteger_empate ? 1 : 0
    ].join('|');
    const hash = crypto.createHash('sha1').update(base).digest('hex').slice(0, 18);
    return `ia_${Number(roboId)}_${hash}`;
}

function gerarPadroesUnicos(dados, config, inicio = 0, fim = null) {
    const arr = Array.isArray(dados) ? dados : [];
    const fimReal = fim === null ? arr.length : Math.min(arr.length, Math.max(0, Math.trunc(Number(fim) || 0)));
    const inicioReal = Math.max(0, Math.trunc(Number(inicio) || 0));
    const blacklist = parseBlacklist(config.blacklist);
    const mapa = new Map();

    for (let tamanho = config.tam_min; tamanho <= config.tam_max; tamanho++) {
        for (let i = inicioReal; i + tamanho < fimReal; i++) {
            if (!mesmaSessao(arr, i, i + tamanho - 1)) continue;
            const padrao = arr.slice(i, i + tamanho).map(g => String(g?.resultado || ''));
            if (padrao.some(x => !RESULTADOS_VALIDOS.has(x))) continue;
            const canonico = padraoCanonico(padrao);
            if (!canonico || blacklist.has(canonico)) continue;
            if (!mapa.has(canonico)) mapa.set(canonico, padrao);
        }
    }

    return [...mapa.values()];
}

function minerarCandidatos(dados, configBruta = {}, opcoes = {}) {
    const config = normalizarConfigAutoTuning(configBruta);
    const arrOriginal = (Array.isArray(dados) ? dados : [])
        .filter(g => g && RESULTADOS_VALIDOS.has(String(g.resultado || '')));
    const arr = arrOriginal.slice(-config.range);
    if (arr.length < config.tam_min + config.gales + 2) return [];

    const incumbentes = new Set((opcoes.incumbentes || []).map(String));
    const shadow = Math.min(config.shadow_giros, Math.max(0, arr.length - Math.max(20, config.ocorr_min)));
    const limiteTreino = shadow > 0 ? arr.length - shadow : arr.length;
    const padroes = gerarPadroesUnicos(arr, config, 0, limiteTreino);
    const candidatos = [];
    const diagnostico = {
        janela: arr.length,
        treino: limiteTreino,
        shadow_historico: shadow,
        padroes_unicos: padroes.length,
        combinacoes_avaliadas: padroes.length * ALVOS.length,
        reprovados_ocorrencias: 0,
        reprovados_assertividade: 0,
        reprovados_shadow_historico: 0,
        blacklist_configurados: parseBlacklist(config.blacklist).size
    };

    for (const padrao of padroes) {
        for (const entrada of ALVOS) {
            const id = idCandidato(opcoes.robo_id || 0, padrao, entrada, config);
            const treino = ocorrenciasPadrao(arr, padrao, entrada, config, 0, limiteTreino);
            if (treino.ocorrencias < config.ocorr_min) { diagnostico.reprovados_ocorrencias++; continue; }
            if (treino.assertividade < config.assert_min) { diagnostico.reprovados_assertividade++; continue; }

            let shadowMetricas = null;
            let shadowOk = true;
            let quarentenaRestante = 0;

            if (shadow > 0) {
                // Inclui contexto anterior suficiente para que padrões que começam pouco antes da janela
                // possam ser avaliados, mas exige que o desfecho esteja dentro da janela sombra.
                const inicioShadowContexto = Math.max(0, limiteTreino - config.tam_max);
                const bruto = ocorrenciasPadrao(arr, padrao, entrada, config, inicioShadowContexto, arr.length);
                const resultadosShadow = bruto.resultados.filter(r => r.indice >= limiteTreino);
                const winsShadow = resultadosShadow.filter(r => r.tipo === 'GREEN' || r.tipo === 'TIE').length;
                const redsShadow = resultadosShadow.filter(r => r.tipo === 'RED').length;
                const minShadow = Math.max(1, Math.min(5, Math.ceil(config.ocorr_min * 0.25)));
                const assertShadow = resultadosShadow.length > 0 ? (winsShadow / resultadosShadow.length) * 100 : 0;
                const wilsonShadow = wilsonLowerBound(winsShadow, resultadosShadow.length) * 100;
                shadowOk = resultadosShadow.length >= minShadow
                    && assertShadow >= Math.max(config.drop_assert, config.assert_min - 10);
                quarentenaRestante = Math.max(0, minShadow - resultadosShadow.length);
                if (!shadowOk) diagnostico.reprovados_shadow_historico++;
                shadowMetricas = {
                    ocorrencias: resultadosShadow.length,
                    greens: winsShadow,
                    ties: 0,
                    reds: redsShadow,
                    assertividade: assertShadow,
                    wilson: wilsonShadow,
                    minimo: minShadow
                };
            }

            const scoreBase = scoreEstatistico(treino, config, padrao.length, incumbentes.has(id));
            let scoreFinal = scoreBase.score;
            if (shadowMetricas && shadowMetricas.ocorrencias > 0) {
                scoreFinal = (scoreBase.score * 0.80)
                    + (shadowMetricas.wilson * 0.12)
                    + (shadowMetricas.assertividade * 0.08);
            }

            candidatos.push({
                id,
                padrao,
                entrada,
                ocorrencias: treino.ocorrencias,
                greens: treino.greens,
                ties: treino.ties,
                reds: treino.reds,
                assertividade: treino.assertividade,
                recente_assertividade: treino.recente_assertividade,
                wilson: scoreBase.wilson,
                score: Math.max(0, Math.min(100, scoreFinal)),
                shadow_ok: shadowOk,
                shadow: shadowMetricas,
                quarentena_restante: quarentenaRestante,
                incumbent: incumbentes.has(id)
            });
        }
    }

    candidatos.sort((a, b) => b.score - a.score || b.ocorrencias - a.ocorrencias || a.id.localeCompare(b.id));
    Object.defineProperty(candidatos, 'diagnostico', { value: diagnostico, enumerable: false, configurable: true });
    return candidatos;
}

function descreverPadrao(padrao) {
    return (Array.isArray(padrao) ? padrao : []).map(simboloCurto).join('-');
}

function calcularStreakRed(resultados) {
    let streak = 0;
    for (let i = resultados.length - 1; i >= 0; i--) {
        if (String(resultados[i]?.tipo_resultado || '').toUpperCase() !== 'RED') break;
        streak++;
    }
    return streak;
}

function avaliarDescarteLive(resultados, config) {
    const linhas = Array.isArray(resultados) ? resultados : [];
    if (linhas.length === 0) return { descartar: false, motivo: null, assertividade: null, streak_red: 0 };

    const wins = linhas.filter(r => ['GREEN', 'TIE'].includes(String(r.tipo_resultado || '').toUpperCase())).length;
    const total = linhas.filter(r => ['GREEN', 'TIE', 'RED'].includes(String(r.tipo_resultado || '').toUpperCase())).length;
    const assertividade = total > 0 ? (wins / total) * 100 : null;
    const streakRed = calcularStreakRed(linhas);

    if (config.drop_reds > 0 && streakRed >= config.drop_reds) {
        return { descartar: true, motivo: 'DROP_REDS', assertividade, streak_red: streakRed };
    }
    if (total >= Math.max(5, config.ocorr_min) && assertividade !== null && assertividade < config.drop_assert) {
        return { descartar: true, motivo: 'DROP_ASSERT', assertividade, streak_red: streakRed };
    }
    return { descartar: false, motivo: null, assertividade, streak_red: streakRed };
}


function normalizarMetricasShadowLive(metricas = {}) {
    const ocorrencias = Math.max(0, Math.trunc(Number(metricas.ocorrencias) || 0));
    const greens = Math.max(0, Math.trunc(Number(metricas.greens) || 0));
    const ties = Math.max(0, Math.trunc(Number(metricas.ties) || 0));
    const reds = Math.max(0, Math.trunc(Number(metricas.reds) || 0));
    const vitorias = greens + ties;
    const assertividade = ocorrencias > 0 ? (vitorias / ocorrencias) * 100 : 0;
    const wilson = wilsonLowerBound(vitorias, ocorrencias) * 100;
    return { ocorrencias, greens, ties, reds, vitorias, assertividade, wilson };
}

function avaliarShadowLive(metricasBrutas, configBruta = {}) {
    const config = normalizarConfigAutoTuning(configBruta);
    const metricas = normalizarMetricasShadowLive(metricasBrutas);
    const minimo = Math.max(0, Number(config.shadow_live_ocorrencias) || 0);
    if (minimo <= 0) {
        return {
            ativo: false,
            ok: true,
            aprovado: true,
            rejeitado: false,
            concluido: true,
            minimo: 0,
            restantes: 0,
            limiar: 0,
            ...metricas
        };
    }

    const limiar = Math.max(config.drop_assert, config.assert_min - 10);
    const restantes = Math.max(0, minimo - metricas.ocorrencias);
    const concluido = metricas.ocorrencias >= minimo;
    const aprovado = concluido && metricas.assertividade >= limiar;
    const rejeitado = concluido && !aprovado;
    return {
        ativo: true,
        ok: aprovado,
        aprovado,
        rejeitado,
        concluido,
        minimo,
        restantes,
        limiar,
        ...metricas
    };
}

function combinarScoreShadowLive(scoreAnterior, metricasBrutas, assertividadeTreino) {
    const metricas = normalizarMetricasShadowLive(metricasBrutas);
    if (metricas.ocorrencias <= 0) return Math.max(0, Math.min(100, Number(scoreAnterior) || 0));

    const base = Math.max(0, Math.min(100, Number(scoreAnterior) || 0));
    const treino = Math.max(0, Math.min(100, Number(assertividadeTreino) || 0));
    const degradacao = Math.max(0, treino - metricas.assertividade - 5);
    const penalidadeDegradacao = degradacao * 0.15;
    const score = (base * 0.70) + (metricas.wilson * 0.20) + (metricas.assertividade * 0.10) - penalidadeDegradacao;
    return Math.max(0, Math.min(100, score));
}

function formatarLogDesativacaoAutoPilot(robo, motivo, quantidade) {
    const id = Number(robo?.id);
    const idTexto = Number.isFinite(id) ? String(id) : 'desconhecido';
    const nome = String(robo?.nome || 'Sem nome')
        .replace(/[\r\n\t]+/g, ' ')
        .trim() || 'Sem nome';
    const total = Math.max(0, Number(quantidade) || 0);
    const estado = motivo === 'IA_DESATIVADA'
        ? 'Auto Pilot IA desativado na configuração'
        : motivo === 'ROBO_DESATIVADO'
            ? 'Robô/Canal desativado'
            : `Auto Pilot IA em estado seguro (${String(motivo || 'MOTIVO_DESCONHECIDO')})`;

    return `🤖 Robô/Canal ${idTexto} — ${nome}: ${estado}; `
        + `${total} padrão(ões) dinâmico(s) ativo(s) desativado(s).`;
}

function criarAutoPilotService({ dbPool, estaOcupado, recarregarMemoria, notificar, log = console }) {
    if (!dbPool || typeof dbPool.query !== 'function') throw new Error('dbPool inválido para Auto Pilot IA');
    // MC22-V-A: esta instancia da IA pertence exclusivamente
    // a mesa imutavel do processo Node.
    const mesaRuntime = obterMesaRuntime();
    const mesaId = Number(mesaRuntime.id);

    if (!Number.isInteger(mesaId) || mesaId <= 0) {
        throw new Error(
            'MC22-V-A: mesa runtime invalida para Auto Pilot IA'
        );
    }

    const contadores = new Map();
    const pendenciasForcadas = new Map();
    let execucaoEmAndamento = Promise.resolve();

    const serializar = (fn) => {
        const proxima = execucaoEmAndamento.then(fn, fn);
        execucaoEmAndamento = proxima.catch(() => {});
        return proxima;
    };

    async function carregarRobo(roboId) {
        const [linhas] = await dbPool.query(
            'SELECT * FROM robos_canais WHERE id=? AND mesa_id=? LIMIT 1',
            [roboId, mesaId]
        );
        if (linhas.length === 0) return null;
        const row = linhas[0];
        let config = {};
        try { config = JSON.parse(row.config_json || '{}'); } catch (e) {}
        return { ...row, config };
    }

    async function carregarHistorico(range) {
        const [linhas] = await dbPool.query(
            `SELECT id, resultado, multiplicador, id_sessao,
                    UNIX_TIMESTAMP(data_hora) * 1000 AS timestamp_ms
             FROM giros_recentes
             WHERE mesa_id=?
             ORDER BY id DESC
             LIMIT ?`,
            [mesaId, range]
        );
        return linhas.reverse().map(r => ({
            id: Number(r.id) || 0,
            resultado: String(r.resultado || ''),
            multiplicador: String(r.multiplicador || ''),
            id_sessao: r.id_sessao,
            timestamp_ms: Number(r.timestamp_ms) || 0
        }));
    }

    async function historicoLive(ids) {
        const resultado = new Map();
        if (!Array.isArray(ids) || ids.length === 0) return resultado;
        const placeholders = ids.map(() => '?').join(',');
        const [linhas] = await dbPool.query(
            `SELECT estrategia_id, tipo_resultado, data_hora, id
             FROM historico_resultados
             WHERE mesa_id=?
               AND estrategia_id IN (${placeholders})
             ORDER BY data_hora ASC, id ASC`,
            [mesaId, ...ids]
        );
        for (const row of linhas) {
            const id = String(row.estrategia_id);
            if (!resultado.has(id)) resultado.set(id, []);
            resultado.get(id).push(row);
        }
        return resultado;
    }


    async function metricasShadowLive(ids) {
        const mapa = new Map();
        if (!Array.isArray(ids) || ids.length === 0) return mapa;
        const placeholders = ids.map(() => '?').join(',');
        const [linhas] = await dbPool.query(
            `SELECT estrategia_id,
                    COUNT(*) AS ocorrencias,
                    SUM(tipo_resultado='GREEN') AS greens,
                    SUM(tipo_resultado='TIE') AS ties,
                    SUM(tipo_resultado='RED') AS reds
             FROM historico_shadow_ia
             WHERE mesa_id=?
               AND estrategia_id IN (${placeholders})
             GROUP BY estrategia_id`,
            [mesaId, ...ids]
        );
        for (const row of linhas) {
            mapa.set(String(row.estrategia_id), normalizarMetricasShadowLive(row));
        }
        return mapa;
    }

    async function aplicarShadowLiveAosCandidatos(candidatos, config) {
        const lista = Array.isArray(candidatos) ? candidatos : [];
        const mapa = await metricasShadowLive(lista.map(c => String(c.id)));
        for (const candidato of lista) {
            candidato.shadow_historico_ok = candidato.shadow_ok === true;
            if (!candidato.shadow_historico_ok) {
                candidato.shadow_live = avaliarShadowLive({}, { ...config, shadow_live_ocorrencias: 0 });
                continue;
            }
            const avaliacao = avaliarShadowLive(mapa.get(String(candidato.id)) || {}, config);
            candidato.shadow_live = avaliacao;
            candidato.shadow_live_rejeitado = avaliacao.rejeitado === true;
            if (avaliacao.ativo) {
                candidato.shadow_ok = avaliacao.aprovado === true;
                candidato.quarentena_restante = avaliacao.concluido ? 0 : avaliacao.restantes;
                if (avaliacao.ocorrencias > 0) {
                    candidato.score = combinarScoreShadowLive(candidato.score, avaliacao, candidato.assertividade);
                }
            }
        }
        lista.sort((x, y) => y.score - x.score || y.ocorrencias - x.ocorrencias || x.id.localeCompare(y.id));
        return lista;
    }

    function logarTelemetriaMineracao(robo, config, candidatos, resumo, motivo) {
        const d = candidatos?.diagnostico || {};
        const linhas = [
            '',
            `🧠 AUTO PILOT IA ${robo.id} — ${String(motivo || 'mineração').toUpperCase()}`,
            `   Janela: ${d.janela ?? '?'} | treino: ${d.treino ?? '?'} | validação histórica: ${d.shadow_historico ?? 0}`,
            `   Padrões únicos: ${d.padroes_unicos ?? '?'} | combinações avaliadas: ${d.combinacoes_avaliadas ?? '?'}`,
            `   Reprovados: ocorrências=${d.reprovados_ocorrencias ?? 0}, assertividade=${d.reprovados_assertividade ?? 0}, shadow histórico=${d.reprovados_shadow_historico ?? 0}`,
            `   Blacklist configurada: ${d.blacklist_configurados ?? 0}`,
            `   Pool: ${resumo.ativos.length}/${config.max_padroes} ativos | ${resumo.reservas} reservas | ${resumo.shadow_historico || 0} shadow histórico | ${resumo.shadow_live || 0} shadow live | ${resumo.rejeitados_shadow_live || 0} rejeitados live | ${resumo.fora_pool || 0} fora do pool`
        ];

        if (resumo.ativos.length > 0) {
            linhas.push('   🏆 ATIVOS');
            resumo.ativos.forEach((c, i) => linhas.push(
                `      #${i + 1} ${c.padrao} → ${c.entrada} | score=${c.score.toFixed(1)} | assert=${c.assertividade.toFixed(1)}% | n=${c.ocorrencias} | Wilson=${c.wilson.toFixed(1)}%${c.shadow_live_ocorrencias > 0 ? ` | live=${c.shadow_live_assertividade.toFixed(1)}% (${c.shadow_live_ocorrencias})` : ''}`
            ));
        }
        if (Array.isArray(resumo.reservas_top) && resumo.reservas_top.length > 0) {
            linhas.push('   📦 TOP RESERVAS');
            resumo.reservas_top.forEach((c, i) => linhas.push(
                `      #${i + 1} ${c.padrao} → ${c.entrada} | score=${c.score.toFixed(1)} | assert=${c.assertividade.toFixed(1)}% | n=${c.ocorrencias}`
            ));
        }
        log.log(linhas.join('\n'));
    }

    async function registrarResultadosShadowLive(giroId) {
        const idGiro = Number(giroId);
        if (!Number.isInteger(idGiro) || idGiro <= 0) return { registrados: 0, robos: [] };

        const [linhas] = await dbPool.query(
            `SELECT e.id, e.padrao, e.entrada, e.gales, e.proteger_empate, e.robo_dono_id, r.config_json
             FROM estrategias e
             JOIN robos_canais r
               ON r.id=e.robo_dono_id
              AND r.mesa_id=e.mesa_id
             WHERE e.mesa_id=?
               AND e.is_dinamico=true
               AND e.ativo=false
               AND e.ia_status='SHADOW_LIVE'
               AND r.ativo=true`,
            [mesaId]
        );
        if (linhas.length === 0) return { registrados: 0, robos: [] };

        const historico = await carregarHistorico(16);
        if (historico.length === 0 || Number(historico[historico.length - 1]?.id) !== idGiro) {
            return { registrados: 0, robos: [] };
        }

        let registrados = 0;
        const candidatosAlterados = [];
        for (const row of linhas) {
            let configRobo = {};
            try { configRobo = JSON.parse(row.config_json || '{}'); } catch (e) {}
            const ia = normalizarConfigAutoTuning(configRobo.auto_tuning || {});
            if (!ia.ativo || ia.shadow_live_ocorrencias <= 0) continue;

            let padrao = [];
            try { padrao = JSON.parse(row.padrao || '[]'); } catch (e) {}
            if (!Array.isArray(padrao) || padrao.length === 0) continue;

            const cfgOcorrencia = { gales: Number(row.gales) || 0, proteger_empate: row.proteger_empate === true || row.proteger_empate === 1 };
            const ocorrencias = ocorrenciasPadrao(historico, padrao, row.entrada, cfgOcorrencia);
            const fechamentos = ocorrencias.resultados.filter(r => r.indice === historico.length - 1);
            if (fechamentos.length === 0) continue;
            const fechamento = fechamentos[fechamentos.length - 1];
            const ultimo = historico[historico.length - 1];
            const [resultado] = await dbPool.query(
                `INSERT IGNORE INTO historico_shadow_ia
                    (mesa_id, estrategia_id, robo_id, giro_resultado_id, tipo_resultado, nivel, multiplicador, data_hora)
                 VALUES (?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?))`,
                [
                    mesaId,
                    row.id,
                    row.robo_dono_id,
                    idGiro,
                    fechamento.tipo,
                    fechamento.nivel === 0 ? 'DIRETO' : `GALE${fechamento.nivel}`,
                    fechamento.tipo === 'TIE' ? String(ultimo.multiplicador || '') : '',
                    (Number(ultimo.timestamp_ms) || Date.now()) / 1000
                ]
            );
            if (Number(resultado.affectedRows) === 1) {
                registrados++;
                candidatosAlterados.push({ id: String(row.id), robo_id: Number(row.robo_dono_id), config: ia });
            }
        }

        if (candidatosAlterados.length === 0) return { registrados, robos: [] };
        const mapa = await metricasShadowLive(candidatosAlterados.map(c => c.id));
        const robosReavaliacao = new Set();
        for (const item of candidatosAlterados) {
            const avaliacao = avaliarShadowLive(mapa.get(item.id) || {}, item.config);
            const status = avaliacao.aprovado
                ? 'APROVADO'
                : (avaliacao.rejeitado
                    ? 'REJEITADO'
                    : `pendente (${avaliacao.restantes} restante(s))`);

            log.log(
                `👻 Shadow Live ${item.id}: ${avaliacao.ocorrencias}/${avaliacao.minimo} ocorrência(s), `
                + `assert=${avaliacao.assertividade.toFixed(1)}%, Wilson=${avaliacao.wilson.toFixed(1)}%, ${status}.`
            );

            if (avaliacao.rejeitado) {
                await dbPool.query(
                    `UPDATE estrategias
                     SET ativo=false, ia_status='REJEITADO', quarentena_restante=0
                     WHERE mesa_id=?
                       AND id=?
                       AND is_dinamico=true
                       AND robo_dono_id=?`,
                    [mesaId, item.id, item.robo_id]
                );
            }
            if (avaliacao.concluido) robosReavaliacao.add(item.robo_id);
        }
        return { registrados, robos: [...robosReavaliacao] };
    }

    async function reconciliar(robo, config, candidatos) {
        const [existentes] = await dbPool.query(
            `SELECT id, padrao, entrada, ativo, criado_em, quarentena_restante
             FROM estrategias
             WHERE mesa_id=?
               AND is_dinamico=true
               AND robo_dono_id=?`,
            [mesaId, robo.id]
        );
        const existentesMap = new Map(existentes.map(e => [String(e.id), e]));
        const incumbentesAtivos = new Set(
            existentes.filter(e => e.ativo === true || e.ativo === 1).map(e => String(e.id))
        );
        const idsLive = [...new Set([...existentesMap.keys(), ...candidatos.map(c => String(c.id))])];
        const liveMap = await historicoLive(idsLive);

        const elegiveis = candidatos.filter(c => c.shadow_ok);
        const elegiveisSemDrop = elegiveis.filter(c => {
            const live = avaliarDescarteLive(liveMap.get(c.id) || [], config);
            c.live = live;
            return !live.descartar;
        });

        // Recalcula bônus de incumbência com o estado realmente persistido.
        for (const c of elegiveisSemDrop) {
            if (!incumbentesAtivos.has(c.id) || c.incumbent) continue;
            const ajuste = scoreEstatistico(c, config, c.padrao.length, true);
            c.score = Math.min(100, c.score + ajuste.bonus_incumbente);
            c.incumbent = true;
        }

        const ativos = selecionarPortfolio(elegiveisSemDrop, config.max_padroes, config.perfil_selecao);
        const ativosIds = new Set(ativos.map(c => c.id));
        const reservas = elegiveisSemDrop
            .filter(c => !ativosIds.has(c.id))
            .slice(0, config.max_reservas);
        const rejeitadosShadowLive = candidatos
            .filter(c => c.shadow_live_rejeitado === true);
        const rejeitadosIds = new Set(rejeitadosShadowLive.map(c => String(c.id)));
        const shadowLive = candidatos
            .filter(c => c.shadow_historico_ok === true && !c.shadow_ok && !c.shadow_live_rejeitado)
            .slice(0, config.shadow_live_max_candidatos);
        const shadowHistorico = candidatos
            .filter(c => c.shadow_historico_ok === false)
            .slice(0, Math.max(config.max_padroes, Math.min(20, config.max_reservas)));
        const sombra = [...shadowLive, ...shadowHistorico];
        const reter = [...ativos, ...reservas, ...sombra];
        const reterIds = new Set(reter.map(c => c.id));
        const agora = Date.now();
        const ttlMs = config.ttl_horas * 60 * 60 * 1000;
        const tiesZerado = JSON.stringify({ direto:{}, gale1:{}, gale2:{} });
        const origem = `AUTO_PILOT_IA:${Number(robo.id)}`;
        const conexao = await dbPool.getConnection();

        try {
            await conexao.beginTransaction();

            for (const candidato of reter) {
                const existente = existentesMap.get(candidato.id);
                const criadoAnterior = Math.max(0, Number(existente?.criado_em) || 0);
                const revalidacaoVencida = criadoAnterior <= 0 || (agora - criadoAnterior) >= ttlMs;
                const criadoEm = revalidacaoVencida ? agora : criadoAnterior;
                const ativo = ativosIds.has(candidato.id) && candidato.shadow_ok;
                const status = ativo
                    ? 'ATIVO'
                    : (candidato.shadow_ok
                        ? 'RESERVA'
                        : (candidato.shadow_historico_ok === true ? 'SHADOW_LIVE' : 'SHADOW_HISTORICO')) ;
                const nome = `${robo.nome} • IA ${descreverPadrao(candidato.padrao)} → ${simboloCurto(candidato.entrada)} [${status}]`;

                await conexao.query(
                    `INSERT INTO estrategias
                        (id, mesa_id, nome, origem, padrao, entrada, gales, proteger_empate, ativo,
                         green_direto, gale1, gale2, red, ties_json,
                         is_dinamico, robo_dono_id, criado_em, quarentena_restante, ia_status)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, true, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE
                        nome=VALUES(nome), origem=VALUES(origem), padrao=VALUES(padrao),
                        entrada=VALUES(entrada), gales=VALUES(gales), proteger_empate=VALUES(proteger_empate),
                        ativo=VALUES(ativo), robo_dono_id=VALUES(robo_dono_id),
                        criado_em=VALUES(criado_em), quarentena_restante=VALUES(quarentena_restante),
                        ia_status=VALUES(ia_status)`,
                    [
                        candidato.id,
                        mesaId,
                        nome,
                        origem,
                        JSON.stringify(candidato.padrao),
                        candidato.entrada,
                        config.gales,
                        config.proteger_empate ? 1 : 0,
                        ativo ? 1 : 0,
                        tiesZerado,
                        robo.id,
                        criadoEm,
                        candidato.shadow_ok ? 0 : Math.max(1, candidato.quarentena_restante),
                        status
                    ]
                );
            }

            if (reter.length > 0) {
                const idsRetidos = [
                    ...new Set(
                        reter.map(c => String(c.id))
                    )
                ];

                const placeholdersRetidos =
                    idsRetidos.map(() => '?').join(',');

                const [ownershipRetidos] =
                    await conexao.query(
                        `SELECT id, mesa_id
                         FROM estrategias
                         WHERE id IN (${placeholdersRetidos})
                         ORDER BY id ASC
                         FOR UPDATE`,
                        idsRetidos
                    );

                if (
                    ownershipRetidos.length
                    !== idsRetidos.length
                ) {
                    throw new Error(
                        'MC22-V-A: conjunto de estrategias persistidas incompleto'
                    );
                }

                for (const estrategia of ownershipRetidos) {
                    if (
                        Number(estrategia.mesa_id)
                        !== mesaId
                    ) {
                        throw new Error(
                            `MC22-V-A: estrategia ${estrategia.id} ` +
                            `pertence a outra mesa`
                        );
                    }
                }
            }

            for (const existente of existentes) {
                const id = String(existente.id);
                if (reterIds.has(id)) continue;
                if (rejeitadosIds.has(id)) {
                    await conexao.query(
                        `UPDATE estrategias
                         SET ativo=false, ia_status='REJEITADO', quarentena_restante=0
                         WHERE mesa_id=?
                           AND id=?
                           AND is_dinamico=true
                           AND robo_dono_id=?`,
                        [mesaId, id, robo.id]
                    );
                    continue;
                }

                const criadoEm = Math.max(0, Number(existente.criado_em) || 0);
                const expirado = criadoEm <= 0 || (agora - criadoEm) >= ttlMs;
                if (expirado) {
                    // Remove somente a definição. O histórico live fica preservado pelo ID determinístico
                    // para que um padrão ruim não possa reaparecer futuramente com reputação zerada.
                    await conexao.query(
                        'DELETE FROM estrategias WHERE mesa_id=? AND id=? AND is_dinamico=true AND robo_dono_id=?',
                        [mesaId, id, robo.id]
                    );
                } else {
                    await conexao.query(
                        'UPDATE estrategias SET ativo=false WHERE mesa_id=? AND id=? AND is_dinamico=true AND robo_dono_id=?',
                        [mesaId, id, robo.id]
                    );
                }
            }

            await conexao.commit();
        } catch (e) {
            try { await conexao.rollback(); } catch (rollbackErro) {
                log.error('Auto Pilot IA: rollback falhou:', rollbackErro.message);
            }
            throw e;
        } finally {
            conexao.release();
        }

        const resumoCandidato = c => ({
            id: c.id,
            padrao: descreverPadrao(c.padrao),
            entrada: simboloCurto(c.entrada),
            score: Number(c.score) || 0,
            assertividade: Number(c.assertividade) || 0,
            ocorrencias: Number(c.ocorrencias) || 0,
            wilson: Number(c.wilson) || 0,
            shadow_live_ocorrencias: Number(c.shadow_live?.ocorrencias) || 0,
            shadow_live_assertividade: Number(c.shadow_live?.assertividade) || 0
        });
        return {
            ativos: ativos.map(resumoCandidato),
            reservas: reservas.length,
            reservas_top: reservas.slice(0, 5).map(resumoCandidato),
            sombra: sombra.length,
            shadow_historico: shadowHistorico.length,
            shadow_live: shadowLive.length,
            rejeitados_shadow_live: rejeitadosShadowLive.length,
            fora_pool: Math.max(0, candidatos.length - reter.length - rejeitadosShadowLive.length),
            candidatos: candidatos.length
        };
    }

    async function desativarPadroesRobo(robo, motivo) {
        const [resultado] = await dbPool.query(
            `UPDATE estrategias SET ativo=false
             WHERE mesa_id=?
               AND is_dinamico=true
               AND robo_dono_id=?
               AND ativo=true`,
            [mesaId, robo.id]
        );
        const desativados = Math.max(0, Number(resultado.affectedRows) || 0);
        contadores.set(Number(robo.id), 0);
        const resumo = { ativos: [], reservas: 0, sombra: 0, candidatos: 0, desativados };

        if (desativados > 0 && typeof recarregarMemoria === 'function') {
            await recarregarMemoria();
        }
        if (desativados > 0 && typeof notificar === 'function') {
            notificar(robo.id, resumo);
        }

        log.log(formatarLogDesativacaoAutoPilot(robo, motivo, desativados));
        return { executado: true, desativado: true, motivo, ...resumo };
    }

    async function executarRoboInterno(roboId, { forcar = false, motivo = 'trigger' } = {}) {
        const idNumerico = Number(roboId);
        if (typeof estaOcupado === 'function' && estaOcupado()) {
            if (forcar && Number.isFinite(idNumerico)) {
                pendenciasForcadas.set(idNumerico, String(motivo || 'forcado'));
            }
            return { executado: false, adiado: true, motivo: 'SINAL_EM_ANDAMENTO' };
        }

        if (Number.isFinite(idNumerico)) pendenciasForcadas.delete(idNumerico);
        const robo = await carregarRobo(roboId);
        if (!robo) return { executado: false, motivo: 'ROBO_INEXISTENTE' };
        const config = normalizarConfigAutoTuning(robo.config?.auto_tuning || {});
        const roboAtivo = robo.ativo === true || robo.ativo === 1;
        if (!roboAtivo) return desativarPadroesRobo(robo, 'ROBO_DESATIVADO');
        if (!config.ativo) return desativarPadroesRobo(robo, 'IA_DESATIVADA');

        const atual = Math.max(0, Number(contadores.get(Number(robo.id))) || 0);
        if (!forcar && atual < config.trigger) {
            return { executado: false, motivo: 'TRIGGER_NAO_ATINGIDO', atual, trigger: config.trigger };
        }

        const [existentes] = await dbPool.query(
            'SELECT id FROM estrategias WHERE mesa_id=? AND is_dinamico=true AND robo_dono_id=? AND ativo=true',
            [mesaId, robo.id]
        );
        const historico = await carregarHistorico(config.range);
        const candidatos = minerarCandidatos(historico, config, {
            robo_id: robo.id,
            incumbentes: existentes.map(e => String(e.id))
        });
        await aplicarShadowLiveAosCandidatos(candidatos, config);
        const resumo = await reconciliar(robo, config, candidatos);
        contadores.set(Number(robo.id), 0);

        if (typeof recarregarMemoria === 'function') await recarregarMemoria();
        if (typeof notificar === 'function') notificar(robo.id, resumo);
        logarTelemetriaMineracao(robo, config, candidatos, resumo, motivo);
        return { executado: true, config, ...resumo };
    }

    function executarRobo(roboId, opcoes = {}) {
        return serializar(() => executarRoboInterno(Number(roboId), opcoes));
    }

    async function executarTodosInterno(opcoes = {}) {
        if (typeof estaOcupado === 'function' && estaOcupado()) {
            if (opcoes.forcar) {
                const [todosRobos] = await dbPool.query(
                    'SELECT id FROM robos_canais WHERE mesa_id=?',
                    [mesaId]
                );
                for (const row of todosRobos) {
                    pendenciasForcadas.set(Number(row.id), String(opcoes.motivo || 'forcado'));
                }
            }
            return { executado: false, adiado: true, motivo: 'SINAL_EM_ANDAMENTO' };
        }

        const sqlRobos = opcoes.forcar
            ? 'SELECT id, ativo, config_json FROM robos_canais WHERE mesa_id=?'
            : 'SELECT id, ativo, config_json FROM robos_canais WHERE mesa_id=? AND ativo=true';
        const [robos] = await dbPool.query(sqlRobos, [mesaId]);
        const saida = [];
        for (const row of robos) {
            let config = {};
            try { config = JSON.parse(row.config_json || '{}'); } catch (e) {}
            if (!opcoes.forcar && !(config.auto_tuning?.ativo === true || config.auto_tuning?.ativo === 1)) continue;
            saida.push(await executarRoboInterno(row.id, opcoes));
        }
        return { executado: true, robos: saida };
    }

    function executarTodos(opcoes = {}) {
        return serializar(() => executarTodosInterno(opcoes));
    }

    async function registrarNovoGiro(contexto = {}) {
        const resultadoShadow = await registrarResultadosShadowLive(contexto.giro_id);
        if (resultadoShadow.robos.length > 0) {
            for (const roboId of resultadoShadow.robos) {
                if (typeof estaOcupado === 'function' && estaOcupado()) {
                    pendenciasForcadas.set(Number(roboId), 'shadow_live_aprovado');
                } else {
                    await executarRobo(roboId, { forcar: true, motivo: 'shadow_live_aprovado' });
                }
            }
        }
        const ocupadoAgora = typeof estaOcupado === 'function' && estaOcupado();
        if (!ocupadoAgora && pendenciasForcadas.size > 0) {
            const pendentes = [...pendenciasForcadas.entries()];
            for (const [roboId, motivo] of pendentes) {
                await executarRobo(roboId, { forcar: true, motivo: `pendente:${motivo}` });
            }
        }

        const [robos] = await dbPool.query(
            'SELECT id, config_json FROM robos_canais WHERE mesa_id=? AND ativo=true',
            [mesaId]
        );
        let haDevido = false;
        for (const row of robos) {
            let config = {};
            try { config = JSON.parse(row.config_json || '{}'); } catch (e) {}
            const ia = normalizarConfigAutoTuning(config.auto_tuning || {});
            if (!ia.ativo) continue;
            const proximo = (Math.max(0, Number(contadores.get(Number(row.id))) || 0) + 1);
            contadores.set(Number(row.id), proximo);
            if (proximo >= ia.trigger) haDevido = true;
        }

        if (!haDevido) return { executado: false, motivo: 'NENHUM_TRIGGER_ATINGIDO' };
        if (typeof estaOcupado === 'function' && estaOcupado()) {
            return { executado: false, adiado: true, motivo: 'SINAL_EM_ANDAMENTO' };
        }

        return executarTodos({ forcar: false, motivo: 'trigger' });
    }

    function reavaliarDescarteEstrategia(estrategiaId) {
        return serializar(async () => {
            if (typeof estaOcupado === 'function' && estaOcupado()) {
                return { executado: false, adiado: true, motivo: 'SINAL_EM_ANDAMENTO' };
            }

            const id = String(estrategiaId || '').trim();
            if (!id) return { executado: false, motivo: 'ESTRATEGIA_INVALIDA' };
            const [linhas] = await dbPool.query(
                `SELECT e.id, e.robo_dono_id, e.ativo, r.ativo AS robo_ativo, r.config_json
                 FROM estrategias e
                 JOIN robos_canais r
                   ON r.id=e.robo_dono_id
                  AND r.mesa_id=e.mesa_id
                 WHERE e.mesa_id=?
                   AND e.id=?
                   AND e.is_dinamico=true
                 LIMIT 1`,
                [mesaId, id]
            );
            if (linhas.length === 0) return { executado: false, motivo: 'ESTRATEGIA_DINAMICA_INEXISTENTE' };

            const row = linhas[0];
            let configRobo = {};
            try { configRobo = JSON.parse(row.config_json || '{}'); } catch (e) {}
            const config = normalizarConfigAutoTuning(configRobo.auto_tuning || {});
            const mapaLive = await historicoLive([id]);
            const avaliacao = avaliarDescarteLive(mapaLive.get(id) || [], config);
            if (!avaliacao.descartar) {
                return { executado: true, descartado: false, avaliacao };
            }

            await dbPool.query(
                'UPDATE estrategias SET ativo=false WHERE mesa_id=? AND id=? AND is_dinamico=true',
                [mesaId, id]
            );
            if (typeof recarregarMemoria === 'function') await recarregarMemoria();
            log.warn(
                `🗑️ Auto Pilot IA: padrão ${id} desativado imediatamente por ${avaliacao.motivo} `
                + `(assertividade live=${avaliacao.assertividade === null ? 'n/a' : avaliacao.assertividade.toFixed(1)}%, `
                + `streak RED=${avaliacao.streak_red}).`
            );

            const promocao = await executarRoboInterno(
                Number(row.robo_dono_id),
                { forcar: true, motivo: `descarte_live:${avaliacao.motivo}` }
            );
            return { executado: true, descartado: true, avaliacao, promocao };
        });
    }

    function resetarContador(roboId) {
        contadores.set(Number(roboId), 0);
    }

    return {
        executarRobo,
        executarTodos,
        registrarNovoGiro,
        reavaliarDescarteEstrategia,
        resetarContador
    };
}

module.exports = {
    normalizarConfigAutoTuning,
    parseBlacklist,
    padraoCanonico,
    wilsonLowerBound,
    ocorrenciasPadrao,
    scoreEstatistico,
    similaridadePadroes,
    selecionarPortfolio,
    minerarCandidatos,
    avaliarDescarteLive,
    avaliarShadowLive,
    combinarScoreShadowLive,
    formatarLogDesativacaoAutoPilot,
    criarAutoPilotService,
    idCandidato
};
