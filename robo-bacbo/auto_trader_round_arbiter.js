'use strict';

const { obterMesaRuntime } = require('./mesa_runtime_context');

function normalizarAlvoFinanceiro(valor) {
    const alvo = String(valor || '').trim().toUpperCase();
    if (['PLAYER', 'PLAYERWON', 'JOGADOR'].includes(alvo)) return 'Player';
    if (['BANKER', 'BANKERWON', 'BANCA'].includes(alvo)) return 'Banker';
    return '';
}

function numeroLimitado(valor, minimo, maximo, padrao = 0) {
    const numero = Number(valor);
    if (!Number.isFinite(numero)) return padrao;
    return Math.max(minimo, Math.min(maximo, numero));
}

function resolverArbitragemSinaisAutoTrader(candidatosBrutos = []) {
    const unicos = new Map();

    for (const candidato of Array.isArray(candidatosBrutos) ? candidatosBrutos : []) {
        const estrategiaId = String(candidato?.estrategia_id || '').trim();
        const alvo = normalizarAlvoFinanceiro(candidato?.alvo);
        if (!estrategiaId || !alvo) continue;

        const item = {
            estrategia_id: estrategiaId,
            alvo,
            assertividade: numeroLimitado(candidato?.assertividade, 0, 100, 0),
            gales: Math.max(0, Math.trunc(Number(candidato?.gales) || 0))
        };

        const chave = `${item.estrategia_id}|${item.alvo}`;
        if (!unicos.has(chave)) unicos.set(chave, item);
    }

    const candidatos = [...unicos.values()];
    if (candidatos.length === 0) {
        return {
            permitido: false,
            motivo: 'SEM_OPORTUNIDADE',
            alvo: null,
            estrategia_id: null,
            quantidade: 0,
            candidatos: []
        };
    }

    const direcoes = [...new Set(candidatos.map(item => item.alvo))];
    if (direcoes.length !== 1) {
        return {
            permitido: false,
            motivo: 'CONFLITO_DIRECAO',
            alvo: null,
            estrategia_id: null,
            quantidade: candidatos.length,
            direcoes: [...direcoes].sort(),
            candidatos
        };
    }

    candidatos.sort((a, b) => {
        if (b.assertividade !== a.assertividade) return b.assertividade - a.assertividade;
        if (a.gales !== b.gales) return a.gales - b.gales;
        return String(a.estrategia_id).localeCompare(String(b.estrategia_id));
    });

    const lider = candidatos[0];
    return {
        permitido: true,
        motivo: null,
        alvo: lider.alvo,
        estrategia_id: lider.estrategia_id,
        assertividade: lider.assertividade,
        gales: lider.gales,
        quantidade: candidatos.length,
        candidatos
    };
}

