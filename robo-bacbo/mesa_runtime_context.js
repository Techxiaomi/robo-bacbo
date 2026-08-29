'use strict';

// MC22-H — contexto de mesa do processo Node.
// Neste checkpoint continua existindo apenas uma mesa operacional. O objetivo e
// retirar a identidade da mesa de constantes dispersas e disponibiliza-la, de forma
// imutavel e fail-closed, para os proximos adaptadores de runtime/financeiro.
let mesaRuntime = null;

function normalizarMesaPersistida(mesa) {
    const id = Number(mesa?.id);
    const codigo = String(mesa?.codigo || '').trim().toUpperCase();
    const nome = String(mesa?.nome || '').trim();
    const tipoJogo = String(mesa?.tipo_jogo || '').trim().toUpperCase();

    if (!Number.isInteger(id) || id <= 0 || !codigo || !nome || !tipoJogo) {
        const erro = new Error('MC22-H: identidade persistida da mesa invalida para o runtime');
        erro.code = 'MESA_RUNTIME_INVALIDA';
        throw erro;
    }

    return Object.freeze({
        id,
        codigo,
        nome,
        tipo_jogo: tipoJogo
    });
}

function definirMesaRuntime(mesa) {
    const normalizada = normalizarMesaPersistida(mesa);

    if (mesaRuntime) {
        if (mesaRuntime.id !== normalizada.id || mesaRuntime.codigo !== normalizada.codigo) {
            const erro = new Error(
                `MC22-H: tentativa de trocar mesa do processo de ${mesaRuntime.codigo} para ${normalizada.codigo}`
            );
            erro.code = 'MESA_RUNTIME_IMUTAVEL';
            throw erro;
        }
        return mesaRuntime;
    }

    mesaRuntime = normalizada;
    return mesaRuntime;
}

function obterMesaRuntime() {
    if (!mesaRuntime) {
        const erro = new Error('MC22-H: contexto de mesa ainda nao inicializado');
        erro.code = 'MESA_RUNTIME_NAO_INICIALIZADA';
        throw erro;
    }
    return mesaRuntime;
}

function tentarObterMesaRuntime() {
    return mesaRuntime;
}

module.exports = {
    definirMesaRuntime,
    obterMesaRuntime,
    tentarObterMesaRuntime
};
