'use strict';

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const express = require('express');
const { criarBarreiraSaldoFrescoStops } = require('./bug051c_balance_barrier');
const { validarConfiguracaoAutoTrader } = require('./bug051d_config_validation');
const { criarIntegracaoCicloFinanceiro } = require('./bug051e_financial_cycle');
const { traderDentroHorarioExecucao, formatarFaixasHorario } = require('./auto_trader');

const GUARDA_CONFIG_INSTALADA = Symbol.for('robo-bacbo.bug051d.guarda-config');
const CONTEXTO_LEDGER_REQUEST = new AsyncLocalStorage();
const EXPRESS_JSON_LEDGER_INSTALADO = Symbol.for('robo-bacbo.arch-road-02.express-json-ledger');
const ORIENTACAO_ROAD = Object.freeze({
    OLD_TO_NEW: 'OLD_TO_NEW',
    NEW_TO_OLD: 'NEW_TO_OLD'
});
const LIMITE_HISTORY_CANONICO = 1000;
const LIMITE_RECONCILIACAO_LEDGER = 129;
const ORIGEM_ROAD_RECOVERY = 'ROAD_RECOVERY';
const ORIGEM_LIVE = 'LIVE';
const estadoCanonicoEvolution = {
    pronto: false,
    orientacao: null,
    history: [],
    coletor_sessao: null,
    snapshot_timestamp: null,
    atualizado_em: null,
    ultimo_coletor_seq: null
};
const estadoLedgerRoad = {
    dbPool: null,
    schemaPronto: false,
    idSessaoOverride: null,
    idSessaoBotReferencia: null,
    snapshotPendente: null,
    holdback: null,
    caudaReconciliacao: Promise.resolve()
};

