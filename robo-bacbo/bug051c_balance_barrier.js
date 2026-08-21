'use strict';

// BUG-051C: a janela generica de frescor do saldo nao e prova suficiente para Stops.
// Esta barreira adiciona causalidade: depois de um ciclo terminal, a proxima avaliacao
// financeira so pode ocorrer quando houver uma sincronizacao de saldo persistida com
// timestamp estritamente posterior ao resultado que encerrou aquele ciclo.
function criarBarreiraSaldoFrescoStops({ dbPool }) {
    async function obterUltimaLiquidacaoTrader(traderId) {
        const [linhas] = await dbPool.query(
            `SELECT id, saldo_pos, resultado_confirmado_em, saldo_pos_confirmado_em
             FROM auditoria_ordens
             WHERE trader_id=?
               AND status_ordem IN ('WIN','LOSS','TIE')
               AND resultado_confirmado_em IS NOT NULL
             ORDER BY resultado_confirmado_em DESC, id DESC
             LIMIT 1`,
            [traderId]
        );

        if (linhas.length === 0) return null;

        const row = linhas[0];
        const resultadoConfirmadoEm = Number(row.resultado_confirmado_em);
        const saldoPosConfirmadoEm = Number(row.saldo_pos_confirmado_em);
        const saldoPos = Number(row.saldo_pos);

        return {
            auditoria_id: Number(row.id) || null,
            resultado_confirmado_em: Number.isFinite(resultadoConfirmadoEm) && resultadoConfirmadoEm > 0
                ? Math.trunc(resultadoConfirmadoEm)
                : null,
            saldo_pos_confirmado_em: Number.isFinite(saldoPosConfirmadoEm) && saldoPosConfirmadoEm > 0
                ? Math.trunc(saldoPosConfirmadoEm)
                : null,
            saldo_pos: row.saldo_pos !== null && Number.isFinite(saldoPos) && saldoPos >= 0
                ? saldoPos
                : null
        };
    }

    async function garantirSaldoPosteriorUltimaLiquidacao(trader) {
        const traderId = Number(trader && trader.id);
        if (!Number.isInteger(traderId) || traderId <= 0) {
            return {
                permitido: false,
                motivo: 'TRADER_INVALIDO',
                referencia: null
            };
        }

        const referencia = await obterUltimaLiquidacaoTrader(traderId);
        if (!referencia) {
            return {
                permitido: true,
                motivo: null,
                referencia: null
            };
        }

        const resultadoEm = Number(referencia.resultado_confirmado_em);
        const saldoConfirmadoEm = Number(referencia.saldo_pos_confirmado_em);
        const saldoConfirmado = Number(referencia.saldo_pos);
        const provaPosterior = Number.isFinite(resultadoEm)
            && resultadoEm > 0
            && Number.isFinite(saldoConfirmadoEm)
            && saldoConfirmadoEm > resultadoEm
            && Number.isFinite(saldoConfirmado)
            && saldoConfirmado >= 0;

        if (!provaPosterior) {
            return {
                permitido: false,
                motivo: 'SALDO_POS_LIQUIDACAO_NAO_CONFIRMADO',
                referencia
            };
        }

        return {
            permitido: true,
            motivo: null,
            referencia
        };
    }

    return {
        obterUltimaLiquidacaoTrader,
        garantirSaldoPosteriorUltimaLiquidacao
    };
}

module.exports = { criarBarreiraSaldoFrescoStops };
