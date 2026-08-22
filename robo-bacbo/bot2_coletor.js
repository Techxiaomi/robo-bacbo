'use strict';

const fs = require('fs');
const path = require('path');

const basePath = path.join(__dirname, 'bot2_coletor.phase0.js');
let source = fs.readFileSync(basePath, 'utf8');

function replaceExactly(label, before, after) {
    const first = source.indexOf(before);
    if (first < 0) throw new Error(`SIGNAL-CYCLE-01: trecho ausente: ${label}`);
    if (source.indexOf(before, first + before.length) >= 0) {
        throw new Error(`SIGNAL-CYCLE-01: trecho duplicado/ambíguo: ${label}`);
    }
    source = source.slice(0, first) + after + source.slice(first + before.length);
}

replaceExactly(
    'estado default',
    `novoEstado[est.id] = estadoApostas[est.id] || { aguardandoResultado: false, galeAtual: 0, robosCiclo: [], robosInscritos: [], mensagensEntrada: [], mensagensGale: [] };`,
    `novoEstado[est.id] = estadoApostas[est.id] || {
                aguardandoResultado: false,
                aguardandoRecuperacao: false,
                galeAtual: 0,
                ciclo_id: null,
                coletor_seq_entrada: null,
                coletor_seq_ultimo_processado: null,
                coletor_sessao_entrada: null,
                round_id_entrada: null,
                robosCiclo: [],
                robosWebInscritos: [],
                robosTelegramInscritos: [],
                robosInscritos: [],
                mensagensEntrada: [],
                mensagensGale: []
            };`
);

replaceExactly(
    'invalidacao silenciosa',
`async function invalidarSequenciasAposBuracoDados(motivo) {
    let sinaisInvalidados = 0;

    for (const estado of Object.values(estadoApostas)) {
        if (!estado || !estado.aguardandoResultado) continue;
        estado.aguardandoResultado = false;
        estado.galeAtual = 0;
        estado.robosWebInscritos = [];
        estado.robosTelegramInscritos = [];
        estado.robosInscritos = [];
        estado.telegramEntradaPromise = null;
        sinaisInvalidados++;
    }

    const [pendentes] = await dbPool.query(`SELECT DISTINCT trader_id FROM auditoria_ordens WHERE status_ordem = 'PENDENTE'`);
    const traderIds = [...new Set(pendentes.map(row => Number(row.trader_id)).filter(Number.isFinite))];

    if (traderIds.length > 0) {
        const placeholders = traderIds.map(() => '?').join(',');
        const conexao = await dbPool.getConnection();
        try {
            await conexao.beginTransaction();
            await conexao.query(`UPDATE auditoria_ordens SET status_ordem='DADOS_INCOMPLETOS' WHERE status_ordem='PENDENTE'`);
            await conexao.query(`UPDATE auto_traders SET ativo=false, status_operacao='DADOS_INCOMPLETOS' WHERE id IN (${placeholders})`, traderIds);
            await conexao.commit();
        } catch (e) {
            try { await conexao.rollback(); } catch (rollbackError) { console.error('❌ Rollback falhou ao tratar buraco de dados:', rollbackError.message); }
            throw e;
        } finally {
            conexao.release();
        }

        const idsBloqueados = new Set(traderIds.map(String));
        for (const trader of AUTO_TRADERS_MEMORIA) {
            if (!idsBloqueados.has(String(trader.id))) continue;
            trader.ativo = false;
            trader.status_operacao = 'DADOS_INCOMPLETOS';
        }
    }

    console.warn(`⚠️ Continuidade de dados comprometida (${motivo || 'DESCONHECIDO'}): ${sinaisInvalidados} sinal(is) pendente(s) invalidado(s), ${traderIds.length} Auto-Trader(s) com ordem pendente bloqueado(s).`);
    ioServer.emit('atualizar_interface');
    return { sinais_invalidados: sinaisInvalidados, traders_bloqueados: traderIds.length };
}`,
`async function invalidarSequenciasAposBuracoDados(motivo) {
    let sinaisEmRecuperacao = 0;
    const motivoNormalizado = String(motivo || 'DESCONHECIDO').slice(0, 120);

    for (const estado of Object.values(estadoApostas)) {
        if (!estado || !estado.aguardandoResultado) continue;
        estado.aguardandoRecuperacao = true;
        estado.motivoRecuperacao = motivoNormalizado;
        estado.recuperacaoMarcadaEm = Date.now();
        sinaisEmRecuperacao++;
    }

    const [pendentes] = await dbPool.query(`SELECT DISTINCT trader_id FROM auditoria_ordens WHERE status_ordem = 'PENDENTE'`);
    const traderIds = [...new Set(pendentes.map(row => Number(row.trader_id)).filter(Number.isFinite))];

    if (traderIds.length > 0) {
        const placeholders = traderIds.map(() => '?').join(',');
        const conexao = await dbPool.getConnection();
        try {
            await conexao.beginTransaction();
            await conexao.query(`UPDATE auditoria_ordens SET status_ordem='DADOS_INCOMPLETOS' WHERE status_ordem='PENDENTE'`);
            await conexao.query(`UPDATE auto_traders SET ativo=false, status_operacao='DADOS_INCOMPLETOS' WHERE id IN (${placeholders})`, traderIds);
            await conexao.commit();
        } catch (e) {
            try { await conexao.rollback(); } catch (rollbackError) { console.error('❌ Rollback falhou ao tratar buraco de dados:', rollbackError.message); }
            throw e;
        } finally {
            conexao.release();
        }

        const idsBloqueados = new Set(traderIds.map(String));
        for (const trader of AUTO_TRADERS_MEMORIA) {
            if (!idsBloqueados.has(String(trader.id))) continue;
            trader.ativo = false;
            trader.status_operacao = 'DADOS_INCOMPLETOS';
        }
    }

    console.warn(
        `⚠️ Continuidade de dados comprometida (${motivoNormalizado}): `
        + `${sinaisEmRecuperacao} sinal(is) preservado(s) aguardando recuperação pelo ROAD, `
        + `${traderIds.length} Auto-Trader(s) com ordem pendente bloqueado(s).`
    );
    ioServer.emit('atualizar_interface');
    return {
        sinais_invalidados: 0,
        sinais_em_recuperacao: sinaisEmRecuperacao,
        traders_bloqueados: traderIds.length
    };
}`
);

