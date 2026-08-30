'use strict';

const crypto = require('crypto');
const { obterMesaRuntime } = require('./mesa_runtime_context');

const GUARDA_CICLO_INSTALADA = Symbol.for('robo-bacbo.bug051e.guarda-ciclo');
const CONEXAO_CICLO_INSTALADA = Symbol.for('robo-bacbo.bug051e.conexao-ciclo');

function normalizarSql(sql) {
    return typeof sql === 'string'
        ? sql.replace(/\s+/g, ' ').trim().replace(/;$/, '')
        : '';
}

function contarParametrosAntes(valores, indice) {
    let parametros = 0;
    for (let i = 0; i < indice; i++) {
        parametros += (String(valores[i] || '').match(/\?/g) || []).length;
    }
    return parametros;
}

function parametroDaColuna(colunas, valores, parametros, nome) {
    const indiceColuna = colunas.indexOf(nome);
    if (indiceColuna < 0 || String(valores[indiceColuna] || '').trim() !== '?') {
        return undefined;
    }
    const indiceParametro = contarParametrosAntes(valores, indiceColuna);
    return parametros[indiceParametro];
}

function parseInsertAuditoria(sqlNormalizado, parametros) {
    const match = /^insert\s+into\s+auditoria_ordens\s*\(([^)]+)\)\s*values\s*\(([^)]+)\)$/i.exec(sqlNormalizado);
    if (!match || !Array.isArray(parametros)) return null;

    const colunas = match[1]
        .split(',')
        .map(coluna => coluna.trim().replace(/`/g, '').toLowerCase());
    const valores = match[2].split(',').map(valor => valor.trim());

    return {
        match,
        colunas,
        valores,
        traderId: parametroDaColuna(colunas, valores, parametros, 'trader_id'),
        nivel: parametroDaColuna(colunas, valores, parametros, 'nivel'),
        cicloId: parametroDaColuna(colunas, valores, parametros, 'ciclo_id')
    };
}

function parseBuscaPendenteFragil(sqlNormalizado) {
    return /^select\s+(.+?)\s+from\s+auditoria_ordens\s+where\s+trader_id\s*=\s*\?\s+and\s+status_ordem\s*=\s*['"]PENDENTE['"]\s+limit\s+1$/i.exec(sqlNormalizado);
}

function resultadoQuery(resultado) {
    return Array.isArray(resultado) ? resultado[0] : resultado;
}

function criarErroCiclo(motivo) {
    const erro = new Error(`BUG-051E: ${motivo}`);
    erro.code = 'BUG051E_CICLO_INVALIDO';
    return erro;
}

function etapaFinanceiraValida(nivel) {
    const etapa = String(nivel || '').trim().toUpperCase();
    return etapa === 'DIRETO' || etapa === 'GALE 1' || etapa === 'GALE 2'
        ? etapa
        : '';
}

function criarEstadoCiclos() {
    return {
        ativosPorTrader: new Map(),
        ordensPorId: new Map()
    };
}

function limparOrdensDoTrader(estado, traderId) {
    const chaveTrader = String(traderId);
    for (const [ordemId, referencia] of estado.ordensPorId.entries()) {
        if (String(referencia.traderId) === chaveTrader) {
            estado.ordensPorId.delete(ordemId);
        }
    }
}

function limparCiclo(estado, traderId, cicloId) {
    const chaveTrader = String(traderId);
    if (estado.ativosPorTrader.get(chaveTrader) === cicloId) {
        estado.ativosPorTrader.delete(chaveTrader);
    }
    for (const [ordemId, referencia] of estado.ordensPorId.entries()) {
        if (
            String(referencia.traderId) === chaveTrader
            && referencia.cicloId === cicloId
        ) {
            estado.ordensPorId.delete(ordemId);
        }
    }
}

function prepararInsertComCiclo(sqlNormalizado, parametros, estado) {
    const insert = parseInsertAuditoria(sqlNormalizado, parametros);
    if (!insert) return null;

    const traderId = insert.traderId;
    const chaveTrader = String(traderId ?? '');
    const etapa = etapaFinanceiraValida(insert.nivel);
    if (!chaveTrader || !etapa) {
        throw criarErroCiclo('intenção financeira sem trader_id ou etapa DIRETO/GALE válida');
    }

    if (insert.colunas.includes('ciclo_id')) {
        const cicloRecebido = String(insert.cicloId || '').trim();
        if (!cicloRecebido) {
            throw criarErroCiclo(`ciclo_id vazio para trader ${chaveTrader}`);
        }
        return {
            sql: sqlNormalizado,
            parametros,
            traderId: chaveTrader,
            etapa,
            cicloId: cicloRecebido,
            iniciarCiclo: etapa === 'DIRETO'
        };
    }

    let cicloId = '';
    let iniciarCiclo = false;
    if (etapa === 'DIRETO') {
        // Um DIRETO sempre inaugura um novo ciclo. Remover a referência anterior antes
        // do INSERT evita que uma falha desta nova intenção reutilize um ciclo antigo.
        estado.ativosPorTrader.delete(chaveTrader);
        limparOrdensDoTrader(estado, chaveTrader);
        cicloId = crypto.randomUUID();
        iniciarCiclo = true;
    } else {
        cicloId = String(estado.ativosPorTrader.get(chaveTrader) || '');
        if (!cicloId) {
            throw criarErroCiclo(
                `${etapa} recusado para trader ${chaveTrader}: ciclo_id do DIRETO não está ativo`
            );
        }
    }

    const colunasNovas = `${insert.match[1]}, ciclo_id`;
    const valoresNovos = `${insert.match[2]}, ?`;
    const sqlNovo = `INSERT INTO auditoria_ordens (${colunasNovas}) VALUES (${valoresNovos})`;

    return {
        sql: sqlNovo,
        parametros: [...parametros, cicloId],
        traderId: chaveTrader,
        etapa,
        cicloId,
        iniciarCiclo
    };
}

async function executarBuscaPendenteExata(
    executarBase,
    match,
    parametros,
    rest,
    estado
) {
    if (
        !Array.isArray(parametros)
        || parametros.length < 1
    ) {
        return executarBase(
            `SELECT ${match[1]} FROM auditoria_ordens WHERE 1=0`,
            [],
            ...rest
        );
    }

    const mesaRuntime = obterMesaRuntime();
    const traderId = String(parametros[0]);

    const cicloId = String(
        estado.ativosPorTrader.get(traderId) || ''
    );

    if (!cicloId) {
        console.error(
            `BUG-051E | trader=${traderId} | ` +
            `ciclo_id ativo ausente; busca PENDENTE bloqueada.`
        );

        return [[], []];
    }

    const sqlExato =
        `SELECT ${match[1]} FROM auditoria_ordens ` +
        `WHERE trader_id=? AND mesa_id=? ` +
        `AND ciclo_id=? AND status_ordem='PENDENTE' ` +
        `ORDER BY id DESC LIMIT 2`;

    const resultado = await executarBase(
        sqlExato,
        [
            parametros[0],
            mesaRuntime.id,
            cicloId
        ],
        ...rest
    );

    const linhas =
        Array.isArray(resultado)
        && Array.isArray(resultado[0])
            ? resultado[0]
            : [];

    if (linhas.length > 1) {
        console.error(
            `BUG-051E | trader=${traderId} | ` +
            `ciclo_id=${cicloId} | ` +
            `${linhas.length} ordens PENDENTE na mesma mesa/ciclo.`
        );

        return [
            [],
            Array.isArray(resultado)
                ? resultado[1]
                : []
        ];
    }

    return resultado;
}

function indiceParametroWhereId(sqlNormalizado) {
    const sql = String(sqlNormalizado || '');
    const whereIndex = sql.search(/\bwhere\b/i);

    if (whereIndex < 0) return -1;

    const trechoWhere = sql.slice(whereIndex);
    const matchId = /\bid\s*=\s*\?/i.exec(
        trechoWhere
    );

    if (!matchId) return -1;

    const posPergunta =
        whereIndex
        + matchId.index
        + matchId[0].lastIndexOf('?');

    return (
        sql.slice(0, posPergunta).match(/\?/g)
        || []
    ).length;
}

function terminalConfirmado(sqlNormalizado) {
    return (
        /^update\s+auditoria_ordens\s+set\s+/i
            .test(sqlNormalizado)
        && /resultado_confirmado_em\s*=\s*\?/i
            .test(sqlNormalizado)
        && indiceParametroWhereId(sqlNormalizado) >= 0
    );
}

function invalidacaoGlobalPendentes(sqlNormalizado) {
    const sql = String(sqlNormalizado || '');

    return (
        /^update\s+auditoria_ordens\s+set\s+/i
            .test(sql)
        && /status_ordem\s*=\s*['"]DADOS_INCOMPLETOS['"]/i
            .test(sql)
        && /status_ordem\s*=\s*['"]PENDENTE['"]/i
            .test(sql)
        && (
            !/\bmesa_id\b/i.test(sql)
            || /mesa_id\s*=\s*\?/i.test(sql)
        )
    );
}

function instalarWrapperQuery(queryable, queryOriginal, estado) {
    return async function queryComCicloFinanceiro(sql, params, ...rest) {
        const sqlNormalizado = normalizarSql(sql);
        const parametros = Array.isArray(params) ? params : params;
        const buscaFragil = parseBuscaPendenteFragil(sqlNormalizado);

        if (buscaFragil) {
            return executarBuscaPendenteExata(
                queryOriginal,
                buscaFragil,
                Array.isArray(parametros) ? parametros : [],
                rest,
                estado
            );
        }

        let insertPreparado = null;
        if (/^insert\s+into\s+auditoria_ordens\b/i.test(sqlNormalizado)) {
            insertPreparado = prepararInsertComCiclo(
                sqlNormalizado,
                Array.isArray(parametros) ? parametros : [],
                estado
            );
        }

        const sqlExecutado = insertPreparado ? insertPreparado.sql : sql;
        const paramsExecutados = insertPreparado ? insertPreparado.parametros : params;
        const resultado = await queryOriginal(sqlExecutado, paramsExecutados, ...rest);

        if (insertPreparado) {
            const pacote = resultadoQuery(resultado) || {};
            const auditoriaId = Number(pacote.insertId);
            if (!Number.isInteger(auditoriaId) || auditoriaId <= 0) {
                throw criarErroCiclo('INSERT financeiro não retornou auditoria_id válido');
            }

            if (insertPreparado.iniciarCiclo) {
                estado.ativosPorTrader.set(
                    String(insertPreparado.traderId),
                    insertPreparado.cicloId
                );
            }
            estado.ordensPorId.set(String(auditoriaId), {
                traderId: String(insertPreparado.traderId),
                cicloId: insertPreparado.cicloId
            });

            console.log(
                `🔗 CICLO FINANCEIRO | trader=${insertPreparado.traderId} | `
                + `ciclo_id=${insertPreparado.cicloId} | etapa=${insertPreparado.etapa} | `
                + `auditoria=${auditoriaId}.`
            );
        }

        if (terminalConfirmado(sqlNormalizado) && Array.isArray(parametros) && parametros.length > 0) {
            const pacote = resultadoQuery(resultado) || {};
            const indiceAuditoriaId =
                indiceParametroWhereId(sqlNormalizado);

            const auditoriaId =
                indiceAuditoriaId >= 0
                    ? String(parametros[indiceAuditoriaId])
                    : '';

            const referencia =
                estado.ordensPorId.get(auditoriaId);
            if (referencia && Number(pacote.affectedRows) === 1) {
                console.log(
                    `🔒 CICLO FINANCEIRO | trader=${referencia.traderId} | `
                    + `ciclo_id=${referencia.cicloId} | liquidado.`
                );
                limparCiclo(
                    estado,
                    referencia.traderId,
                    referencia.cicloId
                );
            }
        } else if (invalidacaoGlobalPendentes(sqlNormalizado)) {
            const pacote = resultadoQuery(resultado) || {};
            if (Number(pacote.affectedRows) > 0) {
                estado.ativosPorTrader.clear();
                estado.ordensPorId.clear();
                console.warn(
                    '🔒 BUG-051E | continuidade invalidada | referências de ciclos financeiros ativos foram descartadas.'
                );
            }
        }

        return resultado;
    };
}

function criarIntegracaoCicloFinanceiro({ dbPool }) {
    if (!dbPool || typeof dbPool.query !== 'function' || typeof dbPool.getConnection !== 'function') {
        throw new Error('BUG-051E requer dbPool mysql2/promise válido');
    }

    if (dbPool[GUARDA_CICLO_INSTALADA]) {
        return dbPool[GUARDA_CICLO_INSTALADA];
    }

    const estado = criarEstadoCiclos();
    const queryPoolAnterior = dbPool.query.bind(dbPool);
    dbPool.query = instalarWrapperQuery(dbPool, queryPoolAnterior, estado);

    const getConnectionAnterior = dbPool.getConnection.bind(dbPool);
    dbPool.getConnection = async function getConnectionComCicloFinanceiro(...args) {
        const conexao = await getConnectionAnterior(...args);
        if (!conexao[CONEXAO_CICLO_INSTALADA]) {
            const queryConexaoAnterior = conexao.query.bind(conexao);
            conexao.query = instalarWrapperQuery(
                conexao,
                queryConexaoAnterior,
                estado
            );
            Object.defineProperty(conexao, CONEXAO_CICLO_INSTALADA, {
                value: true,
                enumerable: false,
                configurable: false,
                writable: false
            });
        }
        return conexao;
    };

    async function inicializarSchema() {
        try {
            await dbPool.query(
                'ALTER TABLE auditoria_ordens ADD COLUMN ciclo_id VARCHAR(64) DEFAULT NULL AFTER trader_id'
            );
        } catch (erro) {
            if (!(erro && (erro.code === 'ER_DUP_FIELDNAME' || Number(erro.errno) === 1060))) {
                throw erro;
            }
        }

        try {
            await dbPool.query(
                'ALTER TABLE auditoria_ordens ADD INDEX idx_auditoria_trader_ciclo_status (trader_id, ciclo_id, status_ordem)'
            );
        } catch (erro) {
            if (!(erro && (erro.code === 'ER_DUP_KEYNAME' || Number(erro.errno) === 1061))) {
                throw erro;
            }
        }
    }

    async function garantirIndiceMesaCiclo() {
        try {
            await dbPool.query(
                `ALTER TABLE auditoria_ordens
                 ADD INDEX idx_auditoria_mesa_trader_ciclo_status
                 (mesa_id, trader_id, ciclo_id, status_ordem)`
            );
        } catch (erro) {
            if (
                !(
                    erro
                    && (
                        erro.code === 'ER_DUP_KEYNAME'
                        || Number(erro.errno) === 1061
                    )
                )
            ) {
                throw erro;
            }
        }
    }

    async function reconciliarRestart() {
        const mesaRuntime = obterMesaRuntime();
        const mesaId = Number(mesaRuntime.id);

        if (!Number.isInteger(mesaId) || mesaId <= 0) {
            throw criarErroCiclo(
                'mesa runtime invalida na reconciliacao de restart'
            );
        }

        await garantirIndiceMesaCiclo();

        const conexao =
            await dbPool.getConnection();

        try {
            await conexao.beginTransaction();

            const [orfas] = await conexao.query(
                `SELECT
                    id,
                    trader_id,
                    status_ordem,
                    executor_order_id,
                    nivel,
                    ciclo_id
                 FROM auditoria_ordens
                 WHERE mesa_id=?
                   AND status_ordem
                       IN ('PREPARANDO', 'PENDENTE')
                 ORDER BY id ASC
                 FOR UPDATE`,
                [mesaId]
            );

            const traderIds = [];

            for (const ordem of orfas) {
                const traderId =
                    Number(ordem.trader_id);

                if (
                    !Number.isInteger(traderId)
                    || traderId <= 0
                ) {
                    throw criarErroCiclo(
                        `ordem ${ordem.id} sem trader valido`
                    );
                }

                traderIds.push(traderId);
            }

            const traderIdsUnicos = [
                ...new Set(traderIds)
            ];

            if (orfas.length > 0) {
                if (traderIdsUnicos.length > 0) {
                    const placeholders =
                        traderIdsUnicos
                            .map(() => '?')
                            .join(',');

                    const [tradersMesa] =
                        await conexao.query(
                            `SELECT id
                             FROM auto_traders
                             WHERE mesa_id=?
                               AND id IN (${placeholders})
                             ORDER BY id ASC
                             FOR UPDATE`,
                            [
                                mesaId,
                                ...traderIdsUnicos
                            ]
                        );

                    if (
                        tradersMesa.length
                        !== traderIdsUnicos.length
                    ) {
                        throw criarErroCiclo(
                            'restart encontrou Trader fora da mesa runtime'
                        );
                    }
                }

                const [ordensAtualizadas] =
                    await conexao.query(
                        `UPDATE auditoria_ordens
                         SET status_ordem='RESTART_INTERROMPIDO'
                         WHERE mesa_id=?
                           AND status_ordem
                               IN ('PREPARANDO', 'PENDENTE')`,
                        [mesaId]
                    );

                if (
                    Number(ordensAtualizadas.affectedRows)
                    !== orfas.length
                ) {
                    throw criarErroCiclo(
                        'quantidade de ordens de restart divergente'
                    );
                }

                if (traderIdsUnicos.length > 0) {
                    const placeholders =
                        traderIdsUnicos
                            .map(() => '?')
                            .join(',');

                    const [tradersAtualizados] =
                        await conexao.query(
                            `UPDATE auto_traders
                             SET ativo=false,
                                 status_operacao='RESTART_INTERROMPIDO'
                             WHERE mesa_id=?
                               AND id IN (${placeholders})`,
                            [
                                mesaId,
                                ...traderIdsUnicos
                            ]
                        );

                    if (
                        Number(tradersAtualizados.affectedRows)
                        !== traderIdsUnicos.length
                    ) {
                        throw criarErroCiclo(
                            'bloqueio de Traders no restart incompleto'
                        );
                    }
                }
            }

            await conexao.commit();

            estado.ativosPorTrader.clear();
            estado.ordensPorId.clear();

            return {
                ordens: orfas.length,
                traders: traderIdsUnicos.length,
                mesa_id: mesaId
            };
        } catch (erro) {
            try {
                await conexao.rollback();
            } catch (rollbackErro) {}

            throw erro;
        } finally {
            conexao.release();
        }
    }

    const api = {
        inicializarSchema,
        reconciliarRestart,
        estado
    };

    Object.defineProperty(dbPool, GUARDA_CICLO_INSTALADA, {
        value: api,
        enumerable: false,
        configurable: false,
        writable: false
    });

    return api;
}

module.exports = { criarIntegracaoCicloFinanceiro };
