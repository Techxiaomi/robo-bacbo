'use strict';

const crypto = require('crypto');
const express = require('express');

// Mantém a integração financeira/ledger existente e concentra aqui a autoridade
// da RAM canônica ROAD consumida pelo detector live.
const expressJsonNativo = express.json;
const integracaoLegada = require('./bug051b_integration_legacy');
const expressJsonLegado = express.json;

const EXPRESS_JSON_HARD_RESET_INSTALADO = Symbol.for('robo-bacbo.road-hard-reset.express-json');
const ORIENTACAO_ROAD = Object.freeze({
    OLD_TO_NEW: 'OLD_TO_NEW',
    NEW_TO_OLD: 'NEW_TO_OLD'
});
const LIMITE_HISTORY_CANONICO = 1000;
const MOTIVO_FALHA_ENVIO_RESULTADO_NODE = 'FALHA_ENVIO_RESULTADO_NODE';
const MOTIVO_SOBREPOSICAO_AMBIGUA = 'SOBREPOSICAO_AMBIGUA';

const estadoRoadCanonico = {
    pronto: false,
    orientacao: null,
    orientacao_conhecida: null,
    history: [],
    coletor_sessao: null,
    snapshot_timestamp: null,
    atualizado_em: null,
    ultimo_coletor_seq: null,
    hard_reset_pendente: false,
    hard_reset_motivo: null,
    hard_reset_desde: null,
    snapshot_pendente: null
};

function tokenInternoValidoRoad(req) {
    const recebido = Buffer.from(String(req?.get?.('X-Internal-Token') || ''), 'utf8');
    const esperado = Buffer.from(String(process.env.INTERNAL_API_TOKEN || '').trim(), 'utf8');
    return esperado.length > 0
        && recebido.length === esperado.length
        && crypto.timingSafeEqual(recebido, esperado);
}

function numeroRoad(valor) {
    if (valor === undefined || valor === null || valor === '') return null;
    const numero = Number(valor);
    return Number.isFinite(numero) ? numero : null;
}

function sequenciaColetorRoad(valor) {
    const numero = Number(valor);
    return Number.isSafeInteger(numero) && numero > 0 ? numero : null;
}

function normalizarWinnerRoad(valor) {
    const bruto = String(valor || '').trim().toUpperCase();
    if (!bruto) return null;
    if (bruto.includes('PLAYER') || bruto === 'P' || bruto === 'AZUL') return 'PlayerWon';
    if (bruto.includes('BANKER') || bruto === 'B' || bruto === 'VERMELHO') return 'BankerWon';
    if (bruto.includes('TIE') || bruto === 'T' || bruto === 'EMPATE') return 'Tie';
    return null;
}

function resultadoLiveRoad(valor) {
    const winner = normalizarWinnerRoad(valor);
    if (winner === 'PlayerWon') return 'Player';
    if (winner === 'BankerWon') return 'Banker';
    if (winner === 'Tie') return 'Tie';
    return null;
}

function scoresCoerentesRoad(winner, playerScore, bankerScore) {
    if (!Number.isInteger(playerScore) || !Number.isInteger(bankerScore)) return false;
    if (playerScore < 0 || playerScore > 12 || bankerScore < 0 || bankerScore > 12) return false;
    if (winner === 'PlayerWon') return playerScore > bankerScore;
    if (winner === 'BankerWon') return bankerScore > playerScore;
    if (winner === 'Tie') return playerScore === bankerScore;
    return false;
}

function normalizarItemHistoryRoad(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const winner = normalizarWinnerRoad(item.winner);
    const playerScore = numeroRoad(item.playerScore);
    const bankerScore = numeroRoad(item.bankerScore);
    if (!winner || playerScore === null || bankerScore === null) return null;
    if (!scoresCoerentesRoad(winner, playerScore, bankerScore)) return null;

    const normalizado = { winner, playerScore, bankerScore };
    const roundId = String(item.roundId || item.round_id || '').trim();
    const coletorSeq = sequenciaColetorRoad(item.coletorSeq || item.coletor_seq);
    const timestamp = numeroRoad(item.timestamp_ms ?? item.timestamp);
    if (roundId) normalizado.roundId = roundId.slice(0, 128);
    if (coletorSeq !== null) normalizado.coletorSeq = coletorSeq;
    if (timestamp !== null && timestamp > 0) normalizado.timestamp = Math.trunc(timestamp);
    return normalizado;
}

