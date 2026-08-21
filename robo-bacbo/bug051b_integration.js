'use strict';

const { criarBarreiraSaldoFrescoStops } = require('./bug051c_balance_barrier');
const { validarConfiguracaoAutoTrader } = require('./bug051d_config_validation');
const { criarIntegracaoCicloFinanceiro } = require('./bug051e_financial_cycle');

const GUARDA_CONFIG_INSTALADA = Symbol.for('robo-bacbo.bug051d.guarda-config');

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

function instalarGuardaPersistenciaConfig({ dbPool, traders, pulosAntesDaMecanica }) {
    if (dbPool[GUARDA_CONFIG_INSTALADA]) return;

    const queryOriginal = dbPool.query.bind(dbPool);
    dbPool.query = async function queryComGuardaBug051D(sql, params, ...rest) {
        const sqlNormalizado = normalizarSql(sql);
        const parametros = Array.isArray(params) ? params : [];
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

        const resultado = await queryOriginal(sql, params, ...rest);

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
