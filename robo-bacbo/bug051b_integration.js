'use strict';

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const express = require('express');
const { criarBarreiraSaldoFrescoStops } = require('./bug051c_balance_barrier');
const { validarConfiguracaoAutoTrader } = require('./bug051d_config_validation');
const { criarIntegracaoCicloFinanceiro } = require('./bug051e_financial_cycle');

const GUARDA_CONFIG_INSTALADA = Symbol.for('robo-bacbo.bug051d.guarda-config');
const CONTEXTO_LEDGER_REQUEST = new AsyncLocalStorage();
const EXPRESS_JSON_LEDGER_INSTALADO = Symbol.for('robo-bacbo.arch-road-02.express-json-ledger');
const ORIENTACAO_ROAD = Object.freeze({
    OLD_TO_NEW: 'OLD_TO_NEW',
    NEW_TO_OLD: 'NEW_TO_OLD'
});
const LIMITE_HISTORY_CANONICO = 1000;
const estadoCanonicoEvolution = {
    pronto: false,
    orientacao: null,
    history: [],
    coletor_sessao: null,
    snapshot_timestamp: null,
    atualizado_em: null
};

function tokenInternoValidoShadow(req) {
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

function numeroRoad(valor) {
    if (valor === undefined || valor === null || valor === '') return null;
    const numero = Number(valor);
    return Number.isFinite(numero) ? numero : null;
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
    const coletorSeq = Number(dados.coletor_seq);
    const timestamp = Number(dados.timestamp_coleta);
    if (roundId) giro.roundId = roundId.slice(0, 128);
    if (Number.isSafeInteger(coletorSeq) && coletorSeq >= 0) giro.coletorSeq = coletorSeq;
    if (Number.isFinite(timestamp) && timestamp > 0) giro.timestamp = Math.trunc(timestamp);
    return giro;
}

function mesmoGiroRoad(a, b) {
    return Boolean(a && b)
        && normalizarWinnerRoad(a.winner) === normalizarWinnerRoad(b.winner)
        && numeroRoad(a.playerScore) === numeroRoad(b.playerScore)
        && numeroRoad(a.bankerScore) === numeroRoad(b.bankerScore);
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
        `🧠 SHADOW ROAD | READY atualizado | orientação=${estadoCanonicoEvolution.orientacao} | `
        + `rodadas=${estadoCanonicoEvolution.history.length} | `
        + `último=${pontaNova.winner}:${pontaNova.playerScore}x${pontaNova.bankerScore}`
    );
}

function hidratarEstadoCanonicoEvolution(dados, historyNormalizado) {
    const sessao = String(dados.coletor_sessao || '').trim();
    const timestamp = Number(dados.timestamp_coleta);
    const mesmaSessao = Boolean(
        estadoCanonicoEvolution.coletor_sessao
        && estadoCanonicoEvolution.coletor_sessao === sessao
    );
    const orientacaoPreservada = mesmaSessao ? estadoCanonicoEvolution.orientacao : null;

    estadoCanonicoEvolution.pronto = Boolean(orientacaoPreservada);
    estadoCanonicoEvolution.orientacao = orientacaoPreservada;
    estadoCanonicoEvolution.history = historyNormalizado;
    estadoCanonicoEvolution.coletor_sessao = sessao;
    estadoCanonicoEvolution.snapshot_timestamp = Math.trunc(timestamp);
    estadoCanonicoEvolution.atualizado_em = Date.now();
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
        estadoCanonicoEvolution.pronto = false;
        estadoCanonicoEvolution.orientacao = null;
        estadoCanonicoEvolution.history = [];
        estadoCanonicoEvolution.coletor_sessao = sessaoIncremental;
        estadoCanonicoEvolution.snapshot_timestamp = null;
        estadoCanonicoEvolution.atualizado_em = Date.now();
        return false;
    }

    if (!estadoCanonicoEvolution.orientacao) {
        const primeiro = estadoCanonicoEvolution.history[0];
        const ultimo = estadoCanonicoEvolution.history[estadoCanonicoEvolution.history.length - 1];
        const batePrimeiro = mesmoGiroRoad(giro, primeiro);
        const bateUltimo = mesmoGiroRoad(giro, ultimo);

        // Se as duas pontas forem iguais ou nenhuma ponta casar, a orientação continua ambígua.
        if (batePrimeiro === bateUltimo) return false;

        estadoCanonicoEvolution.orientacao = batePrimeiro
            ? ORIENTACAO_ROAD.NEW_TO_OLD
            : ORIENTACAO_ROAD.OLD_TO_NEW;
        estadoCanonicoEvolution.pronto = true;
        estadoCanonicoEvolution.atualizado_em = Date.now();
        logEstadoCanonicoReady();
        return true;
    }

    if (!estadoCanonicoEvolution.pronto) return false;

    const pontaNova = pontaNovaEstadoCanonico();
    if (mesmoGiroRoad(giro, pontaNova)) return false;

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
    logEstadoCanonicoReady();
    return true;
}

