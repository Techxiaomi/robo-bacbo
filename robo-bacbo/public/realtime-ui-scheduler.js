(() => {
    'use strict';

    const EVENTO_INTERFACE = 'atualizar_interface';
    const EVENTO_ROBOS = 'atualizar_robos';
    const JANELA_COALESCENCIA_MS = 200;
    const ioOriginal = window.io;

    if (typeof ioOriginal !== 'function') {
        console.error('❌ UI Scheduler | Socket.IO não está disponível.');
        return;
    }

    function criarSchedulerParaSocket(socket) {
        const onOriginal = socket.on.bind(socket);
        const eventosInterceptados = new Set();
        let timer = null;
        let atualizacaoEmAndamento = false;
        let interfacePendente = false;
        let robosPendentes = false;
        let executarNovamente = false;

        function temPendencia() {
            return interfacePendente || robosPendentes;
        }

        function agendarFlush(delay = JANELA_COALESCENCIA_MS) {
            if (timer !== null) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                requestAnimationFrame(() => {
                    void executarFlush();
                });
            }, delay);
        }

        function marcarPendente(evento) {
            if (evento === EVENTO_INTERFACE) {
                interfacePendente = true;
            } else if (evento === EVENTO_ROBOS) {
                robosPendentes = true;
            }

            if (atualizacaoEmAndamento) {
                executarNovamente = true;
                return;
            }

            agendarFlush();
        }

        async function atualizarInterfaceCompleta() {
            const modalCadastro = document.getElementById('modal-cadastro');
            if (modalCadastro?.style.display === 'flex') return;

            if (typeof window.inicializarSistema !== 'function') {
                throw new Error('inicializarSistema() não está disponível');
            }

            await window.inicializarSistema();

            const backtest = document.getElementById('aba-backtest');
            if (
                backtest?.classList.contains('visivel')
                && typeof window.carregarHistoricoMemoria === 'function'
            ) {
                await window.carregarHistoricoMemoria(false);
            }
        }

        async function atualizarSomenteRobos() {
            const modalRobo = document.getElementById('modal-robo');
            if (modalRobo?.style.display === 'flex') return;

            if (typeof window.carregarRobos !== 'function') {
                throw new Error('carregarRobos() não está disponível');
            }

            await window.carregarRobos();
        }

        async function executarFlush() {
            if (atualizacaoEmAndamento) {
                executarNovamente = true;
                return;
            }

            const executarInterface = interfacePendente;
            const executarRobos = robosPendentes;
            if (!executarInterface && !executarRobos) return;

            // Uma atualização completa já inclui carregarRobos(); portanto ela absorve
            // qualquer atualizar_robos que tenha chegado na mesma janela.
            interfacePendente = false;
            robosPendentes = false;
            atualizacaoEmAndamento = true;
            executarNovamente = false;

            try {
                if (executarInterface) {
                    await atualizarInterfaceCompleta();
                } else if (executarRobos) {
                    await atualizarSomenteRobos();
                }
            } catch (erro) {
                console.error('❌ UI Scheduler | falha na atualização realtime coalescida:', erro);
            } finally {
                atualizacaoEmAndamento = false;
                if (temPendencia() || executarNovamente) {
                    executarNovamente = false;
                    agendarFlush(0);
                }
            }
        }

        socket.on = function onCoalescido(evento, handler) {
            if (evento !== EVENTO_INTERFACE && evento !== EVENTO_ROBOS) {
                return onOriginal(evento, handler);
            }

            // O dashboard registra um handler para cada um desses eventos. Mantemos
            // exatamente um listener físico por evento e substituímos o trabalho
            // pesado pelo scheduler global, evitando listeners/refreshes duplicados.
            if (!eventosInterceptados.has(evento)) {
                eventosInterceptados.add(evento);
                onOriginal(evento, () => marcarPendente(evento));
            }
            return socket;
        };

        return socket;
    }

    function ioCoalescido(...args) {
        return criarSchedulerParaSocket(ioOriginal(...args));
    }

    for (const chave of Object.keys(ioOriginal)) {
        try { ioCoalescido[chave] = ioOriginal[chave]; } catch (_) {}
    }

    window.io = ioCoalescido;
})();
