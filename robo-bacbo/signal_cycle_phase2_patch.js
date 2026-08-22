'use strict';

function contarOcorrencias(source, trecho) {
    if (!trecho) return 0;
    let total = 0;
    let cursor = 0;
    while (true) {
        const indice = source.indexOf(trecho, cursor);
        if (indice < 0) return total;
        total++;
        cursor = indice + trecho.length;
    }
}

function substituirUnico(source, label, before, after) {
    const total = contarOcorrencias(source, before);
    if (total !== 1) {
        throw new Error(`SIGNAL-CYCLE-02: ${label} esperava 1 ocorrência e encontrou ${total}`);
    }
    return source.replace(before, after);
}

function bloco(...linhas) {
    return linhas.join('\n');
}

function aplicarBotPhase2(source) {
    source = substituirUnico(
        source,
        'fila financeira dedicada',
        bloco(
            'let caudaProcessamentoResultados = Promise.resolve();',
            'let resultadosAguardandoProcessamento = 0;',
            '',
            'function aguardarTurnoProcessamentoResultado() {'
        ),
        bloco(
            'let caudaProcessamentoResultados = Promise.resolve();',
            'let resultadosAguardandoProcessamento = 0;',
            'let caudaProcessamentoFinanceiroAutoTrader = Promise.resolve();',
            'let trabalhosFinanceirosAutoTraderPendentes = 0;',
            '',
            'function enfileirarTrabalhoFinanceiroAutoTrader(descricao, tarefa) {',
            "    const rotulo = String(descricao || 'AUTO_TRADER');",
            '    trabalhosFinanceirosAutoTraderPendentes++;',
            '',
            '    const executar = async () => {',
            '        try {',
            '            await tarefa();',
            '        } catch (e) {',
            "            console.error('🔥 AUTO-TRADER ASYNC | ' + rotulo + ' falhou fora do FIFO de sinais:', e.message);",
            '        } finally {',
            '            trabalhosFinanceirosAutoTraderPendentes = Math.max(0, trabalhosFinanceirosAutoTraderPendentes - 1);',
            '        }',
            '    };',
            '',
            '    const proxima = caudaProcessamentoFinanceiroAutoTrader.then(executar, executar);',
            '    caudaProcessamentoFinanceiroAutoTrader = proxima.catch(e => {',
            "        console.error('🔥 AUTO-TRADER ASYNC | falha inesperada na cauda financeira:', e.message);",
            '    });',
            '    return proxima;',
            '}',
            '',
            'function aguardarTurnoProcessamentoResultado() {'
        )
    );

    source = substituirUnico(
        source,
        'snapshot temporal do detector',
        bloco(
            '        const estadoLiveCanonico = integracaoContadorDiario.obterHistoricoCanonicoLive(',
            '            Math.max(1, maiorPadraoLive)',
            '        );'
        ),
        bloco(
            '        const seqTurnoDeteccao = normalizarColetorSeqCiclo(dados.coletor_seq);',
            '        if (seqTurnoDeteccao === null) {',
            '            return;',
            '        }',
            '        const estadoLiveCanonico = integracaoContadorDiario.obterHistoricoCanonicoLive(',
            '            Math.max(1, maiorPadraoLive),',
            '            seqTurnoDeteccao',
            '        );'
        )
    );

    source = substituirUnico(
        source,
        'green financeiro fora do FIFO',
        bloco(
            '                    if (est.quarentena_restante <= 0) {',
            '                        for (let trader of AUTO_TRADERS_MEMORIA) {',
            '                            let cf = trader.config;',
            "                            if (trader.ativo && (trader.status_operacao === 'OPERANDO' || trader.status_operacao === 'STANDBY') && autoTraderAutorizaEstrategia(cf, est, ROBOS_MEMORIA)) {"
        ),
        bloco(
            "                    void enfileirarTrabalhoFinanceiroAutoTrader('GREEN:' + String(st.ciclo_id || est.id), async () => {",
            '                        if (est.quarentena_restante <= 0) {',
            '                            for (let trader of AUTO_TRADERS_MEMORIA) {',
            '                                let cf = trader.config;',
            "                                if (trader.ativo && (trader.status_operacao === 'OPERANDO' || trader.status_operacao === 'STANDBY') && autoTraderAutorizaEstrategia(cf, est, ROBOS_MEMORIA)) {"
        )
    );

    source = substituirUnico(
        source,
        'fechamento green financeiro',
        bloco(
            '                    }',
            '                    finalizar = true;',
            '                } else {'
        ),
        bloco(
            '                        }',
            '                    });',
            '                    finalizar = true;',
            '                } else {'
        )
    );

    source = substituirUnico(
        source,
        'red financeiro fora do FIFO',
        bloco(
            '                        if (est.quarentena_restante <= 0) {',
            '                            for (let trader of AUTO_TRADERS_MEMORIA) {',
            '                                let cf = trader.config;',
            "                                if (trader.ativo && (trader.status_operacao === 'OPERANDO' || trader.status_operacao === 'STANDBY') && autoTraderAutorizaEstrategia(cf, est, ROBOS_MEMORIA)) {"
        ),
        bloco(
            "                        void enfileirarTrabalhoFinanceiroAutoTrader('RED:' + String(st.ciclo_id || est.id), async () => {",
            '                            if (est.quarentena_restante <= 0) {',
            '                                for (let trader of AUTO_TRADERS_MEMORIA) {',
            '                                    let cf = trader.config;',
            "                                    if (trader.ativo && (trader.status_operacao === 'OPERANDO' || trader.status_operacao === 'STANDBY') && autoTraderAutorizaEstrategia(cf, est, ROBOS_MEMORIA)) {"
        )
    );

    source = substituirUnico(
        source,
        'fechamento red financeiro',
        bloco(
            '                        }',
            '                        finalizar = true;',
            '                    }',
            '                }',
            '                if (finalizar) {'
        ),
        bloco(
            '                            }',
            '                        });',
            '                        finalizar = true;',
            '                    }',
            '                }',
            '                if (finalizar) {'
        )
    );

    source = substituirUnico(
        source,
        'direto financeiro fora do FIFO',
        bloco(
            '                        const estadoSinal = estadoApostas[est.id];',
            "                        emitirAlertaWebRobo('ENTRADA', est, estadoSinal);",
            '                        estadoSinal.telegramEntradaPromise = inscreverRobosTelegramEntrada(est, estadoSinal, selecaoRobos.telegram);',
            '',
            '                        if (est.quarentena_restante <= 0) {',
            '                            for (let trader of AUTO_TRADERS_MEMORIA) {',
            '                                let cf = trader.config;',
            "                                if (trader.ativo && trader.status_operacao === 'OPERANDO' && autoTraderAutorizaEstrategia(cf, est, ROBOS_MEMORIA)) {"
        ),
        bloco(
            '                        const estadoSinal = estadoApostas[est.id];',
            "                        emitirAlertaWebRobo('ENTRADA', est, estadoSinal);",
            '                        estadoSinal.telegramEntradaPromise = inscreverRobosTelegramEntrada(est, estadoSinal, selecaoRobos.telegram);',
            '',
            "                        void enfileirarTrabalhoFinanceiroAutoTrader('ENTRADA:' + String(estadoSinal.ciclo_id || est.id), async () => {",
            '                            if (est.quarentena_restante <= 0) {',
            '                                for (let trader of AUTO_TRADERS_MEMORIA) {',
            '                                    let cf = trader.config;',
            "                                    if (trader.ativo && trader.status_operacao === 'OPERANDO' && autoTraderAutorizaEstrategia(cf, est, ROBOS_MEMORIA)) {"
        )
    );

    source = substituirUnico(
        source,
        'fechamento direto financeiro',
        bloco(
            '                                }',
            '                            }',
            '                        }',
            '                        break;',
            '                    }',
            '                }',
            '            }',
            '        }'
        ),
        bloco(
            '                                }',
            '                            }',
            '                        }',
            '                        });',
            '                        break;',
            '                    }',
            '                }',
            '            }',
            '        }'
        )
    );

    source = substituirUnico(
        source,
        'gale financeiro fora do FIFO',
        bloco(
            '                        if (est.quarentena_restante <= 0) {',
            '                            for (let trader of AUTO_TRADERS_MEMORIA) {',
            '                                let cf = trader.config;',
            "                                if (trader.ativo && trader.status_operacao === 'OPERANDO' && autoTraderAutorizaEstrategia(cf, est, ROBOS_MEMORIA)) {"
        ),
        bloco(
            '                        const estadoFinanceiroGale = { ...st, galeAtual: st.galeAtual };',
            "                        void enfileirarTrabalhoFinanceiroAutoTrader('GALE:' + String(st.ciclo_id || est.id) + ':' + String(st.galeAtual), async () => {",
            '                            const st = estadoFinanceiroGale;',
            '                            if (est.quarentena_restante <= 0) {',
            '                                for (let trader of AUTO_TRADERS_MEMORIA) {',
            '                                    let cf = trader.config;',
            "                                    if (trader.ativo && trader.status_operacao === 'OPERANDO' && autoTraderAutorizaEstrategia(cf, est, ROBOS_MEMORIA)) {"
        )
    );

    source = substituirUnico(
        source,
        'fechamento gale financeiro',
        bloco(
            '                            }',
            '                        }',
            '                    } else {',
            '                        est.stats.red++;'
        ),
        bloco(
            '                                }',
            '                            }',
            '                        });',
            '                    } else {',
            '                        est.stats.red++;'
        )
    );

    return source;
}