function tokenInternoValidoRoad(req) {
    const recebido = Buffer.from(String(req?.get?.('X-Internal-Token') || ''), 'utf8');
    const esperado = Buffer.from(String(process.env.INTERNAL_API_TOKEN || '').trim(), 'utf8');
    return esperado.length > 0
        && recebido.length === esperado.length
        && crypto.timingSafeEqual(recebido, esperado);
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

function numeroRoad(valor) {
    if (valor === undefined || valor === null || valor === '') return null;
    const numero = Number(valor);
    return Number.isFinite(numero) ? numero : null;
}

function sequenciaColetorRoad(valor) {
    const numero = Number(valor);
    return Number.isSafeInteger(numero) && numero > 0 ? numero : null;
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

function normalizarItemHistoryRoad(item) {
    if (!item || typeof item !== 'object') return null;
    const winner = normalizarWinnerRoad(item.winner);
    const playerScore = numeroRoad(item.playerScore);
    const bankerScore = numeroRoad(item.bankerScore);
    if (!winner || playerScore === null || bankerScore === null) return null;

    return {
        ...item,
        winner,
        playerScore,
        bankerScore
    };
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

function invalidarEstadoCanonicoEvolution(motivo, { limparHistory = false, sessao = null } = {}) {
    estadoCanonicoEvolution.pronto = false;
    estadoCanonicoEvolution.orientacao = null;
    if (limparHistory) estadoCanonicoEvolution.history = [];
    if (sessao !== null) estadoCanonicoEvolution.coletor_sessao = sessao;
    estadoCanonicoEvolution.snapshot_timestamp = limparHistory
        ? null
        : estadoCanonicoEvolution.snapshot_timestamp;
    estadoCanonicoEvolution.atualizado_em = Date.now();
    estadoCanonicoEvolution.ultimo_coletor_seq = null;
    if (motivo) {
        console.warn(`⛔ CORE ROAD | fail-closed | ${motivo}`);
    }
}

function pontaNovaEstadoCanonico() {
    if (!estadoCanonicoEvolution.pronto || estadoCanonicoEvolution.history.length === 0) return null;
    if (estadoCanonicoEvolution.orientacao === ORIENTACAO_ROAD.NEW_TO_OLD) {
        return estadoCanonicoEvolution.history[0];
    }
    return estadoCanonicoEvolution.history[estadoCanonicoEvolution.history.length - 1];
}

function logEstadoCanonicoReady() {
    if (!estadoCanonicoEvolution.pronto) return;
    const pontaNova = pontaNovaEstadoCanonico();
    if (!pontaNova) return;
    console.log(
        `🧠 CORE ROAD | READY atualizado | orientação=${estadoCanonicoEvolution.orientacao} | `
        + `rodadas=${estadoCanonicoEvolution.history.length} | `
        + `último=${pontaNova.winner}:${pontaNova.playerScore}x${pontaNova.bankerScore}`
    );
}

function orientacaoRoadValida(valor) {
    return valor === ORIENTACAO_ROAD.OLD_TO_NEW || valor === ORIENTACAO_ROAD.NEW_TO_OLD;
}

function historyCronologicoRoad(history, orientacao) {
    const itens = Array.isArray(history) ? history : [];
    if (orientacao === ORIENTACAO_ROAD.OLD_TO_NEW) return [...itens];
    if (orientacao === ORIENTACAO_ROAD.NEW_TO_OLD) return [...itens].reverse();
    return [];
}

function hidratarEstadoCanonicoEvolution(dados, historyNormalizado, orientacaoForcada = null) {
    const sessao = String(dados.coletor_sessao || '').trim();
    const timestamp = Number(dados.timestamp_coleta);
    const mesmaSessao = Boolean(
        estadoCanonicoEvolution.coletor_sessao
        && estadoCanonicoEvolution.coletor_sessao === sessao
    );
    const orientacaoPreservada = mesmaSessao ? estadoCanonicoEvolution.orientacao : null;
    const orientacaoEfetiva = orientacaoRoadValida(orientacaoForcada)
        ? orientacaoForcada
        : (orientacaoRoadValida(orientacaoPreservada) ? orientacaoPreservada : null);
    const seqPreservada = mesmaSessao ? estadoCanonicoEvolution.ultimo_coletor_seq : null;

    estadoCanonicoEvolution.pronto = Boolean(orientacaoEfetiva);
    estadoCanonicoEvolution.orientacao = orientacaoEfetiva;
    estadoCanonicoEvolution.history = historyNormalizado;
    estadoCanonicoEvolution.coletor_sessao = sessao;
    estadoCanonicoEvolution.snapshot_timestamp = Math.trunc(timestamp);
    estadoCanonicoEvolution.atualizado_em = Date.now();
    estadoCanonicoEvolution.ultimo_coletor_seq = seqPreservada;

    if (estadoCanonicoEvolution.pronto) logEstadoCanonicoReady();
}

function normalizarLinhaLedgerRoad(row) {
    if (!row || typeof row !== 'object') return null;
    const winner = normalizarWinnerRoad(row.resultado);
    const playerScoreRoad = numeroRoad(row.player_score_road);
    const bankerScoreRoad = numeroRoad(row.banker_score_road);
    const p1 = numeroRoad(row.p_d1);
    const p2 = numeroRoad(row.p_d2);
    const b1 = numeroRoad(row.b_d1);
    const b2 = numeroRoad(row.b_d2);
    const playerScore = playerScoreRoad !== null
        ? playerScoreRoad
        : (p1 !== null && p2 !== null ? p1 + p2 : null);
    const bankerScore = bankerScoreRoad !== null
        ? bankerScoreRoad
        : (b1 !== null && b2 !== null ? b1 + b2 : null);
    if (!winner || playerScore === null || bankerScore === null) return null;

    return {
        id: Number(row.id) || 0,
        id_sessao: numeroRoad(row.id_sessao),
        winner,
        playerScore,
        bankerScore
    };
}

function encontrarSobreposicaoLedgerRoad(ledgerCronologico, snapshotCronologico) {
    const ledger = Array.isArray(ledgerCronologico) ? ledgerCronologico : [];
    const snapshot = Array.isArray(snapshotCronologico) ? snapshotCronologico : [];
    if (ledger.length === 0 || snapshot.length === 0) {
        return { tamanho: 0, indice_snapshot_ultimo: -1, empates: 0 };
    }

    let melhorTamanho = 0;
    let melhorIndice = -1;
    let empates = 0;

    for (let indiceSnapshot = 0; indiceSnapshot < snapshot.length; indiceSnapshot++) {
        let tamanho = 0;
        while (
            tamanho < ledger.length
            && tamanho <= indiceSnapshot
            && mesmoGiroRoad(
                ledger[ledger.length - 1 - tamanho],
                snapshot[indiceSnapshot - tamanho]
            )
        ) {
            tamanho++;
        }

        if (tamanho > melhorTamanho) {
            melhorTamanho = tamanho;
            melhorIndice = indiceSnapshot;
            empates = 1;
        } else if (tamanho > 0 && tamanho === melhorTamanho) {
            empates++;
            if (indiceSnapshot > melhorIndice) melhorIndice = indiceSnapshot;
        }
    }

    return {
        tamanho: melhorTamanho,
        indice_snapshot_ultimo: melhorIndice,
        empates
    };
}

function selecionarOrientacaoPorLedger(historyNormalizado, ledgerCronologico, orientacaoPreferida = null) {
    const avaliar = orientacao => {
        const snapshotCronologico = historyCronologicoRoad(historyNormalizado, orientacao);
        return {
            orientacao,
            snapshotCronologico,
            sobreposicao: encontrarSobreposicaoLedgerRoad(ledgerCronologico, snapshotCronologico)
        };
    };

    if (orientacaoRoadValida(orientacaoPreferida)) {
        return { ...avaliar(orientacaoPreferida), ambigua: false };
    }

    const oldToNew = avaliar(ORIENTACAO_ROAD.OLD_TO_NEW);
    const newToOld = avaliar(ORIENTACAO_ROAD.NEW_TO_OLD);
    const tamanhoOld = oldToNew.sobreposicao.tamanho;
    const tamanhoNew = newToOld.sobreposicao.tamanho;

    if (tamanhoOld > tamanhoNew) return { ...oldToNew, ambigua: false };
    if (tamanhoNew > tamanhoOld) return { ...newToOld, ambigua: false };
    if (tamanhoOld === 0) {
        return {
            orientacao: null,
            snapshotCronologico: [],
            sobreposicao: { tamanho: 0, indice_snapshot_ultimo: -1, empates: 0 },
            ambigua: false
        };
    }

    return {
        orientacao: null,
        snapshotCronologico: [],
        sobreposicao: { tamanho: tamanhoOld, indice_snapshot_ultimo: -1, empates: 0 },
        ambigua: true
    };
}

function gerarNovaSessaoRoad(idSessaoAnterior = null) {
    const anterior = numeroRoad(idSessaoAnterior);
    const agora = Date.now();
    if (anterior === null) return agora;
    return Math.max(agora, Math.trunc(anterior) + 1);
}

function ativarOverrideSessaoRoad(novaSessao, sessaoLedgerAnterior = null) {
    if (numeroRoad(estadoLedgerRoad.idSessaoOverride) === null) {
        const referencia = numeroRoad(sessaoLedgerAnterior);
        if (referencia !== null) estadoLedgerRoad.idSessaoBotReferencia = referencia;
    }
    estadoLedgerRoad.idSessaoOverride = novaSessao;
}

function multiplicadorTieRoad(score) {
    const numero = numeroRoad(score);
    if (numero === 2 || numero === 12) return '88x';
    if (numero === 3 || numero === 11) return '25x';
    if (numero === 4 || numero === 10) return '10x';
    if (numero === 5 || numero === 9) return '6x';
    return '4x';
}

async function carregarCaudaLedgerRoad() {
    if (!estadoLedgerRoad.dbPool || !estadoLedgerRoad.schemaPronto) return [];
    const [linhas] = await estadoLedgerRoad.dbPool.query(
        `SELECT id, resultado, p_d1, p_d2, b_d1, b_d2,
                player_score_road, banker_score_road, id_sessao
         FROM giros_recentes
         ORDER BY id DESC
         LIMIT ${LIMITE_RECONCILIACAO_LEDGER}`
    );
    return linhas
        .map(normalizarLinhaLedgerRoad)
        .filter(Boolean)
        .reverse();
}

async function persistirRoadRecovery(snapshotCronologico, idSessao, dados) {
    const history = Array.isArray(snapshotCronologico) ? snapshotCronologico : [];
    if (history.length === 0) return 0;
    if (!estadoLedgerRoad.dbPool || !estadoLedgerRoad.schemaPronto) {
        throw new Error('ledger ROAD ainda nao inicializado');
    }

    const sessaoColetor = String(dados?.coletor_sessao || '').trim().slice(0, 64);
    const timestampNumero = Number(dados?.timestamp_coleta);
    const timestampSegundos = Number.isFinite(timestampNumero) && timestampNumero > 0
        ? timestampNumero / 1000
        : Date.now() / 1000;
    const placeholders = history
        .map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,FROM_UNIXTIME(?))')
        .join(',');
    const params = [];

    for (const item of history) {
        const resultado = resultadoLiveRoad(item.winner);
        const playerScore = numeroRoad(item.playerScore);
        const bankerScore = numeroRoad(item.bankerScore);
        if (!resultado || playerScore === null || bankerScore === null) {
            throw new Error('snapshot ROAD contem item invalido durante o backfill');
        }
        const tie = resultado === 'Tie';
        params.push(
            resultado,
            0,
            0,
            0,
            0,
            tie ? playerScore : 0,
            tie ? multiplicadorTieRoad(playerScore) : '',
            null,
            null,
            sessaoColetor || null,
            idSessao,
            ORIGEM_ROAD_RECOVERY,
            playerScore,
            bankerScore,
            timestampSegundos
        );
    }

    const conexao = await estadoLedgerRoad.dbPool.getConnection();
    try {
        await conexao.beginTransaction();
        await conexao.query(
            `INSERT INTO giros_recentes
                (resultado, p_d1, p_d2, b_d1, b_d2, numero_empate, multiplicador,
                 round_id, coletor_seq, coletor_sessao, id_sessao, origem,
                 player_score_road, banker_score_road, data_hora)
             VALUES ${placeholders}`,
            params
        );
        await conexao.commit();
    } catch (erro) {
        try { await conexao.rollback(); } catch (rollbackErro) {}
        throw erro;
    } finally {
        conexao.release();
    }

    console.log(
        `🧾 ROAD RECOVERY | ${history.length} rodada(s) recuperada(s) no ledger | `
        + `id_sessao=${idSessao} | round_id=NULL`
    );
    return history.length;
}

function registrarHoldbackRoad(item, idSessao, dados) {
    if (!item) {
        estadoLedgerRoad.holdback = null;
        return;
    }
    estadoLedgerRoad.holdback = {
        item: { ...item },
        idSessao,
        dados: { ...dados }
    };
}

async function persistirRecuperacaoComHoldback(snapshotCronologico, idSessao, dados) {
    const history = Array.isArray(snapshotCronologico) ? snapshotCronologico : [];
    if (history.length === 0) {
        estadoLedgerRoad.holdback = null;
        return 0;
    }
    const persistirAgora = history.slice(0, -1);
    const pontaPossivelmenteEmVoo = history[history.length - 1];
    const persistidas = await persistirRoadRecovery(persistirAgora, idSessao, dados);
    registrarHoldbackRoad(pontaPossivelmenteEmVoo, idSessao, dados);
    return persistidas;
}

async function resolverHoldbackJaPersistido() {
    const holdback = estadoLedgerRoad.holdback;
    if (!holdback) return false;
    const ledger = await carregarCaudaLedgerRoad();
    const ultimo = ledger.length > 0 ? ledger[ledger.length - 1] : null;
    if (ultimo && mesmoGiroRoad(ultimo, holdback.item)) {
        estadoLedgerRoad.holdback = null;
        return true;
    }
    return false;
}

async function resolverHoldbackAntesIncremental(giroIncremental) {
    const holdback = estadoLedgerRoad.holdback;
    if (!holdback || !giroIncremental) return;
    if (mesmoGiroRoad(giroIncremental, holdback.item)) {
        estadoLedgerRoad.holdback = null;
        return;
    }
    if (await resolverHoldbackJaPersistido()) return;
    await persistirRoadRecovery([holdback.item], holdback.idSessao, holdback.dados);
    estadoLedgerRoad.holdback = null;
}

async function resolverHoldbackAntesSnapshot(historyNormalizado, orientacaoPreferida) {
    const holdback = estadoLedgerRoad.holdback;
    if (!holdback) return;
    if (await resolverHoldbackJaPersistido()) return;
    if (!orientacaoRoadValida(orientacaoPreferida)) return;
    const cronologico = historyCronologicoRoad(historyNormalizado, orientacaoPreferida);
    const pontaNova = cronologico.length > 0 ? cronologico[cronologico.length - 1] : null;
    if (!pontaNova || mesmoGiroRoad(pontaNova, holdback.item)) return;
    await persistirRoadRecovery([holdback.item], holdback.idSessao, holdback.dados);
    estadoLedgerRoad.holdback = null;
}

function enfileirarReconciliacaoRoad(tarefa) {
    const executar = () => Promise.resolve().then(tarefa);
    const proxima = estadoLedgerRoad.caudaReconciliacao.then(executar, executar);
    estadoLedgerRoad.caudaReconciliacao = proxima.catch(() => {});
    return proxima;
}

async function reconciliarSnapshotComLedger(dados, historyNormalizado, orientacaoForcada = null) {
    const sessao = String(dados.coletor_sessao || '').trim();
    const mesmaSessaoCanonica = Boolean(
        estadoCanonicoEvolution.coletor_sessao
        && estadoCanonicoEvolution.coletor_sessao === sessao
    );
    const orientacaoPreferida = orientacaoRoadValida(orientacaoForcada)
        ? orientacaoForcada
        : (mesmaSessaoCanonica && orientacaoRoadValida(estadoCanonicoEvolution.orientacao)
            ? estadoCanonicoEvolution.orientacao
            : null);

    await resolverHoldbackAntesSnapshot(historyNormalizado, orientacaoPreferida);
    const ledger = await carregarCaudaLedgerRoad();
    const escolha = selecionarOrientacaoPorLedger(
        historyNormalizado,
        ledger,
        orientacaoPreferida
    );

    if (escolha.ambigua) {
        hidratarEstadoCanonicoEvolution(dados, historyNormalizado, null);
        estadoLedgerRoad.snapshotPendente = {
            dados: { ...dados },
            history: historyNormalizado.map(item => ({ ...item })),
            fronteiraNova: false,
            idSessao: null
        };
        console.warn('⏳ ROAD RECOVERY | sobreposição ambígua; aguardando incremental para confirmar orientação.');
        return { pronto: false, recuperadas: 0, fronteira_nova: false, pendente: true };
    }

    if (escolha.sobreposicao.tamanho > 0 && orientacaoRoadValida(escolha.orientacao)) {
        const indiceUltimo = escolha.sobreposicao.indice_snapshot_ultimo;
        const recuperadas = escolha.snapshotCronologico.slice(indiceUltimo + 1);
        const idSessao = ledger.length > 0 && ledger[ledger.length - 1].id_sessao !== null
            ? ledger[ledger.length - 1].id_sessao
            : (estadoLedgerRoad.idSessaoOverride || gerarNovaSessaoRoad());
        const persistidas = await persistirRecuperacaoComHoldback(recuperadas, idSessao, dados);
        estadoLedgerRoad.snapshotPendente = null;
        hidratarEstadoCanonicoEvolution(dados, historyNormalizado, escolha.orientacao);
        return {
            pronto: true,
            recuperadas: persistidas,
            fronteira_nova: false,
            pendente: false,
            orientacao: escolha.orientacao
        };
    }

    const pendenteAnterior = estadoLedgerRoad.snapshotPendente;
    const reutilizarSessao = Boolean(
        pendenteAnterior
        && pendenteAnterior.fronteiraNova === true
        && String(pendenteAnterior.dados?.coletor_sessao || '') === sessao
        && numeroRoad(pendenteAnterior.idSessao) !== null
    );
    const ultimaSessao = ledger.length > 0 ? ledger[ledger.length - 1].id_sessao : null;
    const novaSessao = reutilizarSessao
        ? pendenteAnterior.idSessao
        : gerarNovaSessaoRoad(ultimaSessao);
    ativarOverrideSessaoRoad(novaSessao, ultimaSessao);

    if (orientacaoRoadValida(escolha.orientacao)) {
        const persistidas = await persistirRecuperacaoComHoldback(
            escolha.snapshotCronologico,
            novaSessao,
            dados
        );
        estadoLedgerRoad.snapshotPendente = null;
        hidratarEstadoCanonicoEvolution(dados, historyNormalizado, escolha.orientacao);
        console.warn(
            `🧭 ROAD RECOVERY | nenhuma sobreposição com as últimas ${ledger.length} rodada(s); `
            + `nova fronteira lógica id_sessao=${novaSessao}.`
        );
        return {
            pronto: true,
            recuperadas: persistidas,
            fronteira_nova: true,
            pendente: false,
            orientacao: escolha.orientacao
        };
    }

    hidratarEstadoCanonicoEvolution(dados, historyNormalizado, null);
    estadoLedgerRoad.snapshotPendente = {
        dados: { ...dados },
        history: historyNormalizado.map(item => ({ ...item })),
        fronteiraNova: true,
        idSessao: novaSessao
    };
    console.warn(
        `🧭 ROAD RECOVERY | nenhuma sobreposição encontrada; fronteira ${novaSessao} reservada `
        + 'e snapshot aguardando orientação incremental antes do backfill.'
    );
    return { pronto: false, recuperadas: 0, fronteira_nova: true, pendente: true };
}

async function concluirSnapshotPendenteAposOrientacao() {
    const pendente = estadoLedgerRoad.snapshotPendente;
    if (!pendente || estadoCanonicoEvolution.pronto !== true || !orientacaoRoadValida(estadoCanonicoEvolution.orientacao)) {
        return 0;
    }

    const orientacao = estadoCanonicoEvolution.orientacao;
    const snapshotCronologico = historyCronologicoRoad(pendente.history, orientacao);
    let recuperadas = snapshotCronologico;
    let idSessao = numeroRoad(pendente.idSessao);
    let fronteiraNova = pendente.fronteiraNova === true;

    if (!fronteiraNova) {
        const ledger = await carregarCaudaLedgerRoad();
        const sobreposicao = encontrarSobreposicaoLedgerRoad(ledger, snapshotCronologico);
        if (sobreposicao.tamanho > 0) {
            recuperadas = snapshotCronologico.slice(sobreposicao.indice_snapshot_ultimo + 1);
            idSessao = ledger.length > 0 && ledger[ledger.length - 1].id_sessao !== null
                ? ledger[ledger.length - 1].id_sessao
                : (estadoLedgerRoad.idSessaoOverride || gerarNovaSessaoRoad());
        } else {
            const ultimaSessao = ledger.length > 0 ? ledger[ledger.length - 1].id_sessao : null;
            idSessao = gerarNovaSessaoRoad(ultimaSessao);
            ativarOverrideSessaoRoad(idSessao, ultimaSessao);
            fronteiraNova = true;
        }
    }

    if (idSessao === null) {
        idSessao = gerarNovaSessaoRoad();
        if (fronteiraNova) ativarOverrideSessaoRoad(idSessao, null);
    }

    const persistidas = await persistirRecuperacaoComHoldback(
        recuperadas,
        idSessao,
        pendente.dados
    );
    estadoLedgerRoad.snapshotPendente = null;
    if (fronteiraNova) {
        console.warn(
            `🧭 ROAD RECOVERY | nova fronteira lógica confirmada após orientação incremental | `
            + `id_sessao=${idSessao}.`
        );
    }
    return persistidas;
}

function orientarOuAtualizarEstadoCanonicoComIncremental(dados) {
    const giro = normalizarGiroIncrementalRoad(dados);
    if (!giro || estadoCanonicoEvolution.history.length === 0) return false;

    const sessaoIncremental = String(dados.coletor_sessao || '').trim();
    if (
        estadoCanonicoEvolution.coletor_sessao
        && sessaoIncremental
        && sessaoIncremental !== estadoCanonicoEvolution.coletor_sessao
    ) {
        invalidarEstadoCanonicoEvolution('sessão incremental divergiu do snapshot', {
            limparHistory: true,
            sessao: sessaoIncremental
        });
        estadoLedgerRoad.snapshotPendente = null;
        estadoLedgerRoad.holdback = null;
        return false;
    }

    const seqRecebida = sequenciaColetorRoad(dados.coletor_seq);
    const seqAnterior = estadoCanonicoEvolution.ultimo_coletor_seq;
    if (seqRecebida !== null && seqAnterior !== null) {
        if (seqRecebida <= seqAnterior) return false;
        if (seqRecebida > seqAnterior + 1) {
            invalidarEstadoCanonicoEvolution(
                `salto de sequência ${seqAnterior}->${seqRecebida}; aguardando novo snapshot`
            );
            return false;
        }
    }

    if (!estadoCanonicoEvolution.orientacao) {
        const primeiro = estadoCanonicoEvolution.history[0];
        const ultimo = estadoCanonicoEvolution.history[estadoCanonicoEvolution.history.length - 1];
        const batePrimeiro = mesmoGiroRoad(giro, primeiro);
        const bateUltimo = mesmoGiroRoad(giro, ultimo);

        if (batePrimeiro === bateUltimo) return false;

        estadoCanonicoEvolution.orientacao = batePrimeiro
            ? ORIENTACAO_ROAD.NEW_TO_OLD
            : ORIENTACAO_ROAD.OLD_TO_NEW;
        estadoCanonicoEvolution.pronto = true;
        estadoCanonicoEvolution.atualizado_em = Date.now();
        estadoCanonicoEvolution.ultimo_coletor_seq = seqRecebida;
        logEstadoCanonicoReady();
        return true;
    }

    if (!estadoCanonicoEvolution.pronto) return false;

    const pontaNova = pontaNovaEstadoCanonico();
    if (mesmoGiroRoad(giro, pontaNova)) {
        estadoCanonicoEvolution.ultimo_coletor_seq = seqRecebida !== null
            ? seqRecebida
            : estadoCanonicoEvolution.ultimo_coletor_seq;
        estadoCanonicoEvolution.atualizado_em = Date.now();
        return false;
    }

    if (estadoCanonicoEvolution.orientacao === ORIENTACAO_ROAD.NEW_TO_OLD) {
        estadoCanonicoEvolution.history.unshift(giro);
        if (estadoCanonicoEvolution.history.length > LIMITE_HISTORY_CANONICO) {
            estadoCanonicoEvolution.history.pop();
        }
    } else {
        estadoCanonicoEvolution.history.push(giro);
        if (estadoCanonicoEvolution.history.length > LIMITE_HISTORY_CANONICO) {
            estadoCanonicoEvolution.history.shift();
        }
    }

    estadoCanonicoEvolution.atualizado_em = Date.now();
    estadoCanonicoEvolution.ultimo_coletor_seq = seqRecebida !== null
        ? seqRecebida
        : estadoCanonicoEvolution.ultimo_coletor_seq;
    logEstadoCanonicoReady();
    return true;
}

function obterHistoricoCanonicoLive() {
    const orientacaoValida = orientacaoRoadValida(estadoCanonicoEvolution.orientacao);
    if (
        estadoCanonicoEvolution.pronto !== true
        || !orientacaoValida
        || !Array.isArray(estadoCanonicoEvolution.history)
        || estadoCanonicoEvolution.history.length === 0
    ) {
        return {
            pronto: false,
            orientacao: estadoCanonicoEvolution.orientacao,
            history: [],
            coletor_sessao: estadoCanonicoEvolution.coletor_sessao
        };
    }

    const cronologico = historyCronologicoRoad(
        estadoCanonicoEvolution.history,
        estadoCanonicoEvolution.orientacao
    );
    const cauda = cronologico.slice(-LIMITE_HISTORY_CANONICO);
    const history = cauda.map(item => {
        const resultado = resultadoLiveRoad(item.winner);
        if (!resultado) return null;
        const timestamp = primeiroNumeroRoad([item.timestamp_ms, item.timestamp]);
        return {
            resultado,
            winner: normalizarWinnerRoad(item.winner),
            playerScore: numeroRoad(item.playerScore),
            bankerScore: numeroRoad(item.bankerScore),
            round_id: String(item.roundId || item.round_id || '').trim() || null,
            coletor_seq: sequenciaColetorRoad(item.coletorSeq || item.coletor_seq),
            timestamp_ms: timestamp === null ? 0 : Math.trunc(timestamp),
            id_sessao: estadoCanonicoEvolution.coletor_sessao
        };
    });

    if (history.some(item => item === null)) {
        invalidarEstadoCanonicoEvolution('item inválido ao materializar a cauda live');
        return {
            pronto: false,
            orientacao: null,
            history: [],
            coletor_sessao: estadoCanonicoEvolution.coletor_sessao
        };
    }

    return {
        pronto: true,
        orientacao: estadoCanonicoEvolution.orientacao,
        history,
        coletor_sessao: estadoCanonicoEvolution.coletor_sessao,
        atualizado_em: estadoCanonicoEvolution.atualizado_em
    };
}

function ehCollectorRoad(req) {
    return req.method === 'POST' && req.path === '/collector-road';
}

async function responderCollectorRoadCanonico(req, res) {
    if (!ehCollectorRoad(req)) return false;

    if (!tokenInternoValidoRoad(req)) {
        res.status(401).json({ erro: 'Nao autorizado' });
        return true;
    }

    if (!estadoLedgerRoad.dbPool || !estadoLedgerRoad.schemaPronto) {
        res.status(503).json({ erro: 'ledger road inicializando' });
        return true;
    }

    const dados = req.body && typeof req.body === 'object' ? req.body : {};
    const history = Array.isArray(dados.history) ? dados.history : null;
    const sessao = String(dados.coletor_sessao || '').trim();
    const timestamp = Number(dados.timestamp_coleta);

    if (!history || history.length === 0 || history.length > LIMITE_HISTORY_CANONICO || !sessao) {
        res.status(400).json({ erro: 'snapshot road invalido' });
        return true;
    }

    const historyNormalizado = history.map(normalizarItemHistoryRoad);
    if (
        historyNormalizado.some(item => item === null)
        || !Number.isFinite(timestamp)
        || timestamp <= 0
    ) {
        res.status(400).json({ erro: 'snapshot road invalido' });
        return true;
    }

    const reconciliacao = await enfileirarReconciliacaoRoad(
        () => reconciliarSnapshotComLedger(dados, historyNormalizado)
    );
    res.status(200).json({
        recebido: true,
        core: 'RAM_CANONICA',
        quantidade: historyNormalizado.length,
        pronto: estadoCanonicoEvolution.pronto,
        orientacao: estadoCanonicoEvolution.orientacao,
        recuperadas: reconciliacao.recuperadas,
        fronteira_nova: reconciliacao.fronteira_nova,
        pendente_orientacao: reconciliacao.pendente
    });
    return true;
}

function agendarReconciliacaoIncrementalLedger(giroIncremental) {
    if (!giroIncremental) return;

    enfileirarReconciliacaoRoad(async () => {
        await resolverHoldbackAntesIncremental(giroIncremental);
        if (estadoCanonicoEvolution.pronto === true && estadoLedgerRoad.snapshotPendente) {
            await concluirSnapshotPendenteAposOrientacao();
            await resolverHoldbackAntesIncremental(giroIncremental);
        }
    }).catch(erroLedger => {
        console.error(
            `❌ ROAD LEDGER | falha assíncrona fora do caminho live: ${String(erroLedger?.message || erroLedger)}`
        );
    });
}

function processarReceberSinalCanonico(req) {
    if (req.method !== 'POST' || req.path !== '/receber-sinal') return false;
    if (!tokenInternoValidoRoad(req)) return false;
    const dados = req.body && typeof req.body === 'object' ? req.body : {};
    const giroIncremental = normalizarGiroIncrementalRoad(dados);
    const atualizado = orientarOuAtualizarEstadoCanonicoComIncremental(dados);
    agendarReconciliacaoIncrementalLedger(giroIncremental);
    return atualizado;
}

function instalarContextoLedgerExpress() {
    if (express[EXPRESS_JSON_LEDGER_INSTALADO]) return;

    const jsonOriginal = express.json;
    express.json = function jsonComContextoLedger(...args) {
        const middleware = jsonOriginal(...args);
        return function middlewareComContextoLedger(req, res, next) {
            middleware(req, res, erro => {
                if (erro) return next(erro);

                if (ehCollectorRoad(req)) {
                    responderCollectorRoadCanonico(req, res).catch(erroRoad => {
                        invalidarEstadoCanonicoEvolution(
                            `falha na reconciliação/backfill ROAD: ${String(erroRoad?.message || erroRoad)}`
                        );
                        if (!res.headersSent) {
                            res.status(500).json({ erro: 'falha na reconciliacao road' });
                        }
                    });
                    return;
                }

                const payload = req && req.body && typeof req.body === 'object' ? req.body : {};
                try {
                    processarReceberSinalCanonico(req);
                } catch (erroCore) {
                    invalidarEstadoCanonicoEvolution(
                        `falha ao atualizar incremental live: ${String(erroCore?.message || erroCore)}`
                    );
                }
                return CONTEXTO_LEDGER_REQUEST.run(payload, next);
            });
        };
    };

    Object.defineProperty(express, EXPRESS_JSON_LEDGER_INSTALADO, {
        value: true,
        enumerable: false,
        configurable: false,
        writable: false
    });
}

instalarContextoLedgerExpress();

function normalizarSql(sql) {
    return typeof sql === 'string'
        ? sql.replace(/\s+/g, ' ').trim()
        : '';
}

function indiceParametroConfigJson(sqlNormalizado) {
    const sql = String(sqlNormalizado || '');
    const minusculo = sql.toLowerCase();
    if (!minusculo.includes('auto_traders') || !minusculo.includes('config_json')) {
        return null;
    }

    if (minusculo.startsWith('insert into auto_traders')) {
        const colunasMatch = /^insert\s+into\s+auto_traders\s*\(([^)]+)\)\s*values\s*\(([^)]+)\)/i.exec(sql);
        if (!colunasMatch) return null;

        const colunas = colunasMatch[1]
            .split(',')
            .map(coluna => coluna.trim().replace(/`/g, '').toLowerCase());
        const valores = colunasMatch[2].split(',').map(valor => valor.trim());
        const indiceColuna = colunas.indexOf('config_json');
        if (indiceColuna < 0 || indiceColuna >= valores.length || valores[indiceColuna] !== '?') {
            return null;
        }

        let indiceParametro = 0;
        for (let i = 0; i < indiceColuna; i++) {
            indiceParametro += (valores[i].match(/\?/g) || []).length;
        }
        return indiceParametro;
    }

    const atribuicao = /config_json\s*=\s*\?/i.exec(sql);
    if (!atribuicao) return null;
    return (sql.slice(0, atribuicao.index).match(/\?/g) || []).length;
}

function criarErroConfiguracaoInvalida(validacao) {
    const erro = new Error(`Configuração Auto-Trader rejeitada: ${validacao.motivo}`);
    erro.code = 'BUG051D_CONFIG_INVALIDA';
    erro.campo_configuracao = validacao.campo || null;
    return erro;
}

function normalizarMetadadosLedger(payload) {
    const dados = payload && typeof payload === 'object' ? payload : {};
    const roundIdTexto = String(dados.rodada_origem || '').trim();
    const sessaoTexto = String(dados.coletor_sessao || '').trim();
    const seqNumero = Number(dados.coletor_seq);

    return {
        round_id: roundIdTexto ? roundIdTexto.slice(0, 128) : null,
        coletor_seq: Number.isInteger(seqNumero) && seqNumero >= 0 ? seqNumero : null,
        coletor_sessao: sessaoTexto ? sessaoTexto.slice(0, 64) : null
    };
}

function enriquecerCreateGirosRecentes(sql) {
    const bruto = String(sql || '');
    const normalizado = normalizarSql(bruto).toLowerCase();
    if (!normalizado.startsWith('create table if not exists giros_recentes')) return bruto;
    if (normalizado.includes('player_score_road') || normalizado.includes('banker_score_road')) {
        return bruto;
    }

    return bruto.replace(
        /(\s*)id_sessao\s+BIGINT\s*,/i,
        (_, indentacao) => (
            `${indentacao}round_id VARCHAR(128) DEFAULT NULL,`
            + `${indentacao}coletor_seq INT DEFAULT NULL,`
            + `${indentacao}coletor_sessao VARCHAR(64) DEFAULT NULL,`
            + `${indentacao}origem VARCHAR(32) NOT NULL DEFAULT '${ORIGEM_LIVE}',`
            + `${indentacao}player_score_road TINYINT UNSIGNED DEFAULT NULL,`
            + `${indentacao}banker_score_road TINYINT UNSIGNED DEFAULT NULL,`
            + `${indentacao}id_sessao BIGINT,`
            + `${indentacao}INDEX idx_giros_recentes_round_id (round_id),`
        )
    );
}

function enriquecerInsertGiroRecente(sql, params) {
    const sqlNormalizado = normalizarSql(sql);
    const minusculo = sqlNormalizado.toLowerCase();
    const parametros = Array.isArray(params) ? params : [];

    if (!minusculo.startsWith('insert into giros_recentes')) {
        return { sql, params };
    }

    if (minusculo.includes('round_id') || minusculo.includes('coletor_seq') || minusculo.includes('coletor_sessao')) {
        return { sql, params };
    }

    if (parametros.length !== 9) {
        return { sql, params };
    }

    const metadados = normalizarMetadadosLedger(CONTEXTO_LEDGER_REQUEST.getStore());
    const idSessaoOriginal = parametros[7];
    const idSessaoOriginalNumero = numeroRoad(idSessaoOriginal);
    const idSessaoOverrideNumero = numeroRoad(estadoLedgerRoad.idSessaoOverride);
    const referenciaBotNumero = numeroRoad(estadoLedgerRoad.idSessaoBotReferencia);
    let idSessaoEfetiva = idSessaoOriginal;

    if (idSessaoOverrideNumero !== null) {
        if (referenciaBotNumero === null && idSessaoOriginalNumero !== null) {
            estadoLedgerRoad.idSessaoBotReferencia = idSessaoOriginalNumero;
            idSessaoEfetiva = estadoLedgerRoad.idSessaoOverride;
        } else if (
            referenciaBotNumero !== null
            && idSessaoOriginalNumero !== null
            && idSessaoOriginalNumero !== referenciaBotNumero
        ) {
            console.log(
                `🧭 ROAD RECOVERY | rotação nativa do Node detectada `
                + `(${referenciaBotNumero}->${idSessaoOriginalNumero}); override ROAD liberado.`
            );
            estadoLedgerRoad.idSessaoOverride = null;
            estadoLedgerRoad.idSessaoBotReferencia = idSessaoOriginalNumero;
            idSessaoEfetiva = idSessaoOriginal;
        } else {
            idSessaoEfetiva = estadoLedgerRoad.idSessaoOverride;
        }
    } else if (idSessaoOriginalNumero !== null) {
        estadoLedgerRoad.idSessaoBotReferencia = idSessaoOriginalNumero;
    }

    const novosParametros = [
        ...parametros.slice(0, 7),
        metadados.round_id,
        metadados.coletor_seq,
        metadados.coletor_sessao,
        idSessaoEfetiva,
        ORIGEM_LIVE,
        null,
        null,
        parametros[8]
    ];

    return {
        sql: 'INSERT INTO giros_recentes (resultado, p_d1, p_d2, b_d1, b_d2, numero_empate, multiplicador, round_id, coletor_seq, coletor_sessao, id_sessao, origem, player_score_road, banker_score_road, data_hora) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,FROM_UNIXTIME(?))',
        params: novosParametros
    };
}

function instalarGuardaPersistenciaConfig({ dbPool, traders, pulosAntesDaMecanica }) {
    if (dbPool[GUARDA_CONFIG_INSTALADA]) return;

    const queryOriginal = dbPool.query.bind(dbPool);
    dbPool.query = async function queryComGuardaBug051D(sql, params, ...rest) {
        let sqlEfetivo = enriquecerCreateGirosRecentes(sql);
        let parametrosEfetivos = Array.isArray(params) ? params : params;
        const insertGiro = enriquecerInsertGiroRecente(sqlEfetivo, parametrosEfetivos);
        sqlEfetivo = insertGiro.sql;
        parametrosEfetivos = insertGiro.params;

        const sqlNormalizado = normalizarSql(sqlEfetivo);
        const parametros = Array.isArray(parametrosEfetivos) ? parametrosEfetivos : [];
        const indiceConfig = indiceParametroConfigJson(sqlNormalizado);

        if (indiceConfig !== null) {
            const configJson = parametros[indiceConfig];
            let config = null;
            try {
                config = typeof configJson === 'string' ? JSON.parse(configJson) : null;
            } catch (erro) {
                console.warn('🚫 CONFIG AUTO-TRADER | persistência rejeitada | config_json não é JSON válido.');
                throw criarErroConfiguracaoInvalida({
                    campo: 'config',
                    motivo: 'config: JSON inválido'
                });
            }

            const validacao = validarConfiguracaoAutoTrader(config);
            if (!validacao.ok) {
                console.warn(
                    `🚫 CONFIG AUTO-TRADER | persistência rejeitada | ${validacao.motivo}`
                );
                throw criarErroConfiguracaoInvalida(validacao);
            }
        }

        const resultado = await queryOriginal(sqlEfetivo, parametrosEfetivos, ...rest);

        const atualizacaoPulos = /^update\s+auto_traders\s+set\s+pulos_restantes\s*=\s*\?\s+where\s+id\s*=\s*\?$/i.exec(sqlNormalizado);
        if (atualizacaoPulos && parametros.length >= 2) {
            const novoValor = Number(parametros[0]);
            const traderId = String(parametros[1]);
            const valorAnterior = pulosAntesDaMecanica.get(traderId);
            const trader = traders().find(item => String(item?.id) === traderId);

            if (
                trader?.config?.modo_camuflagem === 'PULOS'
                && Number.isInteger(novoValor)
                && Number.isInteger(valorAnterior)
            ) {
                if (valorAnterior === 0 && novoValor >= 1) {
                    console.log(
                        `👻 CAMUFLAGEM | trader=${traderId} | ciclo liberado | `
                        + `próximo intervalo sorteado=${novoValor} sinais.`
                    );
                } else if (valorAnterior > 0 && novoValor === valorAnterior - 1) {
                    console.log(
                        `👻 CAMUFLAGEM | trader=${traderId} | sinal pulado | `
                        + `restantes=${novoValor}.`
                    );
                }
            }
            pulosAntesDaMecanica.set(traderId, novoValor);
        }

        return resultado;
    };

    Object.defineProperty(dbPool, GUARDA_CONFIG_INSTALADA, {
        value: true,
        enumerable: false,
        configurable: false,
        writable: false
    });
}

async function inicializarLedgerForense(dbPool) {
    const alteracoes = [
        'ALTER TABLE giros_recentes ADD COLUMN round_id VARCHAR(128) DEFAULT NULL',
        'ALTER TABLE giros_recentes ADD COLUMN coletor_seq INT DEFAULT NULL',
        'ALTER TABLE giros_recentes ADD COLUMN coletor_sessao VARCHAR(64) DEFAULT NULL',
        `ALTER TABLE giros_recentes ADD COLUMN origem VARCHAR(32) NOT NULL DEFAULT '${ORIGEM_LIVE}'`,
        'ALTER TABLE giros_recentes ADD COLUMN player_score_road TINYINT UNSIGNED DEFAULT NULL',
        'ALTER TABLE giros_recentes ADD COLUMN banker_score_road TINYINT UNSIGNED DEFAULT NULL'
    ];

    for (const query of alteracoes) {
        try {
            await dbPool.query(query);
        } catch (erro) {
            if (erro && (erro.code === 'ER_DUP_FIELDNAME' || Number(erro.errno) === 1060)) continue;
            throw erro;
        }
    }

    try {
        await dbPool.query('ALTER TABLE giros_recentes ADD INDEX idx_giros_recentes_round_id (round_id)');
    } catch (erro) {
        if (!(erro && (erro.code === 'ER_DUP_KEYNAME' || Number(erro.errno) === 1061))) {
            throw erro;
        }
    }
}

// Integração BUG-051B encapsulada como fonte de domínio: o backend chama estas rotinas
// antes de avaliar novas entradas e na virada de cada resultado da mesa.
function criarIntegracaoContadorDiario({ controleDiarioAutoTrader, dbPool, ioServer, traders }) {
    const barreiraSaldoStops = criarBarreiraSaldoFrescoStops({ dbPool });
    const pulosAntesDaMecanica = new Map();
    estadoLedgerRoad.dbPool = dbPool;
    instalarGuardaPersistenciaConfig({ dbPool, traders, pulosAntesDaMecanica });
    const cicloFinanceiro = criarIntegracaoCicloFinanceiro({ dbPool });

    async function garantirAntesDaEntrada(trader) {
        const validacaoConfig = validarConfiguracaoAutoTrader(trader?.config);
        if (!validacaoConfig.ok) {
            console.error(
                `🚫 CONFIG AUTO-TRADER | trader=${trader?.id || 'n/a'} | execução bloqueada | `
                + validacaoConfig.motivo
            );
            return false;
        }

        if (!traderDentroHorarioExecucao(trader?.config)) {
            console.log(
                `🕒 Auto-Trader ${trader?.id || 'n/a'} fora das faixas de execução `
                + `(${formatarFaixasHorario(trader?.config)}). Nova entrada ignorada.`
            );
            return false;
        }

        pulosAntesDaMecanica.set(
            String(trader.id),
            Math.max(0, Number(trader.pulos_restantes) || 0)
        );

        try {
            await controleDiarioAutoTrader.garantirDataOperacional(trader);
        } catch (erro) {
            console.error(
                `BUG-051B Trader ${trader?.id}: falha ao validar data operacional; nova entrada bloqueada:`,
                erro.message
            );
            return false;
        }

        try {
            const saldoStops = await barreiraSaldoStops.garantirSaldoPosteriorUltimaLiquidacao(trader);
            if (!saldoStops.permitido) {
                const ref = saldoStops.referencia || {};
                console.warn(
                    `BUG-051C Trader ${trader?.id}: nova entrada e avaliacao de Stops bloqueadas; `
                    + `saldo posterior a ultima liquidacao nao foi comprovado `
                    + `(auditoria=${ref.auditoria_id || 'n/a'}, `
                    + `resultado_em=${ref.resultado_confirmado_em || 'n/a'}, `
                    + `saldo_confirmado_em=${ref.saldo_pos_confirmado_em || 'n/a'}).`
                );
                return false;
            }
        } catch (erro) {
            console.error(
                `BUG-051C Trader ${trader?.id}: falha ao validar causalidade do saldo; `
                + `nova entrada e avaliacao de Stops bloqueadas:`,
                erro.message
            );
            return false;
        }

        return true;
    }

    async function processarViradaDiaria(agora = Date.now()) {
        let resetados = 0;
        for (const trader of traders()) {
            if (!trader?.ativo) continue;
            try {
                if (await controleDiarioAutoTrader.garantirDataOperacional(trader, agora)) {
                    resetados++;
                    pulosAntesDaMecanica.set(String(trader.id), 0);
                    console.log(
                        `BUG-051B Trader ${trader.id}: novo dia operacional ${trader.data_contador_entradas} `
                        + `(${controleDiarioAutoTrader.timezone}); entradas e pulos zerados.`
                    );
                }
            } catch (erro) {
                console.error(
                    `BUG-051B Trader ${trader?.id}: falha ao processar virada diaria; estado anterior preservado:`,
                    erro.message
                );
            }
        }
        if (resetados > 0) ioServer.emit('atualizar_interface');
        return resetados;
    }

    async function inicializarDatasLegadas() {
        estadoLedgerRoad.schemaPronto = false;
        await cicloFinanceiro.inicializarSchema();
        await inicializarLedgerForense(dbPool);
        const hoje = controleDiarioAutoTrader.dataOperacional();
        await dbPool.query(
            `UPDATE auto_traders
             SET data_contador_entradas=?
             WHERE data_contador_entradas IS NULL OR data_contador_entradas=''`,
            [hoje]
        );
        estadoLedgerRoad.schemaPronto = true;
        return hoje;
    }

    return {
        garantirAntesDaEntrada,
        processarViradaDiaria,
        inicializarDatasLegadas,
        obterHistoricoCanonicoLive
    };
}

module.exports = { criarIntegracaoContadorDiario };