function somarDadosRoad(valores) {
    if (!Array.isArray(valores) || valores.length === 0) return null;
    let total = 0;
    for (const valor of valores) {
        const numero = numeroRoad(valor);
        if (numero === null) return null;
        total += numero;
    }
    return total;
}

function primeiroNumeroRoad(candidatos) {
    for (const candidato of candidatos) {
        const numero = numeroRoad(candidato);
        if (numero !== null) return numero;
    }
    return null;
}

function normalizarGiroIncrementalRoad(dados) {
    if (!dados || typeof dados !== 'object') return null;
    const scores = dados.scores && typeof dados.scores === 'object' ? dados.scores : {};
    const winner = normalizarWinnerRoad(dados.winner || dados.vencedor || dados.resultado);
    const playerScore = primeiroNumeroRoad([
        dados.playerScore,
        dados.player_score,
        scores.playerScore,
        scores.player,
        dados.pontos_jogador,
        somarDadosRoad(dados.dados_jogador)
    ]);
    const bankerScore = primeiroNumeroRoad([
        dados.bankerScore,
        dados.banker_score,
        scores.bankerScore,
        scores.banker,
        dados.pontos_banca,
        somarDadosRoad(dados.dados_banca)
    ]);
    if (!winner || playerScore === null || bankerScore === null) return null;
    if (!scoresCoerentesRoad(winner, playerScore, bankerScore)) return null;

    const giro = { winner, playerScore, bankerScore };
    const roundId = String(dados.rodada_origem || dados.round_id || '').trim();
    const coletorSeq = sequenciaColetorRoad(dados.coletor_seq);
    const timestamp = Number(dados.timestamp_coleta);
    if (roundId) giro.roundId = roundId.slice(0, 128);
    if (coletorSeq !== null) giro.coletorSeq = coletorSeq;
    if (Number.isFinite(timestamp) && timestamp > 0) giro.timestamp = Math.trunc(timestamp);
    return giro;
}

function mesmoGiroRoad(a, b) {
    return Boolean(a && b)
        && normalizarWinnerRoad(a.winner) === normalizarWinnerRoad(b.winner)
        && numeroRoad(a.playerScore) === numeroRoad(b.playerScore)
        && numeroRoad(a.bankerScore) === numeroRoad(b.bankerScore);
}

function orientacaoRoadValida(valor) {
    return valor === ORIENTACAO_ROAD.OLD_TO_NEW || valor === ORIENTACAO_ROAD.NEW_TO_OLD;
}

function normalizarOrientacaoDeclaradaRoad(dados) {
    const valor = String(dados?.orientacao || dados?.history_orientacao || '').trim().toUpperCase();
    if (valor === ORIENTACAO_ROAD.OLD_TO_NEW || valor === 'DIRETA') return ORIENTACAO_ROAD.OLD_TO_NEW;
    if (valor === ORIENTACAO_ROAD.NEW_TO_OLD || valor === 'INVERSA') return ORIENTACAO_ROAD.NEW_TO_OLD;
    return null;
}

function inferirOrientacaoPorSequenciaRoad(history) {
    const itens = Array.isArray(history) ? history : [];
    if (itens.length < 2) return null;
    const sequencias = itens.map(item => sequenciaColetorRoad(item?.coletorSeq));
    if (sequencias.some(seq => seq === null)) return null;

    let crescente = true;
    let decrescente = true;
    for (let i = 1; i < sequencias.length; i++) {
        if (sequencias[i] <= sequencias[i - 1]) crescente = false;
        if (sequencias[i] >= sequencias[i - 1]) decrescente = false;
    }
    if (crescente === decrescente) return null;
    return crescente ? ORIENTACAO_ROAD.OLD_TO_NEW : ORIENTACAO_ROAD.NEW_TO_OLD;
}