replaceExactly(
    'helpers de ciclo apos unirRobosInscritos',
`function unirRobosInscritos(...listas) {
    const unicos = new Map();

    for (const lista of listas) {
        for (const robo of (Array.isArray(lista) ? lista : [])) {
            if (robo && robo.id !== undefined && robo.id !== null) {
                unicos.set(String(robo.id), snapshotPublicoRobo(robo));
            }
        }
    }

    return [...unicos.values()];
}

function ciclosAtivosPorRobo() {`,
`function unirRobosInscritos(...listas) {
    const unicos = new Map();

    for (const lista of listas) {
        for (const robo of (Array.isArray(lista) ? lista : [])) {
            if (robo && robo.id !== undefined && robo.id !== null) {
                unicos.set(String(robo.id), snapshotPublicoRobo(robo));
            }
        }
    }

    return [...unicos.values()];
}

function normalizarColetorSeqCiclo(valor) {
    const numero = Number(valor);
    return Number.isSafeInteger(numero) && numero > 0 ? numero : null;
}

function snapshotEstadoSinal(estado) {
    if (!estado || typeof estado !== 'object') return null;
    const { telegramEntradaPromise, ...serializavel } = estado;
    let clone = null;
    try {
        clone = JSON.parse(JSON.stringify(serializavel));
    } catch (e) {
        clone = { ...serializavel };
    }
    clone.telegramEntradaPromise = telegramEntradaPromise || null;
    return Object.freeze(clone);
}

function limparEstadoSinal(estado) {
    if (!estado) return;
    estado.aguardandoResultado = false;
    estado.aguardandoRecuperacao = false;
    estado.galeAtual = 0;
    estado.ciclo_id = null;
    estado.coletor_seq_entrada = null;
    estado.coletor_seq_ultimo_processado = null;
    estado.coletor_sessao_entrada = null;
    estado.round_id_entrada = null;
    estado.motivoRecuperacao = null;
    estado.recuperacaoMarcadaEm = null;
    estado.robosCiclo = [];
    estado.robosWebInscritos = [];
    estado.robosTelegramInscritos = [];
    estado.robosInscritos = [];
    estado.telegramEntradaPromise = null;
}

function multiplicadorTieRecuperado(giro) {
    const score = Number(giro?.playerScore);
    if (score === 2 || score === 12) return '88x';
    if (score === 3 || score === 11) return '25x';
    if (score === 4 || score === 10) return '10x';
    if (score === 5 || score === 9) return '6x';
    return String(giro?.multiplicador || '4x');
}

function localizarIndiceOrigemRecuperacao(history, estado, snapshotRoad = {}) {
    const lista = Array.isArray(history) ? history : [];
    const seqEntrada = normalizarColetorSeqCiclo(estado?.coletor_seq_entrada);
    if (seqEntrada !== null) {
        const porSeq = lista.findIndex(giro => normalizarColetorSeqCiclo(giro?.coletor_seq) === seqEntrada);
        if (porSeq >= 0) return { indice: porSeq, via: 'COLETOR_SEQ' };

        const ultimoSeq = normalizarColetorSeqCiclo(snapshotRoad?.ultimo_coletor_seq);
        if (ultimoSeq !== null && lista.length > 0) {
            const seqPrimeiroInferido = ultimoSeq - (lista.length - 1);
            const indiceInferido = seqEntrada - seqPrimeiroInferido;
            if (indiceInferido >= 0 && indiceInferido < lista.length) {
                return { indice: indiceInferido, via: 'COLETOR_SEQ_INFERIDO' };
            }
        }
    }

    const roundId = String(estado?.round_id_entrada || '').trim();
    if (roundId) {
        const porRound = lista.findIndex(giro => String(giro?.round_id || giro?.roundId || '').trim() === roundId);
        if (porRound >= 0) return { indice: porRound, via: 'ROUND_ID' };
    }

    return { indice: -1, via: null };
}

async function cancelarSinalIrrecuperavel(est, estado, motivo) {
    if (!estado || !estado.aguardandoResultado) return false;
    await aguardarInscricaoTelegram(estado);
    const snapshot = snapshotEstadoSinal(estado);
    const extras = {
        motivo: String(motivo || 'Histórico insuficiente após instabilidade de rede'),
        ciclo_id: snapshot?.ciclo_id || null
    };
    emitirAlertaWebRobo('CANCELADO', est, snapshot, extras);
    void enviarTelegramParaInscritos('CANCELADO', est, snapshot, extras).catch(e => {
        console.error(`⚠️ Falha inesperada no aviso Telegram CANCELADO da estratégia ${est.id}:`, e.message);
    });
    limparEstadoSinal(estado);
    ioServer.emit('atualizar_interface');
    return true;
}

async function finalizarSinalRecuperado(est, estado, desfecho) {
    await aguardarInscricaoTelegram(estado);

    const nivel = Math.max(0, Math.trunc(Number(desfecho.nivel) || 0));
    estado.galeAtual = nivel;
    estado.aguardandoRecuperacao = false;
    if (normalizarColetorSeqCiclo(desfecho.coletor_seq) !== null) {
        estado.coletor_seq_ultimo_processado = normalizarColetorSeqCiclo(desfecho.coletor_seq);
    }

    const tipoHistorico = desfecho.tipo === 'TIE' ? 'TIE' : desfecho.tipo;
    const multiplicador = desfecho.tipo === 'TIE' ? String(desfecho.multiplicador || '4x') : '';
    const timestamp = Number(desfecho.timestamp_ms) || Date.now();

    if (desfecho.tipo === 'GREEN') {
        if (nivel === 0) est.stats.greenDireto++;
        else if (nivel === 1) est.stats.gale1++;
        else est.stats.gale2++;
    } else if (desfecho.tipo === 'TIE') {
        const chaveNivel = nivel === 0 ? 'direto' : (nivel === 1 ? 'gale1' : 'gale2');
        if (!est.stats.ties[chaveNivel]) est.stats.ties[chaveNivel] = {};
        if (!est.stats.ties[chaveNivel][multiplicador]) est.stats.ties[chaveNivel][multiplicador] = 0;
        est.stats.ties[chaveNivel][multiplicador]++;
    } else {
        est.stats.red++;
    }

    try {
        await registrarHistoricoResultadoEstrategia(est, tipoHistorico, nivel, multiplicador, timestamp);
    } catch (e) {
        console.error(`Falha ao persistir histórico recuperado da estratégia ${est.id}:`, e.message);
    }

    const snapshot = snapshotEstadoSinal(estado);

    try {
        await registrarHistoricoRobosInscritos(est, snapshot, tipoHistorico, nivel, multiplicador, timestamp);
    } catch (e) {
        console.error(`Falha ao persistir histórico recuperado dos robôs da estratégia ${est.id}:`, e.message);
    }

    let avisosProtecao = [];
    try {
        avisosProtecao = await processarResultadoProtecaoRobos(
            snapshot,
            desfecho.tipo === 'RED' ? 'RED' : (desfecho.tipo === 'TIE' ? 'TIE' : 'GREEN'),
            timestamp
        );
    } catch (e) {
        console.error(`Falha ao atualizar proteção recuperada dos robôs da estratégia ${est.id}:`, e.message);
    }

    if (desfecho.tipo === 'RED') {
        emitirAlertaWebRobo('RED', est, snapshot, { recuperado: true });
        void (async () => {
            await enviarTelegramParaInscritos('RED', est, snapshot, { recuperado: true });
            await enviarAvisosProtecaoTelegram(snapshot, avisosProtecao);
        })().catch(e => {
            console.error(`⚠️ Falha inesperada no Telegram RED recuperado da estratégia ${est.id}:`, e.message);
        });
    } else {
        const extrasFinal = {
            resultado: desfecho.tipo === 'TIE' ? 'TIE' : 'GREEN',
            multiplicador,
            recuperado: true
        };
        emitirAlertaWebRobo('GREEN', est, snapshot, extrasFinal);
        void enviarTelegramParaInscritos('GREEN', est, snapshot, extrasFinal).catch(e => {
            console.error(`⚠️ Falha inesperada no Telegram GREEN recuperado da estratégia ${est.id}:`, e.message);
        });
    }

    limparEstadoSinal(estado);

    if (est.is_dinamico) {
        try {
            await autoPilotIA.reavaliarDescarteEstrategia(est.id);
        } catch (e) {
            console.error(`⚠️ Auto Pilot IA: falha ao reavaliar descarte após recuperação de ${est.id}:`, e.message);
        }
    }

    ioServer.emit('atualizar_interface');
    return true;
}

async function recuperarUmSinalDoRoad(est, estado, snapshotRoad) {
    const historyCompleto = Array.isArray(snapshotRoad?.history) ? snapshotRoad.history : [];
    const history = historyCompleto.slice(-100);
    if (history.length === 0) return { processado: false, pendente: true };

    const origem = localizarIndiceOrigemRecuperacao(history, estado, snapshotRoad);
    if (origem.indice < 0) {
        const cancelado = await cancelarSinalIrrecuperavel(
            est,
            estado,
            `Sinal ${estado.ciclo_id || est.id} invalidado: rodada de origem não está mais no histórico de recuperação.`
        );
        return { processado: cancelado, cancelado };
    }

    const galeInicial = Math.max(0, Math.trunc(Number(estado.galeAtual) || 0));
    let nivel = galeInicial;
    let indice = origem.indice + galeInicial + 1;
    let processouRodada = false;
    const seqEntrada = normalizarColetorSeqCiclo(estado.coletor_seq_entrada);

    while (nivel <= Math.max(0, Number(est.gales) || 0) && indice < history.length) {
        const giro = history[indice];
        const resultado = String(giro?.resultado || '');
        if (!['Player', 'Banker', 'Tie'].includes(resultado)) {
            const cancelado = await cancelarSinalIrrecuperavel(
                est,
                estado,
                `Sinal ${estado.ciclo_id || est.id} invalidado: resultado histórico incompatível.`
            );
            return { processado: cancelado, cancelado };
        }

        const seqEsperada = seqEntrada !== null ? seqEntrada + nivel + 1 : null;
        const seqGiro = normalizarColetorSeqCiclo(giro?.coletor_seq);
        if (seqEsperada !== null && seqGiro !== null && seqGiro !== seqEsperada) {
            const cancelado = await cancelarSinalIrrecuperavel(
                est,
                estado,
                `Sinal ${estado.ciclo_id || est.id} invalidado: lacuna na sequência de rodadas recuperadas.`
            );
            return { processado: cancelado, cancelado };
        }

        processouRodada = true;
        const seqEfetiva = seqGiro !== null ? seqGiro : seqEsperada;
        if (seqEfetiva !== null) estado.coletor_seq_ultimo_processado = seqEfetiva;

        if (resultado === est.entrada) {
            const finalizado = await finalizarSinalRecuperado(est, estado, {
                tipo: 'GREEN',
                nivel,
                coletor_seq: seqEfetiva,
                timestamp_ms: giro?.timestamp_ms
            });
            return { processado: finalizado, finalizado };
        }

        if (resultado === 'Tie' && est.protegerEmpate) {
            const finalizado = await finalizarSinalRecuperado(est, estado, {
                tipo: 'TIE',
                nivel,
                multiplicador: multiplicadorTieRecuperado(giro),
                coletor_seq: seqEfetiva,
                timestamp_ms: giro?.timestamp_ms
            });
            return { processado: finalizado, finalizado };
        }

        if (nivel >= Math.max(0, Number(est.gales) || 0)) {
            const finalizado = await finalizarSinalRecuperado(est, estado, {
                tipo: 'RED',
                nivel,
                coletor_seq: seqEfetiva,
                timestamp_ms: giro?.timestamp_ms
            });
            return { processado: finalizado, finalizado };
        }

        nivel++;
        estado.galeAtual = nivel;
        const snapshotGale = snapshotEstadoSinal(estado);
        const extrasGale = { nivel, recuperado: true };
        emitirAlertaWebRobo('GALE', est, snapshotGale, extrasGale);
        void enviarTelegramParaInscritos('GALE', est, snapshotGale, extrasGale).catch(e => {
            console.error(`⚠️ Falha inesperada no Telegram GALE recuperado da estratégia ${est.id}:`, e.message);
        });
        indice++;
    }

    estado.aguardandoRecuperacao = false;
    estado.motivoRecuperacao = null;
    estado.recuperacaoMarcadaEm = null;
    ioServer.emit('atualizar_interface');
    return { processado: processouRodada, retomado: true };
}

async function recuperarSinaisAguardandoRecuperacao(snapshotRoad = null) {
    const pendentes = ESTRATEGIAS_MEMORIA.filter(est => {
        const estado = estadoApostas[est.id];
        return estado?.aguardandoResultado === true && estado?.aguardandoRecuperacao === true;
    });
    if (pendentes.length === 0) {
        return { processados: 0, encerrados: 0, cancelados: 0, retomados: 0 };
    }

    const snapshot = snapshotRoad && snapshotRoad.pronto === true
        ? snapshotRoad
        : integracaoContadorDiario.obterHistoricoCanonicoLive(100);
    if (!snapshot || snapshot.pronto !== true || !Array.isArray(snapshot.history) || snapshot.history.length === 0) {
        return { processados: 0, encerrados: 0, cancelados: 0, retomados: 0, aguardando_road: true };
    }

    const resumo = { processados: 0, encerrados: 0, cancelados: 0, retomados: 0 };
    for (const est of pendentes) {
        const estado = estadoApostas[est.id];
        if (!estado?.aguardandoResultado || !estado?.aguardandoRecuperacao) continue;
        const resultado = await recuperarUmSinalDoRoad(est, estado, snapshot);
        if (resultado.processado) resumo.processados++;
        if (resultado.finalizado) resumo.encerrados++;
        if (resultado.cancelado) resumo.cancelados++;
        if (resultado.retomado) resumo.retomados++;
    }
    return resumo;
}

global.__signalCycleRecoveryFromRoad = async snapshotRoad => {
    const liberar = await aguardarTurnoProcessamentoResultado();
    try {
        return await recuperarSinaisAguardandoRecuperacao(snapshotRoad);
    } finally {
        liberar();
    }
};

function ciclosAtivosPorRobo() {`
);

