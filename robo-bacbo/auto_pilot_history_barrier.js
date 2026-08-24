'use strict';

const historySync = require('./tipminer_history_sync');
const autoPilotModule = require('./auto_pilot_ia');

let instalado = false;
let factoryOriginal = null;

function instalarAutoPilotHistoryBarrier() {
    if (instalado) return true;

    factoryOriginal = autoPilotModule.criarAutoPilotService;
    if (typeof factoryOriginal !== 'function') {
        throw new Error('Factory Auto Pilot IA indisponível para a barreira histórica');
    }

    autoPilotModule.criarAutoPilotService = function criarAutoPilotComBarreiraHistorica(...args) {
        const service = factoryOriginal(...args);
        if (!service || typeof service.executarTodos !== 'function') {
            throw new Error('Auto Pilot IA não expôs executarTodos para revalidação histórica');
        }

        const executarTodosOriginal = service.executarTodos.bind(service);
        let versaoHistoricaConsumida = null;

        // Uma execução só pode declarar uma versão como consumida se a versão não mudou
        // durante a própria mineração. Se mudou no meio, a barreira final reexecuta em estado estável.
        service.executarTodos = async opcoes => {
            const motivo = String(opcoes?.motivo || '');
            const versaoAntes = historySync.estadoHistorico().versao;
            const resultado = await executarTodosOriginal(opcoes || {});
            const versaoDepois = historySync.estadoHistorico().versao;
            const sucesso = resultado?.adiado !== true && resultado?.executado !== false;

            if (sucesso && versaoAntes === versaoDepois) {
                versaoHistoricaConsumida = versaoDepois;
            }

            // O collector-health só fica disponível quando o backend marca backendPronto.
            // Declaramos o consumidor crítico pronto no fim da mineração de startup; se a
            // versão mudou no meio, ele está pronto para a barreira, mas ainda não "consumiu" a versão nova.
            if (motivo === 'startup' && sucesso) {
                historySync.marcarConsumidoresCriticosProntos();
            }
            return resultado;
        };

        historySync.onHistoricoAplicado(async meta => {
            const versaoAlvo = Math.max(0, Number(meta?.versao) || 0);

            if (
                versaoHistoricaConsumida !== null
                && versaoHistoricaConsumida >= versaoAlvo
            ) {
                console.log(
                    `🔒 IA já consolidada na versão histórica ${versaoAlvo} | janela=${Math.max(0, Number(meta?.janela) || 0)}.`
                );
                return { ok: true, reutilizada: true };
            }

            const origem = String(meta?.origem || 'history_sync');
            const resultado = await service.executarTodos({
                forcar: true,
                motivo: `barreira_historica:${origem}`
            });

            if (resultado?.adiado === true) {
                return {
                    ok: false,
                    adiado: true,
                    motivo: String(resultado.motivo || 'IA_ADIADA')
                };
            }

            if (resultado?.executado === false) {
                return {
                    ok: false,
                    motivo: String(resultado.motivo || 'IA_NAO_EXECUTADA')
                };
            }

            versaoHistoricaConsumida = versaoAlvo;
            console.log(
                `🔒 IA consolidada na barreira histórica | versão=${versaoAlvo} | `
                + `janela=${Math.max(0, Number(meta?.janela) || 0)}.`
            );
            return { ok: true };
        });

        return service;
    };

    instalado = true;
    console.log('🔒 Barreira histórica da IA ativa | snapshot final -> revalidação -> ACK.');
    return true;
}

module.exports = { instalarAutoPilotHistoryBarrier };