function historyCronologicoRoad(history, orientacao) {
    const itens = Array.isArray(history) ? history : [];
    if (orientacao === ORIENTACAO_ROAD.OLD_TO_NEW) return [...itens];
    if (orientacao === ORIENTACAO_ROAD.NEW_TO_OLD) return [...itens].reverse();
    return [];
}

function snapshotTemSequenciaCronologicaValida(history, orientacao) {
    const cronologico = historyCronologicoRoad(history, orientacao);
    const sequencias = cronologico.map(item => sequenciaColetorRoad(item?.coletorSeq));
    const informadas = sequencias.filter(seq => seq !== null);
    if (informadas.length === 0) return true;
    if (informadas.length !== sequencias.length) return false;
    for (let i = 1; i < sequencias.length; i++) {
        if (sequencias[i] <= sequencias[i - 1]) return false;
    }
    return true;
}

function pontaNovaEstadoCanonico() {
    if (!estadoRoadCanonico.pronto || estadoRoadCanonico.history.length === 0) return null;
    if (estadoRoadCanonico.orientacao === ORIENTACAO_ROAD.NEW_TO_OLD) {
        return estadoRoadCanonico.history[0];
    }
    return estadoRoadCanonico.history[estadoRoadCanonico.history.length - 1];
}

function logRoadReady(origem) {
    if (!estadoRoadCanonico.pronto) return;
    const ponta = pontaNovaEstadoCanonico();
    if (!ponta) return;
    console.log(
        `🧠 CORE ROAD | READY ${origem || 'snapshot'} | orientação=${estadoRoadCanonico.orientacao} | `
        + `rodadas=${estadoRoadCanonico.history.length} | último=${ponta.winner}:${ponta.playerScore}x${ponta.bankerScore}`
    );
}

function iniciarHardResetRoad(motivo, sessao = null) {
    const orientacaoAnterior = orientacaoRoadValida(estadoRoadCanonico.orientacao)
        ? estadoRoadCanonico.orientacao
        : estadoRoadCanonico.orientacao_conhecida;
    if (orientacaoRoadValida(orientacaoAnterior)) {
        estadoRoadCanonico.orientacao_conhecida = orientacaoAnterior;
    }

    estadoRoadCanonico.pronto = false;
    estadoRoadCanonico.orientacao = null;
    estadoRoadCanonico.history = [];
    estadoRoadCanonico.snapshot_timestamp = null;
    estadoRoadCanonico.atualizado_em = Date.now();
    estadoRoadCanonico.ultimo_coletor_seq = null;
    estadoRoadCanonico.hard_reset_pendente = true;
    estadoRoadCanonico.hard_reset_motivo = String(motivo || 'CONTINUIDADE_INDETERMINADA').slice(0, 160);
    estadoRoadCanonico.hard_reset_desde = Date.now();
    estadoRoadCanonico.snapshot_pendente = null;
    if (sessao !== null && String(sessao).trim()) {
        estadoRoadCanonico.coletor_sessao = String(sessao).trim();
    }

    console.warn(
        `🧹 CORE ROAD | HARD RESET | ${estadoRoadCanonico.hard_reset_motivo} | `
        + 'RAM canônica zerada; incrementais bloqueados até snapshot completo validado.'
    );
}