replaceExactly(
    'titulos telegram',
`    const titulos = {
        ENTRADA: '🎯 NOVA ENTRADA',
        GALE: `🔁 GALE ${Math.max(1, Number(extras.nivel) || 1)}`,
        GREEN: extras.resultado === 'TIE' ? '🟡 EMPATE PROTEGIDO' : '✅ GREEN CONFIRMADO',
        RED: '❌ RED CONFIRMADO'
    };`,
`    const titulos = {
        ENTRADA: '🎯 NOVA ENTRADA',
        GALE: `🔁 GALE ${Math.max(1, Number(extras.nivel) || 1)}`,
        GREEN: extras.resultado === 'TIE' ? '🟡 EMPATE PROTEGIDO' : '✅ GREEN CONFIRMADO',
        RED: '❌ RED CONFIRMADO',
        CANCELADO: '⚠️ SINAL CANCELADO'
    };`
);

replaceExactly(
    'linha cancelamento telegram',
`    if (tipo === 'ENTRADA') linhas.push('⏳ Aguardando resultado da mesa...');
    if (config.rodape) {`,
`    if (tipo === 'ENTRADA') linhas.push('⏳ Aguardando resultado da mesa...');
    if (tipo === 'CANCELADO') {
        linhas.push(`⚠️ ${String(extras.motivo || 'Sinal invalidado por instabilidade de conexão.')}`);
    }
    if (config.rodape) {`
);

