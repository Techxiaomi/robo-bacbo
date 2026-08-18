'use strict';

const crypto = require('crypto');

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

    for (const padrao of padroes) {
        for (const entrada of ALVOS) {
            const id = idCandidato(opcoes.robo_id || 0, padrao, entrada, config);
            const treino = ocorrenciasPadrao(arr, padrao, entrada, config, 0, limiteTreino);
            if (treino.ocorrencias < config.ocorr_min || treino.assertividade < config.assert_min) continue;

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

    return candidatos.sort((a, b) => b.score - a.score || b.ocorrencias - a.ocorrencias || a.id.localeCompare(b.id));
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

function criarAutoPilotService({ dbPool, estaOcupado, recarregarMemoria, notificar, log = console }) {
    if (!dbPool || typeof dbPool.query !== 'function') throw new Error('dbPool inválido para Auto Pilot IA');
    const contadores = new Map();
    let execucaoEmAndamento = Promise.resolve();

    const serializar = (fn) => {
        const proxima = execucaoEmAndamento.then(fn, fn);
        execucaoEmAndamento = proxima.catch(() => {});
        return proxima;
    };

    async function carregarRobo(roboId) {
        const [linhas] = await dbPool.query('SELECT * FROM robos_canais WHERE id=? LIMIT 1', [roboId]);
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
             ORDER BY id DESC
             LIMIT ?`,
            [range]
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
             WHERE estrategia_id IN (${placeholders})
             ORDER BY data_hora ASC, id ASC`,
            ids
        );
        for (const row of linhas) {
            const id = String(row.estrategia_id);
            if (!resultado.has(id)) resultado.set(id, []);
            resultado.get(id).push(row);
        }
        return resultado;
    }

    async function reconciliar(robo, config, candidatos) {
        const [existentes] = await dbPool.query(
            `SELECT id, padrao, entrada, ativo, criado_em, quarentena_restante
             FROM estrategias
             WHERE is_dinamico=true AND robo_dono_id=?`,
            [robo.id]
        );
        const existentesMap = new Map(existentes.map(e => [String(e.id), e]));
        const incumbentesAtivos = new Set(
            existentes.filter(e => e.ativo === true || e.ativo === 1).map(e => String(e.id))
        );
        const liveMap = await historicoLive([...existentesMap.keys()]);

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
        const sombra = candidatos
            .filter(c => !c.shadow_ok)
            .slice(0, Math.max(config.max_padroes, Math.min(20, config.max_reservas)));
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
                const status = ativo ? 'ATIVO' : (candidato.shadow_ok ? 'RESERVA' : 'SOMBRA');
                const nome = `${robo.nome} • IA ${descreverPadrao(candidato.padrao)} → ${simboloCurto(candidato.entrada)} [${status}]`;

                await conexao.query(
                    `INSERT INTO estrategias
                        (id, nome, origem, padrao, entrada, gales, proteger_empate, ativo,
                         green_direto, gale1, gale2, red, ties_json,
                         is_dinamico, robo_dono_id, criado_em, quarentena_restante)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, true, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE
                        nome=VALUES(nome), origem=VALUES(origem), padrao=VALUES(padrao),
                        entrada=VALUES(entrada), gales=VALUES(gales), proteger_empate=VALUES(proteger_empate),
                        ativo=VALUES(ativo), robo_dono_id=VALUES(robo_dono_id),
                        criado_em=VALUES(criado_em), quarentena_restante=VALUES(quarentena_restante)`,
                    [
                        candidato.id,
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
                        candidato.shadow_ok ? 0 : Math.max(1, candidato.quarentena_restante)
                    ]
                );
            }

            for (const existente of existentes) {
                const id = String(existente.id);
                if (reterIds.has(id)) continue;

                const criadoEm = Math.max(0, Number(existente.criado_em) || 0);
                const expirado = criadoEm <= 0 || (agora - criadoEm) >= ttlMs;
                if (expirado) {
                    await conexao.query('DELETE FROM historico_resultados WHERE estrategia_id=?', [id]);
                    await conexao.query('DELETE FROM historico_disparos_robos WHERE estrategia_id=?', [id]);
                    await conexao.query('DELETE FROM estrategias WHERE id=? AND is_dinamico=true AND robo_dono_id=?', [id, robo.id]);
                } else {
                    await conexao.query('UPDATE estrategias SET ativo=false WHERE id=? AND is_dinamico=true AND robo_dono_id=?', [id, robo.id]);
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

        return {
            ativos: ativos.map(c => ({ id: c.id, score: c.score, assertividade: c.assertividade, ocorrencias: c.ocorrencias })),
            reservas: reservas.length,
            sombra: sombra.length,
            candidatos: candidatos.length
        };
    }

    async function executarRoboInterno(roboId, { forcar = false, motivo = 'trigger' } = {}) {
        if (typeof estaOcupado === 'function' && estaOcupado()) {
            return { executado: false, adiado: true, motivo: 'SINAL_EM_ANDAMENTO' };
        }

        const robo = await carregarRobo(roboId);
        if (!robo) return { executado: false, motivo: 'ROBO_INEXISTENTE' };
        const config = normalizarConfigAutoTuning(robo.config?.auto_tuning || {});
        if (!config.ativo) return { executado: false, motivo: 'IA_DESATIVADA' };

        const atual = Math.max(0, Number(contadores.get(Number(robo.id))) || 0);
        if (!forcar && atual < config.trigger) {
            return { executado: false, motivo: 'TRIGGER_NAO_ATINGIDO', atual, trigger: config.trigger };
        }

        const [existentes] = await dbPool.query(
            'SELECT id FROM estrategias WHERE is_dinamico=true AND robo_dono_id=? AND ativo=true',
            [robo.id]
        );
        const historico = await carregarHistorico(config.range);
        const candidatos = minerarCandidatos(historico, config, {
            robo_id: robo.id,
            incumbentes: existentes.map(e => String(e.id))
        });
        const resumo = await reconciliar(robo, config, candidatos);
        contadores.set(Number(robo.id), 0);

        if (typeof recarregarMemoria === 'function') await recarregarMemoria();
        if (typeof notificar === 'function') notificar(robo.id, resumo);
        log.log(
            `🤖 Auto Pilot IA ${robo.id} (${motivo}): ${resumo.candidatos} candidato(s), `
            + `${resumo.ativos.length}/${config.max_padroes} ativo(s), ${resumo.reservas} reserva(s), ${resumo.sombra} sombra.`
        );
        return { executado: true, config, ...resumo };
    }

    function executarRobo(roboId, opcoes = {}) {
        return serializar(() => executarRoboInterno(Number(roboId), opcoes));
    }

    async function executarTodosInterno(opcoes = {}) {
        if (typeof estaOcupado === 'function' && estaOcupado()) {
            return { executado: false, adiado: true, motivo: 'SINAL_EM_ANDAMENTO' };
        }
        const [robos] = await dbPool.query('SELECT id, config_json FROM robos_canais WHERE ativo=true');
        const saida = [];
        for (const row of robos) {
            let config = {};
            try { config = JSON.parse(row.config_json || '{}'); } catch (e) {}
            if (!(config.auto_tuning?.ativo === true || config.auto_tuning?.ativo === 1)) continue;
            saida.push(await executarRoboInterno(row.id, opcoes));
        }
        return { executado: true, robos: saida };
    }

    function executarTodos(opcoes = {}) {
        return serializar(() => executarTodosInterno(opcoes));
    }

    async function registrarNovoGiro() {
        const [robos] = await dbPool.query('SELECT id, config_json FROM robos_canais WHERE ativo=true');
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

    function resetarContador(roboId) {
        contadores.set(Number(roboId), 0);
    }

    return { executarRobo, executarTodos, registrarNovoGiro, resetarContador };
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
    criarAutoPilotService,
    idCandidato
};