function aplicarRoadPhase2(source) {
    source = substituirUnico(
        source,
        'assinatura snapshot por seq',
        'function obterHistoricoCanonicoLive() {',
        'function obterHistoricoCanonicoLive(limiteSolicitado = LIMITE_HISTORY_CANONICO, coletorSeqMax = null) {'
    );

    source = substituirUnico(
        source,
        'filtro temporal road',
        bloco(
            '    const cronologico = historyCronologicoRoad(',
            '        estadoCanonicoEvolution.history,',
            '        estadoCanonicoEvolution.orientacao',
            '    );',
            '    const cauda = cronologico.slice(-LIMITE_HISTORY_CANONICO);',
            '    const history = cauda.map(item => {'
        ),
        bloco(
            '    const cronologico = historyCronologicoRoad(',
            '        estadoCanonicoEvolution.history,',
            '        estadoCanonicoEvolution.orientacao',
            '    );',
            '    const limiteNumero = Number(limiteSolicitado);',
            '    const limite = Number.isSafeInteger(limiteNumero) && limiteNumero > 0',
            '        ? Math.min(LIMITE_HISTORY_CANONICO, limiteNumero)',
            '        : LIMITE_HISTORY_CANONICO;',
            '    const seqMax = sequenciaColetorRoad(coletorSeqMax);',
            '    const ultimoSeq = sequenciaColetorRoad(estadoCanonicoEvolution.ultimo_coletor_seq);',
            '    const primeiroSeqInferido = ultimoSeq !== null',
            '        ? ultimoSeq - (cronologico.length - 1)',
            '        : null;',
            '    const cronologicoAlinhado = cronologico.map((item, indice) => {',
            '        const seqExplicita = sequenciaColetorRoad(item?.coletorSeq || item?.coletor_seq);',
            '        const seqInferida = primeiroSeqInferido !== null && primeiroSeqInferido + indice > 0',
            '            ? primeiroSeqInferido + indice',
            '            : null;',
            '        const seqEfetiva = seqExplicita !== null ? seqExplicita : seqInferida;',
            '        return seqEfetiva === null ? item : { ...item, coletorSeq: seqEfetiva };',
            '    });',
            '    const visivelAteTurno = seqMax === null',
            '        ? cronologicoAlinhado',
            '        : cronologicoAlinhado.filter(item => {',
            '            const seqItem = sequenciaColetorRoad(item?.coletorSeq || item?.coletor_seq);',
            '            return seqItem !== null && seqItem <= seqMax;',
            '        });',
            '    const cauda = visivelAteTurno.slice(-limite);',
            '    const history = cauda.map(item => {'
        )
    );

    return source;
}

module.exports = {
    aplicarBotPhase2,
    aplicarRoadPhase2
};