replaceExactly(
    'espera inscricao telegram',
`async function aguardarInscricaoTelegram(estado) {
    if (!estado || !estado.telegramEntradaPromise) return;

    try {
        await estado.telegramEntradaPromise;
    } catch (e) {
        console.error('⚠️ Falha inesperada ao aguardar inscrição Telegram:', e.message);
    }
}

async function enviarTelegramParaInscritos(tipo, est, estado, extras = {}) {
    await aguardarInscricaoTelegram(estado);

    const inscritos = Array.isArray(estado.robosTelegramInscritos) ? estado.robosTelegramInscritos : [];`,
`async function aguardarInscricaoTelegram(estado) {
    if (!estado) return [];

    if (estado.telegramEntradaPromise) {
        try {
            const inscritosPromessa = await estado.telegramEntradaPromise;
            if (Array.isArray(inscritosPromessa)) return inscritosPromessa;
        } catch (e) {
            console.error('⚠️ Falha inesperada ao aguardar inscrição Telegram:', e.message);
        }
    }

    return Array.isArray(estado.robosTelegramInscritos) ? estado.robosTelegramInscritos : [];
}

async function enviarTelegramParaInscritos(tipo, est, estado, extras = {}) {
    const inscritosPromessa = await aguardarInscricaoTelegram(estado);

    const inscritosEstado = Array.isArray(estado.robosTelegramInscritos) ? estado.robosTelegramInscritos : [];
    const inscritos = inscritosEstado.length > 0 ? inscritosEstado : inscritosPromessa;`
);