function substituirPorSnapshotCompleto(dados, historyNormalizado) {
    const sessao = String(dados?.coletor_sessao || '').trim();
    const timestamp = Number(dados?.timestamp_coleta);
    const orientacaoDeclarada = normalizarOrientacaoDeclaradaRoad(dados);
    const orientacaoPorSequencia = inferirOrientacaoPorSequenciaRoad(historyNormalizado);
    const orientacaoConhecida = orientacaoRoadValida(estadoRoadCanonico.orientacao_conhecida)
        ? estadoRoadCanonico.orientacao_conhecida
        : null;
    const orientacaoSegura = orientacaoDeclarada || orientacaoPorSequencia || orientacaoConhecida;
    const hardResetAtivo = estadoRoadCanonico.hard_reset_pendente === true;

    if (!orientacaoRoadValida(orientacaoSegura)) {
        estadoRoadCanonico.pronto = false;
        estadoRoadCanonico.orientacao = null;
        estadoRoadCanonico.history = [];
        estadoRoadCanonico.snapshot_timestamp = null;
        estadoRoadCanonico.atualizado_em = Date.now();
        estadoRoadCanonico.ultimo_coletor_seq = null;

        if (hardResetAtivo) {
            estadoRoadCanonico.snapshot_pendente = null;
            console.warn(
                '⛔ CORE ROAD | hard reset recebeu snapshot sem orientação verificável; '
                + 'RAM continua vazia e incrementais permanecem proibidos até outro snapshot completo.'
            );
            return { pronto: false, orientacao: null, pendente_orientacao: true };
        }

        estadoRoadCanonico.snapshot_pendente = {
            dados: { ...dados },
            history: historyNormalizado.map(item => ({ ...item }))
        };
        console.warn(
            '⏳ CORE ROAD | inicialização aguardando confirmação de orientação do snapshot; '
            + 'nenhum item foi publicado na RAM canônica.'
        );
        return { pronto: false, orientacao: null, pendente_orientacao: true };
    }

    if (!snapshotTemSequenciaCronologicaValida(historyNormalizado, orientacaoSegura)) {
        iniciarHardResetRoad('snapshot rejeitado por sequência cronológica inconsistente', sessao);
        return { pronto: false, orientacao: null, pendente_orientacao: true };
    }

    // Commit atômico do snapshot: somente depois de todas as validações o array
    // canônico recebe a nova fotografia. Nada do histórico anterior é preservado.
    const snapshotNovo = historyNormalizado.map(item => ({ ...item }));
    estadoRoadCanonico.pronto = false;
    estadoRoadCanonico.orientacao = orientacaoSegura;
    estadoRoadCanonico.history = snapshotNovo;
    estadoRoadCanonico.coletor_sessao = sessao;
    estadoRoadCanonico.snapshot_timestamp = Math.trunc(timestamp);
    estadoRoadCanonico.atualizado_em = Date.now();
    estadoRoadCanonico.ultimo_coletor_seq = sequenciaColetorRoad(dados?.coletor_seq);
    estadoRoadCanonico.orientacao_conhecida = orientacaoSegura;
    estadoRoadCanonico.snapshot_pendente = null;
    estadoRoadCanonico.hard_reset_pendente = false;
    estadoRoadCanonico.hard_reset_motivo = null;
    estadoRoadCanonico.hard_reset_desde = null;
    estadoRoadCanonico.pronto = true;
    logRoadReady(hardResetAtivo ? 'snapshot-hard-reset' : 'snapshot');
    return { pronto: true, orientacao: orientacaoSegura, pendente_orientacao: false };
}

function confirmarOrientacaoInicialComIncremental(dados, giro) {
    const pendente = estadoRoadCanonico.snapshot_pendente;
    if (!pendente || !giro || estadoRoadCanonico.hard_reset_pendente) return false;
    const history = pendente.history;
    if (!Array.isArray(history) || history.length === 0) return false;

    const primeiro = history[0];
    const ultimo = history[history.length - 1];
    const batePrimeiro = mesmoGiroRoad(giro, primeiro);
    const bateUltimo = mesmoGiroRoad(giro, ultimo);

    if (batePrimeiro === bateUltimo) {
        if (batePrimeiro) {
            iniciarHardResetRoad(
                MOTIVO_SOBREPOSICAO_AMBIGUA,
                String(dados?.coletor_sessao || '').trim() || estadoRoadCanonico.coletor_sessao
            );
        }
        return false;
    }

    const orientacao = batePrimeiro
        ? ORIENTACAO_ROAD.NEW_TO_OLD
        : ORIENTACAO_ROAD.OLD_TO_NEW;
    if (!snapshotTemSequenciaCronologicaValida(history, orientacao)) {
        iniciarHardResetRoad('snapshot inicial rejeitado após confirmação de orientação', dados?.coletor_sessao);
        return false;
    }

    const dadosSnapshot = pendente.dados || {};
    const snapshotNovo = history.map(item => ({ ...item }));
    estadoRoadCanonico.orientacao = orientacao;
    estadoRoadCanonico.orientacao_conhecida = orientacao;
    estadoRoadCanonico.history = snapshotNovo;
    estadoRoadCanonico.coletor_sessao = String(dadosSnapshot.coletor_sessao || dados?.coletor_sessao || '').trim();
    estadoRoadCanonico.snapshot_timestamp = Math.trunc(Number(dadosSnapshot.timestamp_coleta) || Date.now());
    estadoRoadCanonico.atualizado_em = Date.now();
    estadoRoadCanonico.ultimo_coletor_seq = sequenciaColetorRoad(dadosSnapshot.coletor_seq);
    estadoRoadCanonico.snapshot_pendente = null;
    estadoRoadCanonico.pronto = true;
    logRoadReady('orientação-inicial-confirmada');
    return true;
}