function responderCollectorRoadShadow(req, res) {
    if (req.method !== 'POST' || req.path !== '/collector-road') return false;

    if (!tokenInternoValidoShadow(req)) {
        res.status(401).json({ erro: 'Nao autorizado' });
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

    hidratarEstadoCanonicoEvolution(dados, historyNormalizado);
    res.status(200).json({
        recebido: true,
        shadow: true,
        quantidade: historyNormalizado.length,
        pronto: estadoCanonicoEvolution.pronto,
        orientacao: estadoCanonicoEvolution.orientacao
    });
    return true;
}

function processarReceberSinalShadow(req) {
    if (req.method !== 'POST' || req.path !== '/receber-sinal') return false;
    if (!tokenInternoValidoShadow(req)) return false;
    const dados = req.body && typeof req.body === 'object' ? req.body : {};
    return orientarOuAtualizarEstadoCanonicoComIncremental(dados);
}

function instalarContextoLedgerExpress() {
    if (express[EXPRESS_JSON_LEDGER_INSTALADO]) return;

    const jsonOriginal = express.json;
    express.json = function jsonComContextoLedger(...args) {
        const middleware = jsonOriginal(...args);
        return function middlewareComContextoLedger(req, res, next) {
            middleware(req, res, erro => {
                if (erro) return next(erro);
                if (responderCollectorRoadShadow(req, res)) return;
                try {
                    processarReceberSinalShadow(req);
                } catch (erroShadow) {
                    // Shadow Mode nunca interfere no caminho produtivo do /receber-sinal.
                }
                const payload = req && req.body && typeof req.body === 'object' ? req.body : {};
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
    if (normalizado.includes('round_id') || normalizado.includes('coletor_seq') || normalizado.includes('coletor_sessao')) {
        return bruto;
    }

    return bruto.replace(
        /(\s*)id_sessao\s+BIGINT\s*,/i,
        (_, indentacao) => (
            `${indentacao}round_id VARCHAR(128) DEFAULT NULL,`
            + `${indentacao}coletor_seq INT DEFAULT NULL,`
            + `${indentacao}coletor_sessao VARCHAR(64) DEFAULT NULL,`
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
    const novosParametros = [
        ...parametros.slice(0, 7),
        metadados.round_id,
        metadados.coletor_seq,
        metadados.coletor_sessao,
        ...parametros.slice(7)
    ];

    return {
        sql: 'INSERT INTO giros_recentes (resultado, p_d1, p_d2, b_d1, b_d2, numero_empate, multiplicador, round_id, coletor_seq, coletor_sessao, id_sessao, data_hora) VALUES (?,?,?,?,?,?,?,?,?,?,?,FROM_UNIXTIME(?))',
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
        'ALTER TABLE giros_recentes ADD COLUMN coletor_sessao VARCHAR(64) DEFAULT NULL'
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

        // BUG-051C: a checagem de 90 s do snapshot global continua sendo um teto de idade,
        // mas nao basta para avaliar Stop Win/Loss/Trailing. A avaliacao financeira abaixo
        // so sera alcancada se a ultima liquidacao terminal possuir prova persistida de uma
        // sincronizacao de saldo estritamente posterior ao resultado.
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
        await cicloFinanceiro.inicializarSchema();
        await inicializarLedgerForense(dbPool);
        const hoje = controleDiarioAutoTrader.dataOperacional();
        await dbPool.query(
            `UPDATE auto_traders
             SET data_contador_entradas=?
             WHERE data_contador_entradas IS NULL OR data_contador_entradas=''`,
            [hoje]
        );
        return hoje;
    }

    return {
        garantirAntesDaEntrada,
        processarViradaDiaria,
        inicializarDatasLegadas
    };
}

module.exports = { criarIntegracaoContadorDiario };