replaceExactly(
    'identidade web',
`    ioServer.emit('alerta_painel', {
        tipo,
        nome: est.nome,
        entrada: est.entrada,
        padrao: est.padrao,
        assertividade: estado.assertividadeSinal,
        robosNotificados: robosWeb,
        ...extras
    });`,
`    ioServer.emit('alerta_painel', {
        tipo,
        nome: est.nome,
        entrada: est.entrada,
        padrao: est.padrao,
        assertividade: estado.assertividadeSinal,
        ciclo_id: estado.ciclo_id || null,
        coletor_seq_entrada: normalizarColetorSeqCiclo(estado.coletor_seq_entrada),
        robosNotificados: robosWeb,
        ...extras
    });`
);

replaceExactly(
    'recovery antes do loop de resultado',
`        let sinalFinalizadoAgora = false;

        for (let est of ESTRATEGIAS_MEMORIA) {
            let st = estadoApostas[est.id];
            if (st && st.aguardandoResultado) {
                let finalizar = false;
                let isTie = (vencedor==='Tie');`,
`        let sinalFinalizadoAgora = false;

        const resumoRecuperacao = await recuperarSinaisAguardandoRecuperacao();
        if (
            resumoRecuperacao.processados > 0
            || resumoRecuperacao.encerrados > 0
            || resumoRecuperacao.cancelados > 0
        ) {
            return;
        }

        for (let est of ESTRATEGIAS_MEMORIA) {
            let st = estadoApostas[est.id];
            if (st && st.aguardandoResultado) {
                if (st.aguardandoRecuperacao === true) continue;
                const seqResultado = normalizarColetorSeqCiclo(dados.coletor_seq);
                const seqUltimo = normalizarColetorSeqCiclo(st.coletor_seq_ultimo_processado);
                if (seqResultado !== null && seqUltimo !== null && seqResultado <= seqUltimo) continue;
                if (seqResultado !== null) st.coletor_seq_ultimo_processado = seqResultado;
                let finalizar = false;
                let isTie = (vencedor==='Tie');`
);