function processarIncrementalCanonico(req) {
    if (req.method !== 'POST' || req.path !== '/receber-sinal') return false;
    if (!tokenInternoValidoRoad(req)) return false;
    const dados = req.body && typeof req.body === 'object' ? req.body : {};

    const interrupcaoFluxo = dados.interrupcao_fluxo === true || dados.interrupcao_fluxo === 1;
    const motivoInterrupcao = String(dados.motivo_interrupcao || '').trim().toUpperCase();
    if (interrupcaoFluxo && motivoInterrupcao === MOTIVO_FALHA_ENVIO_RESULTADO_NODE) {
        iniciarHardResetRoad(
            MOTIVO_FALHA_ENVIO_RESULTADO_NODE,
            String(dados.coletor_sessao || '').trim() || estadoRoadCanonico.coletor_sessao
        );
        return false;
    }

    const giro = normalizarGiroIncrementalRoad(dados);
    if (!giro) return false;

    const sessao = String(dados.coletor_sessao || '').trim();
    if (
        estadoRoadCanonico.coletor_sessao
        && sessao
        && sessao !== estadoRoadCanonico.coletor_sessao
    ) {
        iniciarHardResetRoad('sessão incremental divergiu do snapshot canônico', sessao);
        return false;
    }

    // Regra crítica: depois de FALHA_ENVIO_RESULTADO_NODE, sobreposição ambígua,
    // salto de sequência ou troca de sessão, nenhum incremental pode orientar,
    // completar ou anexar qualquer coisa ao ROAD. Somente /collector-road libera.
    if (estadoRoadCanonico.hard_reset_pendente) return false;

    if (estadoRoadCanonico.pronto !== true || !orientacaoRoadValida(estadoRoadCanonico.orientacao)) {
        return confirmarOrientacaoInicialComIncremental(dados, giro);
    }

    const seqRecebida = sequenciaColetorRoad(dados.coletor_seq);
    const seqAnterior = estadoRoadCanonico.ultimo_coletor_seq;
    if (seqRecebida !== null && seqAnterior !== null) {
        if (seqRecebida <= seqAnterior) return false;
        if (seqRecebida > seqAnterior + 1) {
            iniciarHardResetRoad(
                `salto de sequência ${seqAnterior}->${seqRecebida}; snapshot completo obrigatório`,
                sessao || estadoRoadCanonico.coletor_sessao
            );
            return false;
        }
    }

    const pontaNova = pontaNovaEstadoCanonico();
    if (mesmoGiroRoad(giro, pontaNova)) {
        estadoRoadCanonico.ultimo_coletor_seq = seqRecebida !== null ? seqRecebida : seqAnterior;
        estadoRoadCanonico.atualizado_em = Date.now();
        return false;
    }

    if (estadoRoadCanonico.orientacao === ORIENTACAO_ROAD.NEW_TO_OLD) {
        estadoRoadCanonico.history.unshift(giro);
        if (estadoRoadCanonico.history.length > LIMITE_HISTORY_CANONICO) {
            estadoRoadCanonico.history.pop();
        }
    } else {
        estadoRoadCanonico.history.push(giro);
        if (estadoRoadCanonico.history.length > LIMITE_HISTORY_CANONICO) {
            estadoRoadCanonico.history.shift();
        }
    }

    estadoRoadCanonico.ultimo_coletor_seq = seqRecebida !== null ? seqRecebida : seqAnterior;
    estadoRoadCanonico.atualizado_em = Date.now();
    return true;
}

