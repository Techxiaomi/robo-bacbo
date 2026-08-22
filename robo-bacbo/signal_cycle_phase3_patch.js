'use strict';

function phase3Transforms() {
    const bloco3 = (...linhas) => linhas.join('\n');

    replaceExactly(
        'phase3 helpers watermark por robo',
        bloco3(
            'function normalizarColetorSeqCiclo(valor) {',
            '    const numero = Number(valor);',
            '    return Number.isSafeInteger(numero) && numero > 0 ? numero : null;',
            '}',
            '',
            'function snapshotEstadoSinal(estado) {'
        ),
        bloco3(
            'function normalizarColetorSeqCiclo(valor) {',
            '    const numero = Number(valor);',
            '    return Number.isSafeInteger(numero) && numero > 0 ? numero : null;',
            '}',
            '',
            'const watermarkRecuperacaoPorRobo = new Map();',
            '',
            'function idsRobosEstadoSinal(estado) {',
            '    const ids = new Set();',
            '    if (!estado || typeof estado !== "object") return [];',
            '    const listas = [',
            '        estado.robosCiclo,',
            '        estado.robosInscritos,',
            '        estado.robosWebInscritos,',
            '        estado.robosTelegramInscritos',
            '    ];',
            '    for (const lista of listas) {',
            '        for (const robo of (Array.isArray(lista) ? lista : [])) {',
            '            if (!robo || robo.id === undefined || robo.id === null) continue;',
            '            ids.add(String(robo.id));',
            '        }',
            '    }',
            '    return [...ids];',
            '}',
            '',
            'function chaveSessaoWatermarkRecuperacao(valor) {',
            '    return String(valor || "").trim() || "*";',
            '}',
            '',
            'function registrarWatermarkRecuperacao(estado, coletorSeq, coletorSessao = null) {',
            '    const seq = normalizarColetorSeqCiclo(coletorSeq);',
            '    if (seq === null) return null;',
            '    const sessao = chaveSessaoWatermarkRecuperacao(coletorSessao);',
            '    for (const roboId of idsRobosEstadoSinal(estado)) {',
            '        let porSessao = watermarkRecuperacaoPorRobo.get(roboId);',
            '        if (!porSessao) {',
            '            porSessao = new Map();',
            '            watermarkRecuperacaoPorRobo.set(roboId, porSessao);',
            '        }',
            '        const atual = normalizarColetorSeqCiclo(porSessao.get(sessao));',
            '        if (atual === null || seq > atual) porSessao.set(sessao, seq);',
            '    }',
            '    return seq;',
            '}',
            '',
            'function obterWatermarkRecuperacaoRobo(roboId, coletorSessao = null) {',
            '    const porSessao = watermarkRecuperacaoPorRobo.get(String(roboId));',
            '    if (!porSessao) return null;',
            '    const sessao = chaveSessaoWatermarkRecuperacao(coletorSessao);',
            '    const especifico = normalizarColetorSeqCiclo(porSessao.get(sessao));',
            '    if (especifico !== null) return especifico;',
            '    return normalizarColetorSeqCiclo(porSessao.get("*"));',
            '}',
            '',
            'function maiorColetorSeqSnapshotRecuperacao(snapshotRoad) {',
            '    let maior = normalizarColetorSeqCiclo(snapshotRoad?.ultimo_coletor_seq);',
            '    const history = Array.isArray(snapshotRoad?.history) ? snapshotRoad.history : [];',
            '    for (const giro of history) {',
            '        const seq = normalizarColetorSeqCiclo(giro?.coletor_seq ?? giro?.coletorSeq);',
            '        if (seq !== null && (maior === null || seq > maior)) maior = seq;',
            '    }',
            '    return maior;',
            '}',
            '',
            'function snapshotEstadoSinal(estado) {'
        )
    );

    replaceExactly(
        'phase3 watermark no inicio da recovery',
        bloco3(
            'async function recuperarUmSinalDoRoad(est, estado, snapshotRoad) {',
            '    const historyCompleto = Array.isArray(snapshotRoad?.history) ? snapshotRoad.history : [];',
            '    const history = historyCompleto.slice(-100);',
            '    if (history.length === 0) return { processado: false, pendente: true };',
            '',
            '    const origem = localizarIndiceOrigemRecuperacao(history, estado, snapshotRoad);'
        ),
        bloco3(
            'async function recuperarUmSinalDoRoad(est, estado, snapshotRoad) {',
            '    const historyCompleto = Array.isArray(snapshotRoad?.history) ? snapshotRoad.history : [];',
            '    const history = historyCompleto.slice(-100);',
            '    if (history.length === 0) return { processado: false, pendente: true };',
            '',
            '    const watermarkSnapshot = maiorColetorSeqSnapshotRecuperacao(snapshotRoad);',
            '    if (watermarkSnapshot !== null) {',
            '        registrarWatermarkRecuperacao(',
            '            estado,',
            '            watermarkSnapshot,',
            '            snapshotRoad?.coletor_sessao || estado?.coletor_sessao_entrada',
            '        );',
            '    }',
            '',
            '    const origem = localizarIndiceOrigemRecuperacao(history, estado, snapshotRoad);'
        )
    );

    replaceExactly(
        'phase3 assinatura selecao por contexto',
        'async function selecionarRobosParaEstrategia(est, historicoLiveCanonico) {',
        'async function selecionarRobosParaEstrategia(est, historicoLiveCanonico, contextoDeteccao = {}) {'
    );

    replaceExactly(
        'phase3 contexto selecao robos',
        bloco3(
            '    const assertividade = calcularAssertividadeLiveCanonica(est, historicoLiveCanonico);',
            '    const ciclosAtivos = ciclosAtivosPorRobo();',
            '    const bloqueados = [];',
            '    const elegiveis = ROBOS_MEMORIA.filter(robo => {'
        ),
        bloco3(
            '    const assertividade = calcularAssertividadeLiveCanonica(est, historicoLiveCanonico);',
            '    const ciclosAtivos = ciclosAtivosPorRobo();',
            '    const bloqueados = [];',
            '    const seqTurnoDeteccao = normalizarColetorSeqCiclo(contextoDeteccao.coletor_seq);',
            '    const sessaoTurnoDeteccao = String(contextoDeteccao.coletor_sessao || "").trim();',
            '    const robosBloqueadosNoTurno = contextoDeteccao.robosBloqueadosNoTurno instanceof Set',
            '        ? contextoDeteccao.robosBloqueadosNoTurno',
            '        : new Set(Array.isArray(contextoDeteccao.robosBloqueadosNoTurno) ? contextoDeteccao.robosBloqueadosNoTurno.map(String) : []);',
            '    const elegiveis = ROBOS_MEMORIA.filter(robo => {'
        )
    );

    replaceExactly(
        'phase3 filtros isolamento watermark',
        bloco3(
            '        const ciclo = ciclosAtivos.get(String(robo.id));',
            '        if (ciclo) {',
            '            bloqueados.push({ ...snapshotPublicoRobo(robo), ...ciclo });',
            '            return false;',
            '        }',
            '        return true;'
        ),
        bloco3(
            '        const ciclo = ciclosAtivos.get(String(robo.id));',
            '        if (ciclo) {',
            '            bloqueados.push({ ...snapshotPublicoRobo(robo), ...ciclo });',
            '            return false;',
            '        }',
            '',
            '        if (robosBloqueadosNoTurno.has(String(robo.id))) {',
            '            bloqueados.push({',
            '                ...snapshotPublicoRobo(robo),',
            '                estrategia_id: "FINALIZADO_NESTE_TURNO",',
            '                gale_atual: 0',
            '            });',
            '            return false;',
            '        }',
            '',
            '        const watermark = obterWatermarkRecuperacaoRobo(robo.id, sessaoTurnoDeteccao);',
            '        if (seqTurnoDeteccao !== null && watermark !== null && seqTurnoDeteccao <= watermark) {',
            '            bloqueados.push({',
            '                ...snapshotPublicoRobo(robo),',
            '                estrategia_id: `WATERMARK_RECOVERY<=${watermark}`,',
            '                gale_atual: 0,',
            '                watermark_recuperacao: watermark',
            '            });',
            '            return false;',
            '        }',
            '        return true;'
        )
    );

    replaceExactly(
        'phase3 recovery nao bloqueia robos independentes',
        bloco3(
            '        let sinalFinalizadoAgora = false;',
            '',
            '        const resumoRecuperacao = await recuperarSinaisAguardandoRecuperacao();',
            '        if (',
            '            resumoRecuperacao.processados > 0',
            '            || resumoRecuperacao.encerrados > 0',
            '            || resumoRecuperacao.cancelados > 0',
            '        ) {',
            '            return;',
            '        }',
            '',
            '        for (let est of ESTRATEGIAS_MEMORIA) {'
        ),
        bloco3(
            '        await recuperarSinaisAguardandoRecuperacao();',
            '        const robosBloqueadosNoTurno = new Set();',
            '',
            '        for (let est of ESTRATEGIAS_MEMORIA) {'
        )
    );

    replaceExactly(
        'phase3 finalizacao bloqueia somente robos do ciclo no turno',
        bloco3(
            '                if (finalizar) {',
            '                    limparEstadoSinal(st);',
            '                    sinalFinalizadoAgora = true;'
        ),
        bloco3(
            '                if (finalizar) {',
            '                    for (const roboId of idsRobosEstadoSinal(st)) {',
            '                        robosBloqueadosNoTurno.add(roboId);',
            '                    }',
            '                    limparEstadoSinal(st);'
        )
    );

    replaceExactly(
        'phase3 remove retorno global apos finalizacao',
        bloco3(
            '        if (sinalFinalizadoAgora) return;',
            '',
            '        const maiorPadraoLive = ESTRATEGIAS_MEMORIA.reduce((maior, est) => {'
        ),
        '        const maiorPadraoLive = ESTRATEGIAS_MEMORIA.reduce((maior, est) => {'
    );

    replaceExactly(
        'phase3 remove ocupado global',
        bloco3(
            '        let ocupado = Object.values(estadoApostas).some(e => e.aguardandoResultado);',
            '        if (!ocupado) {',
            '            for (let est of ESTRATEGIAS_MEMORIA) {',
            '                if (!est.ativo) continue;'
        ),
        bloco3(
            '        for (let est of ESTRATEGIAS_MEMORIA) {',
            '            if (!est.ativo) continue;',
            '            if (estadoApostas[est.id]?.aguardandoResultado === true) continue;'
        )
    );

    replaceExactly(
        'phase3 selecao recebe watermark e bloqueio por turno',
        '                            selecaoRobos = await selecionarRobosParaEstrategia(est, historicoLiveCanonico);',
        bloco3(
            '                            selecaoRobos = await selecionarRobosParaEstrategia(',
            '                                est,',
            '                                historicoLiveCanonico,',
            '                                {',
            '                                    coletor_seq: seqTurnoDeteccao,',
            '                                    coletor_sessao: dados.coletor_sessao,',
            '                                    robosBloqueadosNoTurno',
            '                                }',
            '                            );'
        )
    );

    replaceExactly(
        'phase3 continua avaliando outras estrategias',
        bloco3(
            '                                }',
            '                            }',
            '                        }',
            '                        });',
            '                        break;',
            '                    }',
            '                }',
            '            }',
            '        }'
        ),
        bloco3(
            '                                }',
            '                            }',
            '                        }',
            '                        });',
            '                        continue;',
            '                    }',
            '                }',
            '            }'
        )
    );
}

function aplicarPhase3AoPatchPhase1(sourcePatch) {
    const marker = "if (!source.includes('ciclo_id') || !source.includes('aguardandoRecuperacao')) {";
    const primeiro = sourcePatch.indexOf(marker);
    if (primeiro < 0 || sourcePatch.indexOf(marker, primeiro + marker.length) >= 0) {
        throw new Error('SIGNAL-CYCLE-03: marcador final da fase 1 ausente ou ambiguo');
    }
    const injecao = `\n${phase3Transforms.toString()}\n\nphase3Transforms();\n\n`;
    return sourcePatch.slice(0, primeiro) + injecao + sourcePatch.slice(primeiro);
}

module.exports = { aplicarPhase3AoPatchPhase1 };