replaceExactly(
    'snapshot green',
`                    emitirAlertaWebRobo('GREEN', est, st, extrasFinal);
                    void enviarTelegramParaInscritos('GREEN', est, st, extrasFinal).catch(e => {
                        console.error(`⚠️ Falha inesperada no envio Telegram GREEN da estratégia ${est.id}:`, e.message);
                    });`,
`                    const snapshotFinal = snapshotEstadoSinal(st);
                    emitirAlertaWebRobo('GREEN', est, snapshotFinal, extrasFinal);
                    void enviarTelegramParaInscritos('GREEN', est, snapshotFinal, extrasFinal).catch(e => {
                        console.error(`⚠️ Falha inesperada no envio Telegram GREEN da estratégia ${est.id}:`, e.message);
                    });`
);

replaceExactly(
    'snapshot gale',
`                        st.galeAtual++;
                        const extrasGale = { nivel: st.galeAtual };
                        emitirAlertaWebRobo('GALE', est, st, extrasGale);
                        void enviarTelegramParaInscritos('GALE', est, st, extrasGale).catch(e => {
                            console.error(`⚠️ Falha inesperada no envio Telegram GALE da estratégia ${est.id}:`, e.message);
                        });`,
`                        st.galeAtual++;
                        const extrasGale = { nivel: st.galeAtual };
                        const snapshotGale = snapshotEstadoSinal(st);
                        emitirAlertaWebRobo('GALE', est, snapshotGale, extrasGale);
                        void enviarTelegramParaInscritos('GALE', est, snapshotGale, extrasGale).catch(e => {
                            console.error(`⚠️ Falha inesperada no envio Telegram GALE da estratégia ${est.id}:`, e.message);
                        });`
);