function processarCollectorHealthCanonico(req) {
    if (req.method !== 'POST' || req.path !== '/collector-health') return false;
    if (!tokenInternoValidoRoad(req)) return false;
    const dados = req.body && typeof req.body === 'object' ? req.body : {};
    const evento = String(dados.evento || '').trim().toUpperCase();
    const motivo = String(dados.motivo || '').trim().toUpperCase();
    if (evento !== 'INTERRUPCAO') return false;

    if (motivo === MOTIVO_FALHA_ENVIO_RESULTADO_NODE || motivo === MOTIVO_SOBREPOSICAO_AMBIGUA) {
        iniciarHardResetRoad(
            motivo,
            String(dados.coletor_sessao || '').trim() || estadoRoadCanonico.coletor_sessao
        );
        return true;
    }
    return false;
}

function obterHistoricoCanonicoLive(limiteSolicitado = LIMITE_HISTORY_CANONICO, coletorSeqMax = null) {
    if (
        estadoRoadCanonico.pronto !== true
        || estadoRoadCanonico.hard_reset_pendente === true
        || !orientacaoRoadValida(estadoRoadCanonico.orientacao)
        || !Array.isArray(estadoRoadCanonico.history)
        || estadoRoadCanonico.history.length === 0
    ) {
        return {
            pronto: false,
            orientacao: estadoRoadCanonico.orientacao,
            history: [],
            coletor_sessao: estadoRoadCanonico.coletor_sessao,
            hard_reset_pendente: estadoRoadCanonico.hard_reset_pendente,
            hard_reset_motivo: estadoRoadCanonico.hard_reset_motivo
        };
    }

    const limiteNumero = Number(limiteSolicitado);
    const limite = Number.isFinite(limiteNumero)
        ? Math.max(1, Math.min(LIMITE_HISTORY_CANONICO, Math.trunc(limiteNumero)))
        : LIMITE_HISTORY_CANONICO;
    const seqMax = sequenciaColetorRoad(coletorSeqMax);
    let cronologico = historyCronologicoRoad(
        estadoRoadCanonico.history,
        estadoRoadCanonico.orientacao
    );

    if (seqMax !== null) {
        cronologico = cronologico.filter(item => {
            const seq = sequenciaColetorRoad(item?.coletorSeq);
            return seq === null || seq <= seqMax;
        });
    }

    const history = cronologico.slice(-limite).map(item => ({
        resultado: resultadoLiveRoad(item.winner),
        winner: normalizarWinnerRoad(item.winner),
        playerScore: numeroRoad(item.playerScore),
        bankerScore: numeroRoad(item.bankerScore),
        round_id: String(item.roundId || '').trim() || null,
        coletor_seq: sequenciaColetorRoad(item.coletorSeq),
        timestamp_ms: Math.trunc(numeroRoad(item.timestamp) || 0),
        id_sessao: estadoRoadCanonico.coletor_sessao
    }));

    if (history.some(item => !item.resultado || item.playerScore === null || item.bankerScore === null)) {
        iniciarHardResetRoad('item inválido ao materializar snapshot canônico', estadoRoadCanonico.coletor_sessao);
        return {
            pronto: false,
            orientacao: null,
            history: [],
            coletor_sessao: estadoRoadCanonico.coletor_sessao,
            hard_reset_pendente: true,
            hard_reset_motivo: estadoRoadCanonico.hard_reset_motivo
        };
    }

    return {
        pronto: true,
        orientacao: estadoRoadCanonico.orientacao,
        history,
        coletor_sessao: estadoRoadCanonico.coletor_sessao,
        atualizado_em: estadoRoadCanonico.atualizado_em,
        ultimo_coletor_seq: estadoRoadCanonico.ultimo_coletor_seq,
        hard_reset_pendente: false,
        hard_reset_motivo: null
    };
}

