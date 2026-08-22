'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const bloco = (...linhas) => linhas.join('\n');

function contarOcorrencias(source, trecho) {
    if (!trecho) return 0;
    let total = 0;
    let cursor = 0;
    while ((cursor = source.indexOf(trecho, cursor)) >= 0) {
        total++;
        cursor += trecho.length;
    }
    return total;
}

function substituirExatamente(source, label, before, after) {
    const total = contarOcorrencias(source, before);
    if (total !== 1) {
        throw new Error(`MATERIALIZE: ${label} esperava 1 ocorrência e encontrou ${total}`);
    }
    return source.replace(before, after);
}

function extrairTransformacoesRaw(textoBruto, endMarker) {
    const texto = String(textoBruto || '').replace(/\r\n/g, '\n');
    const inicios = [];
    const reInicio = /^replaceExactly\(/gm;
    let match = null;
    while ((match = reInicio.exec(texto)) !== null) inicios.push(match.index);
    if (inicios.length === 0) throw new Error('MATERIALIZE: patch sem replaceExactly');

    const fimGlobal = texto.indexOf(endMarker, inicios[inicios.length - 1]);
    if (fimGlobal < 0) throw new Error(`MATERIALIZE: marcador final ausente: ${endMarker}`);

    const transforms = [];
    for (let i = 0; i < inicios.length; i++) {
        const inicio = inicios[i];
        const fim = i + 1 < inicios.length ? inicios[i + 1] : fimGlobal;
        const trecho = texto.slice(inicio, fim).trim();
        const labelMatch = trecho.match(/^replaceExactly\(\s*'([^']+)'\s*,/);
        if (!labelMatch) throw new Error(`MATERIALIZE: label inválido no bloco ${i + 1}`);
        const label = labelMatch[1];
        const inicioBefore = trecho.indexOf('`', labelMatch[0].length);
        const separador = /`,\s*\n\s*`/g;
        separador.lastIndex = inicioBefore + 1;
        const sep = separador.exec(trecho);
        if (inicioBefore < 0 || !sep) throw new Error(`MATERIALIZE: bloco inválido em ${label}`);
        const before = trecho.slice(inicioBefore + 1, sep.index);
        const inicioAfter = sep.index + sep[0].lastIndexOf('`');
        const close = /`\s*\);\s*$/.exec(trecho);
        if (!close) throw new Error(`MATERIALIZE: fechamento inválido em ${label}`);
        const after = trecho.slice(inicioAfter + 1, close.index);
        transforms.push({ label, before, after });
    }
    return transforms;
}

function aplicarTransformacoesRaw(source, patchText, endMarker) {
    let atual = source;
    for (const t of extrairTransformacoesRaw(patchText, endMarker)) {
        atual = substituirExatamente(atual, t.label, t.before, t.after);
    }
    return atual;
}

function aplicarBotPhase2Fixo(source) {
    source = substituirExatamente(
        source,
        'phase2 fila financeira dedicada',
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

    source = substituirExatamente(
        source,
        'phase2 snapshot temporal detector',
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

    // RED antes de GREEN: os blocos têm estrutura semelhante e a ordem original do patch
    // criava uma nova ocorrência falsa antes de procurar o RED.
    source = substituirExatamente(
        source,
        'phase2 red financeiro abertura',
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
    source = substituirExatamente(
        source,
        'phase2 red financeiro fechamento',
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

    source = substituirExatamente(
        source,
        'phase2 green financeiro abertura',
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
    source = substituirExatamente(
        source,
        'phase2 green financeiro fechamento',
        bloco('                    }', '                    finalizar = true;', '                } else {'),
        bloco('                        }', '                    });', '                    finalizar = true;', '                } else {')
    );

    source = substituirExatamente(
        source,
        'phase2 direto financeiro abertura',
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
    source = substituirExatamente(
        source,
        'phase2 direto financeiro fechamento',
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

    source = substituirExatamente(
        source,
        'phase2 gale financeiro abertura',
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
    source = substituirExatamente(
        source,
        'phase2 gale financeiro fechamento',
        bloco('                            }', '                        }', '                    } else {', '                        est.stats.red++;'),
        bloco('                                }', '                            }', '                        });', '                    } else {', '                        est.stats.red++;')
    );

    return source;
}

function aplicarRoadPhase2Fixo(source) {
    source = substituirExatamente(
        source,
        'phase2 road assinatura temporal',
        'function obterHistoricoCanonicoLive() {',
        'function obterHistoricoCanonicoLive(limiteSolicitado = LIMITE_HISTORY_CANONICO, coletorSeqMax = null) {'
    );
    return substituirExatamente(
        source,
        'phase2 road filtro temporal',
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
}

function aplicarPhase3Estatica(sourceInicial) {
    const { aplicarPhase3AoPatchPhase1 } = require('./signal_cycle_phase3_patch');
    const marker = "if (!source.includes('ciclo_id') || !source.includes('aguardandoRecuperacao')) {";
    const sintetico = aplicarPhase3AoPatchPhase1(marker);
    const pos = sintetico.lastIndexOf(marker);
    if (pos < 0) throw new Error('MATERIALIZE: programa Phase3 não materializado');
    const programa = sintetico.slice(0, pos);
    let source = sourceInicial;
    const replaceExactly = (label, before, after) => {
        source = substituirExatamente(source, label, before, after);
    };
    new Function('replaceExactly', `'use strict';\n${programa}`)(replaceExactly);
    return source;
}

function validarFonteFinal(nome, source) {
    for (const termo of [
        'signal_cycle_phase2_patch',
        'signal_cycle_phase3_patch',
        'substituirUnico(',
        'replaceExactly(',
        'module._compile(',
        'fs.readFileSync = function readFileSyncPhase2'
    ]) {
        if (source.includes(termo)) throw new Error(`${nome}: dependência de patch residual: ${termo}`);
    }
    if (/```/.test(source)) throw new Error(`${nome}: markdown residual detectado`);
    new vm.Script(source, { filename: nome });
}

const botBase = fs.readFileSync(path.join(ROOT, 'bot2_coletor.phase0.js'), 'utf8');
const phase1Patch = fs.readFileSync(path.join(ROOT, 'bot2_coletor.phase1_base.txt'), 'utf8');
let bot = aplicarBotPhase2Fixo(botBase);
bot = aplicarTransformacoesRaw(
    bot,
    phase1Patch,
    "if (!source.includes('ciclo_id') || !source.includes('aguardandoRecuperacao')) {"
);
bot = aplicarPhase3Estatica(bot);

for (const termo of [
    'const watermarkRecuperacaoPorRobo = new Map();',
    'function enfileirarTrabalhoFinanceiroAutoTrader(',
    'aguardandoRecuperacao',
    'ciclo_id',
    'coletor_seq_entrada',
    'seqTurnoDeteccao',
    'robosBloqueadosNoTurno',
    'async function recuperarSinaisAguardandoRecuperacao('
]) {
    if (!bot.includes(termo)) throw new Error(`bot2_coletor.js: estrutura obrigatória ausente: ${termo}`);
}
validarFonteFinal('bot2_coletor.js', bot);

const roadBase = fs.readFileSync(path.join(ROOT, 'bug051b_integration.phase0.js'), 'utf8');
const roadPhase1Patch = fs.readFileSync(path.join(ROOT, 'bug051b_integration.js'), 'utf8');
let road = aplicarRoadPhase2Fixo(roadBase);
road = aplicarTransformacoesRaw(road, roadPhase1Patch, 'module._compile(source, __filename);');
for (const termo of [
    'function obterHistoricoCanonicoLive(limiteSolicitado = LIMITE_HISTORY_CANONICO, coletorSeqMax = null)',
    'ultimo_coletor_seq:',
    'global.__signalCycleRecoveryFromRoad',
    'seqItem <= seqMax'
]) {
    if (!road.includes(termo)) throw new Error(`bug051b_integration.js: estrutura obrigatória ausente: ${termo}`);
}
validarFonteFinal('bug051b_integration.js', road);

fs.writeFileSync(path.join(ROOT, 'bot2_coletor.js'), bot.endsWith('\n') ? bot : `${bot}\n`, 'utf8');
fs.writeFileSync(path.join(ROOT, 'bug051b_integration.js'), road.endsWith('\n') ? road : `${road}\n`, 'utf8');
console.log(`MATERIALIZE OK | bot=${bot.length} chars | road=${road.length} chars`);