function criarArbitroFinanceiroAutoTrader(deps = {}) {
    const gatesMemoria = new Set();

    const log = deps.log || console;
    const dbPool = deps.dbPool;
    const mesaRuntime = obterMesaRuntime();

    if (!dbPool || typeof dbPool.query !== 'function') {
        throw new Error('MC21: dbPool ausente ao criar arbitro financeiro');
    }
    if (!Number.isInteger(Number(mesaRuntime?.id)) || Number(mesaRuntime.id) <= 0) {
        throw new Error('MC22-L: mesa do runtime ausente ao criar arbitro financeiro');
    }

    function chaveGateTrader(traderId) {
        return `${mesaRuntime.id}:${Number(traderId)}`;
    }

    async function traderPertenceMesaAtual(traderId) {
        const [linhas] = await dbPool.query(
            `SELECT mesa_id
             FROM auto_traders
             WHERE id=?
             LIMIT 1`,
            [Number(traderId)]
        );
        if (!Array.isArray(linhas) || linhas.length !== 1) return false;
        return Number(linhas[0].mesa_id) === Number(mesaRuntime.id);
    }

    async function listarOrdensFinanceirasEmAbertoTrader(traderId) {
        const [linhas] = await dbPool.query(
            `SELECT id, estrategia_id, status_ordem, executor_order_id
             FROM auditoria_ordens
             WHERE trader_id=?
               AND mesa_id=?
               AND status_ordem IN ('PREPARANDO','PENDENTE','ENVIO_AMBIGUO')
             ORDER BY id ASC
             LIMIT 2`,
            [Number(traderId), mesaRuntime.id]
        );
        return Array.isArray(linhas) ? linhas : [];
    }

    function criarMapaRodada(rodada) {
        return {
            rodada: Math.max(0, Math.trunc(Number(rodada) || 0)),
            porTrader: new Map()
        };
    }

    function registrarCandidato(mapa, trader, est, estadoSinal) {
        if (!mapa?.porTrader || !trader || !est || !estadoSinal) return false;

        const traderId = Number(trader.id);
        const estrategiaId = String(est.id || '').trim();
        if (!Number.isInteger(traderId) || traderId <= 0 || !estrategiaId) return false;

        const chave = String(traderId);
        let registro = mapa.porTrader.get(chave);
        if (!registro) {
            registro = { trader_id: traderId, candidatos: [] };
            mapa.porTrader.set(chave, registro);
        }

        if (registro.candidatos.some(item => String(item.estrategia_id) === estrategiaId)) {
            return false;
        }

        registro.candidatos.push({
            estrategia_id: estrategiaId,
            alvo: String(est.entrada || ''),
            assertividade: numeroLimitado(estadoSinal.assertividadeSinal, 0, 100, 0),
            gales: Math.max(0, Math.trunc(Number(est.gales) || 0)),
            est,
            estadoSinal
        });
        return true;
    }

    function adquirirGate(traderId) {
        const chave = chaveGateTrader(traderId);
        if (!chave || gatesMemoria.has(chave)) return false;
        gatesMemoria.add(chave);
        return true;
    }

    function liberarGate(traderId) {
        gatesMemoria.delete(chaveGateTrader(traderId));
    }

    async function executarEntradaDireta(trader, est, decisao) {
        const traderId = Number(trader.id);
        if (!adquirirGate(traderId)) {
            log.warn(`⛔ MC21 SINGLE-FLIGHT | Trader ${traderId}: preparação concorrente bloqueada.`);
            return false;
        }

        try {
            if (!(await traderPertenceMesaAtual(traderId))) {
                log.warn(
                    `⛔ MC22-M | Trader ${traderId} não pertence à mesa ${mesaRuntime.codigo}; `
                    + 'entrada financeira bloqueada.'
                );
                return false;
            }
            if (!trader.ativo || trader.status_operacao !== 'OPERANDO') return false;

            const cf = trader.config || {};
            if (!deps.traderDentroHorarioExecucao(cf)) {
                log.log(`Trader ${trader.id} fora das faixas de execução (${deps.formatarFaixasHorario(cf)}). Oportunidade arbitrada ignorada.`);
                return false;
            }

            if (cf.limite_entradas && trader.entradas_feitas >= cf.limite_entradas) {
                trader.status_operacao = 'META_ATINGIDA';
                try {
                    await dbPool.query(
                        'UPDATE auto_traders SET status_operacao=? WHERE id=? AND mesa_id=?',
                        ['META_ATINGIDA', trader.id, mesaRuntime.id]
                    );
                } catch (e) {
                    log.error(`❌ Falha ao persistir META_ATINGIDA do trader ${trader.id}:`, e.message);
                }
                return false;
            }

            const abertasAntesAleatoriedade = await listarOrdensFinanceirasEmAbertoTrader(trader.id);
            if (abertasAntesAleatoriedade.length > 0) {
                log.warn(`⛔ MC21 SINGLE-FLIGHT | Trader ${trader.id}: oportunidade bloqueada por ordem/intenção financeira já aberta.`);
                return false;
            }

            if (!(await deps.prepararEntradaCicloAutoTrader(trader))) return false;
            if (!(await deps.autorizarNovaEntradaFinanceiraTrader(trader))) return false;

            const planoDireto = deps.calcularPlanoAposta(cf, est, 0);
            if (!planoDireto.ok) {
                log.error(`❌ Entrada arbitrada do trader ${trader.id} bloqueada: ${planoDireto.motivo}`);
                return false;
            }

            const valorArredondado = planoDireto.valor_principal;
            const valorEmpateDireto = planoDireto.valor_empate;
            const alvoPython = planoDireto.apostas[0].alvo;
            const ordemExecutorIdDireto = deps.crypto.randomUUID();

            let intencaoDireto = null;
            try {
                intencaoDireto = await deps.criarIntencaoOrdem(dbPool, {
                    trader_id: trader.id,
                    estrategia_id: est.id,
                    estrategia_nome: est.nome,
                    fonte_sinal: est.origem,
                    alvo: alvoPython,
                    nivel: 'DIRETO',
                    risco_total: planoDireto.exposicao_etapa,
                    valor_entrada: valorArredondado,
                    valor_empate: valorEmpateDireto,
                    order_id: ordemExecutorIdDireto
                });
            } catch (e) {
                log.error(`❌ Ordem DIRETO arbitrada do trader ${trader.id} bloqueada antes do executor:`, e.message);
                return false;
            }

            let executorConfirmouDireto = false;
            try {
                const confirmacaoExecutorDireto = await deps.enviarOrdemAoExecutor(
                    alvoPython,
                    valorArredondado,
                    ordemExecutorIdDireto,
                    planoDireto.apostas
                );
                executorConfirmouDireto = true;
                const evidenciaDireto = confirmacaoExecutorDireto.execucao.confirmacao;

                const conexao = await dbPool.getConnection();
                try {
                    await conexao.beginTransaction();
                    const novasEntradas = trader.entradas_feitas + 1;
                    const [traderAtualizado] = await conexao.query(
                        'UPDATE auto_traders SET entradas_feitas=? WHERE id=? AND mesa_id=?',
                        [novasEntradas, trader.id, mesaRuntime.id]
                    );
                    if (Number(traderAtualizado.affectedRows) !== 1) {
                        throw new Error('Auto-Trader não pertence à mesa atual ao confirmar entrada DIRETO');
                    }
                    const [auditoriaAtualizada] = await conexao.query(
                        `UPDATE auditoria_ordens
                         SET status_ordem='PENDENTE', executor_confirmacao_metodo=?,
                             executor_saldo_antes=?, executor_saldo_depois=?,
                             executor_debito_observado=?, execucao_confirmada_em=?
                         WHERE id=? AND executor_order_id=? AND status_ordem='PREPARANDO'
                           AND mesa_id=?`,
                        [
                            evidenciaDireto.metodo,
                            evidenciaDireto.saldo_antes,
                            evidenciaDireto.saldo_depois,
                            evidenciaDireto.debito_observado,
                            evidenciaDireto.confirmada_em,
                            intencaoDireto.auditoria_id,
                            ordemExecutorIdDireto,
                            mesaRuntime.id
                        ]
                    );
                    if (Number(auditoriaAtualizada.affectedRows) !== 1) {
                        throw new Error('Intenção PREPARANDO DIRETO não encontrada após ACK do executor na mesa atual');
                    }
                    await conexao.commit();
                    trader.entradas_feitas = novasEntradas;
                } catch (e) {
                    try { await conexao.rollback(); } catch (_) {}
                    throw e;
                } finally {
                    conexao.release();
                }

                log.log(`💰 MC21 | Mesa ${mesaRuntime.codigo} | Trader ${trader.id} | rodada ${decisao.rodada} | líder=${est.id} | direção=${decisao.alvo} | exposição única confirmada.`);
                return true;
            } catch (e) {
                if (executorConfirmouDireto) {
                    log.error(`⚠️ MC21 | Ordem ${ordemExecutorIdDireto} executada, mas PREPARANDO não avançou; preservada para reconciliação:`, e.message);
                    return false;
                }

                const statusFalha = await deps.marcarIntencaoAposFalhaEnvio(
                    intencaoDireto.auditoria_id,
                    e,
                    `DIRETO arbitrado do trader ${trader.id}`
                );
                await deps.bloquearTraderAposExecucaoAmbigua(trader, statusFalha, 'DIRETO_ARBITRADO');
                log.error(`❌ MC21 | Ordem DIRETO do trader ${trader.id} não confirmada; intenção ${intencaoDireto.auditoria_id} marcada ${statusFalha}:`, e.message);
                return false;
            }
        } finally {
            liberarGate(traderId);
        }
    }

    async function processarRodada(mapa) {
        if (!mapa?.porTrader) return;

        for (const registro of mapa.porTrader.values()) {
            const trader = deps.listarTraders().find(item => Number(item.id) === Number(registro.trader_id));
            if (!trader || !trader.ativo || trader.status_operacao !== 'OPERANDO') continue;
            if (!(await traderPertenceMesaAtual(trader.id))) {
                log.warn(
                    `⛔ MC22-M | Trader ${trader.id} ignorado pelo árbitro: `
                    + `não pertence à mesa ${mesaRuntime.codigo}.`
                );
                continue;
            }

            const candidatosAtuais = registro.candidatos.filter(candidato =>
                candidato?.est
                && candidato?.estadoSinal?.aguardandoResultado === true
                && Number(candidato.est.quarentena_restante) <= 0
                && deps.autoTraderParticipouDoSinal(trader, candidato.est, candidato.estadoSinal)
            );

            const decisao = resolverArbitragemSinaisAutoTrader(
                candidatosAtuais.map(candidato => ({
                    estrategia_id: candidato.estrategia_id,
                    alvo: candidato.alvo,
                    assertividade: candidato.assertividade,
                    gales: candidato.gales
                }))
            );

            const contexto = {
                ...decisao,
                trader_id: Number(trader.id),
                rodada: Number(mapa.rodada)
            };

            if (!decisao.permitido) {
                if (decisao.motivo === 'CONFLITO_DIRECAO') {
                    const resumo = decisao.candidatos.map(item => `${item.estrategia_id}→${item.alvo}`).join(' | ');
                    log.warn(`⛔ MC21 | Trader ${trader.id} | rodada ${mapa.rodada} | CONFLITO (${resumo}) | ZERO ordens.`);
                }
                continue;
            }

            const lider = candidatosAtuais.find(
                candidato => String(candidato.estrategia_id) === String(decisao.estrategia_id)
            );
            if (!lider) {
                log.error(`⛔ MC21 | Trader ${trader.id}: líder não pertence ao conjunto admitido; bloqueado.`);
                continue;
            }

            await executarEntradaDireta(trader, lider.est, contexto);
        }
    }

    return {
        criarMapaRodada,
        registrarCandidato,
        processarRodada,
        listarOrdensFinanceirasEmAbertoTrader
    };
}

module.exports = {
    normalizarAlvoFinanceiro,
    resolverArbitragemSinaisAutoTrader,
    criarArbitroFinanceiroAutoTrader
};