function ehCollectorRoad(req) {
    return req.method === 'POST' && req.path === '/collector-road';
}

async function responderCollectorRoadCanonico(req, res) {
    if (!tokenInternoValidoRoad(req)) {
        res.status(401).json({ erro: 'Nao autorizado' });
        return;
    }

    const dados = req.body && typeof req.body === 'object' ? req.body : {};
    const history = Array.isArray(dados.history) ? dados.history : null;
    const sessao = String(dados.coletor_sessao || '').trim();
    const timestamp = Number(dados.timestamp_coleta);

    if (!history || history.length === 0 || history.length > LIMITE_HISTORY_CANONICO || !sessao) {
        res.status(400).json({ erro: 'snapshot road invalido' });
        return;
    }

    const historyNormalizado = history.map(normalizarItemHistoryRoad);
    if (
        historyNormalizado.some(item => item === null)
        || !Number.isFinite(timestamp)
        || timestamp <= 0
    ) {
        iniciarHardResetRoad('snapshot ROAD inválido recebido', sessao);
        res.status(400).json({ erro: 'snapshot road invalido' });
        return;
    }

    const sessaoMudou = Boolean(
        estadoRoadCanonico.coletor_sessao
        && estadoRoadCanonico.coletor_sessao !== sessao
    );
    if (sessaoMudou) {
        iniciarHardResetRoad('nova sessão do coletor exige substituição integral do snapshot', sessao);
    }

    const estavaHardReset = estadoRoadCanonico.hard_reset_pendente === true;
    const resultado = substituirPorSnapshotCompleto(dados, historyNormalizado);

    res.status(200).json({
        recebido: true,
        core: 'RAM_CANONICA_HARD_RESET',
        quantidade: historyNormalizado.length,
        pronto: resultado.pronto,
        orientacao: resultado.orientacao,
        hard_reset: estavaHardReset || sessaoMudou,
        pendente_orientacao: resultado.pendente_orientacao
    });
}

function instalarRoadHardResetExpress() {
    if (express[EXPRESS_JSON_HARD_RESET_INSTALADO]) return;

    express.json = function jsonComRoadHardReset(...args) {
        const parserNativo = expressJsonNativo(...args);
        const middlewareLegado = expressJsonLegado(...args);

        return function middlewareRoadHardReset(req, res, next) {
            parserNativo(req, res, erro => {
                if (erro) return next(erro);

                if (ehCollectorRoad(req)) {
                    responderCollectorRoadCanonico(req, res).catch(erroRoad => {
                        iniciarHardResetRoad(
                            `falha ao aplicar snapshot completo: ${String(erroRoad?.message || erroRoad)}`,
                            String(req.body?.coletor_sessao || '').trim() || null
                        );
                        if (!res.headersSent) {
                            res.status(500).json({ erro: 'falha no hard reset road' });
                        }
                    });
                    return;
                }

                try {
                    processarCollectorHealthCanonico(req);
                    processarIncrementalCanonico(req);
                } catch (erroCore) {
                    iniciarHardResetRoad(
                        `falha no core ROAD: ${String(erroCore?.message || erroCore)}`,
                        String(req.body?.coletor_sessao || '').trim() || null
                    );
                }

                return middlewareLegado(req, res, next);
            });
        };
    };

    Object.defineProperty(express, EXPRESS_JSON_HARD_RESET_INSTALADO, {
        value: true,
        enumerable: false,
        configurable: false,
        writable: false
    });
}

instalarRoadHardResetExpress();

function criarIntegracaoContadorDiario(opcoes) {
    const legado = integracaoLegada.criarIntegracaoContadorDiario(opcoes);
    return {
        ...legado,
        obterHistoricoCanonicoLive
    };
}

module.exports = { criarIntegracaoContadorDiario };