replaceExactly(
    'snapshot red',
`                        emitirAlertaWebRobo('RED', est, st);
                        void (async () => {
                            await enviarTelegramParaInscritos('RED', est, st);
                            await enviarAvisosProtecaoTelegram(st, avisosProtecao);
                        })().catch(e => {
                            console.error(`⚠️ Falha inesperada no envio Telegram RED/proteção da estratégia ${est.id}:`, e.message);
                        });`,
`                        const snapshotFinal = snapshotEstadoSinal(st);
                        emitirAlertaWebRobo('RED', est, snapshotFinal);
                        void (async () => {
                            await enviarTelegramParaInscritos('RED', est, snapshotFinal);
                            await enviarAvisosProtecaoTelegram(snapshotFinal, avisosProtecao);
                        })().catch(e => {
                            console.error(`⚠️ Falha inesperada no envio Telegram RED/proteção da estratégia ${est.id}:`, e.message);
                        });`
);

replaceExactly(
    'reset final',
`                if (finalizar) {
                    st.aguardandoResultado = false;
                    st.galeAtual = 0;
                    sinalFinalizadoAgora = true;`,
`                if (finalizar) {
                    limparEstadoSinal(st);
                    sinalFinalizadoAgora = true;`
);

replaceExactly(
    'criacao sinal com identidade',
`                        estadoApostas[est.id] = {
                            aguardandoResultado: true,
                            galeAtual: 0,
                            robosCiclo: unirRobosInscritos(selecaoRobos.todos),
                            robosWebInscritos: selecaoRobos.web,
                            robosTelegramInscritos: [],
                            robosInscritos: unirRobosInscritos(selecaoRobos.todos),
                            assertividadeSinal: selecaoRobos.assertividade,
                            mensagensEntrada: [],
                            mensagensGale: []
                        };

                        const estadoSinal = estadoApostas[est.id];
                        emitirAlertaWebRobo('ENTRADA', est, estadoSinal);
                        estadoSinal.telegramEntradaPromise = inscreverRobosTelegramEntrada(est, estadoSinal, selecaoRobos.telegram);`,
`                        const rodadaOrigem = historicoLiveCanonico[historicoLiveCanonico.length - 1] || {};
                        const seqProcessamento = normalizarColetorSeqCiclo(dados.coletor_seq);
                        const seqOrigemRoad = normalizarColetorSeqCiclo(rodadaOrigem.coletor_seq);
                        if (seqProcessamento === null) {
                            console.warn(`🔒 Sinal ${est.id} suprimido: rodada de origem sem coletor_seq recuperável.`);
                            continue;
                        }
                        if (seqOrigemRoad !== null && seqOrigemRoad !== seqProcessamento) {
                            console.warn(
                                `🔒 Sinal ${est.id} suprimido: ROAD está em seq=${seqOrigemRoad} `
                                + `enquanto o turno lógico processa seq=${seqProcessamento}.`
                            );
                            continue;
                        }
                        const seqOrigem = seqOrigemRoad || seqProcessamento;
                        const roundIdOrigem = String(
                            rodadaOrigem.round_id || rodadaOrigem.roundId || dados.rodada_origem || ''
                        ).trim() || null;

                        estadoApostas[est.id] = {
                            aguardandoResultado: true,
                            aguardandoRecuperacao: false,
                            galeAtual: 0,
                            ciclo_id: `${est.id}-${seqOrigem}`,
                            coletor_seq_entrada: seqOrigem,
                            coletor_seq_ultimo_processado: seqOrigem,
                            coletor_sessao_entrada: String(
                                dados.coletor_sessao || estadoLiveCanonico.coletor_sessao || ''
                            ).trim() || null,
                            round_id_entrada: roundIdOrigem,
                            robosCiclo: unirRobosInscritos(selecaoRobos.todos),
                            robosWebInscritos: selecaoRobos.web,
                            robosTelegramInscritos: [],
                            robosInscritos: unirRobosInscritos(selecaoRobos.todos),
                            assertividadeSinal: selecaoRobos.assertividade,
                            mensagensEntrada: [],
                            mensagensGale: []
                        };

                        const estadoSinal = estadoApostas[est.id];
                        emitirAlertaWebRobo('ENTRADA', est, snapshotEstadoSinal(estadoSinal));
                        estadoSinal.telegramEntradaPromise = inscreverRobosTelegramEntrada(est, estadoSinal, selecaoRobos.telegram);`
);

if (!source.includes('ciclo_id') || !source.includes('aguardandoRecuperacao')) {
    throw new Error('SIGNAL-CYCLE-01: validação final falhou');
}

module._compile(source, __filename);
