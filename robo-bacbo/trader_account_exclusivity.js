'use strict';

function normalizarContaId(valor) {
    if (valor === undefined || valor === null) {
        return '';
    }

    return String(valor).trim();
}

function traderAtivo(trader) {
    return trader?.ativo === true || trader?.ativo === 1;
}

function descricaoDonoConta(trader) {
    const mesa = String(
        trader?.mesa_codigo
        ?? trader?.mesa
        ?? '<mesa-desconhecida>'
    ).trim() || '<mesa-desconhecida>';

    const nome = String(
        trader?.nome
        ?? '<sem-nome>'
    ).trim() || '<sem-nome>';

    return { mesa, nome };
}

function avaliarHabilitacaoConta({
    trader_id = null,
    account_id,
    traders = []
} = {}) {
    const conta = normalizarContaId(account_id);

    if (!conta) {
        return {
            permitido: false,
            codigo: 'CONTA_TRADER_AUSENTE',
            mensagem:
                'Selecione uma conta homologada antes de habilitar o Auto-Trader.',
            dono: null
        };
    }

    const candidatoId = trader_id === undefined || trader_id === null
        ? ''
        : String(trader_id).trim();

    const conflito = (Array.isArray(traders) ? traders : [])
        .find(trader => {
            if (!traderAtivo(trader)) {
                return false;
            }

            if (
                normalizarContaId(
                    trader?.account_id
                ) !== conta
            ) {
                return false;
            }

            if (
                candidatoId
                && String(trader?.id ?? '').trim() === candidatoId
            ) {
                return false;
            }

            return true;
        });

    if (!conflito) {
        return {
            permitido: true,
            codigo: null,
            mensagem: null,
            dono: null
        };
    }

    const dono = descricaoDonoConta(conflito);

    return {
        permitido: false,
        codigo: 'CONTA_TRADER_EM_USO',
        mensagem:
            `Conta em uso pelo Auto-Trader da mesa ${dono.mesa}, `
            + `nome "${dono.nome}". Desative-o antes de habilitar outro `
            + 'Auto-Trader com a mesma conta.',
        dono: {
            trader_id: conflito.id ?? null,
            mesa_codigo: dono.mesa,
            nome: dono.nome
        }
    };
}

function podeSalvarTraderDesligado() {
    return {
        permitido: true,
        codigo: null,
        mensagem: null
    };
}

module.exports = {
    normalizarContaId,
    traderAtivo,
    avaliarHabilitacaoConta,
    podeSalvarTraderDesligado
};
