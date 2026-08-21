(() => {
    'use strict';

    const EVENTO_INTERFACE = 'atualizar_interface';
    const EVENTO_ROBOS = 'atualizar_robos';
    const JANELA_COALESCENCIA_MS = 200;
    const LONG_TASK_THRESHOLD_MS = 50;
    const ioOriginal = window.io;

    if (typeof ioOriginal !== 'function') {
        console.error('❌ UI Scheduler | Socket.IO não está disponível.');
        return;
    }

    function iniciarTelemetriaLongTasks() {
        if (
            typeof window.PerformanceObserver !== 'function'
            || !Array.isArray(window.PerformanceObserver.supportedEntryTypes)
            || !window.PerformanceObserver.supportedEntryTypes.includes('longtask')
        ) {
            console.info('ℹ️ UI PERF | Long Task API indisponível neste navegador.');
            return;
        }

        const metricas = {
            quantidade: 0,
            duracaoTotalMs: 0,
            maiorDuracaoMs: 0,
            ultimaDuracaoMs: 0
        };

        try {
            const observer = new PerformanceObserver(lista => {
                lista.getEntries().forEach(entrada => {
                    const duracao = Number(entrada.duration) || 0;
                    if (duracao < LONG_TASK_THRESHOLD_MS) return;

                    metricas.quantidade += 1;
                    metricas.duracaoTotalMs += duracao;
                    metricas.maiorDuracaoMs = Math.max(metricas.maiorDuracaoMs, duracao);
                    metricas.ultimaDuracaoMs = duracao;

                    console.warn(
                        `⚠️ UI PERF | Long Task ${duracao.toFixed(1)} ms | `
                        + `total=${metricas.quantidade} | pico=${metricas.maiorDuracaoMs.toFixed(1)} ms`
                    );
                });
            });

            observer.observe({ type: 'longtask', buffered: true });
            window.__uiLongTaskTelemetry = {
                observer,
                snapshot: () => ({ ...metricas })
            };
        } catch (erro) {
            console.warn('⚠️ UI PERF | Falha ao iniciar telemetria de Long Tasks:', erro);
        }
    }

    function criarSchedulerParaSocket(socket) {
        const onOriginal = socket.on.bind(socket);
        const eventosInterceptados = new Set();
        let timer = null;
        let atualizacaoEmAndamento = false;
        let interfacePendente = false;
        let robosPendentes = false;
        let executarNovamente = false;
        let conexaoInicialConfirmada = false;
        let precisaRessincronizar = false;
        let snapshotReconexaoPendente = false;

        function garantirIndicadorConexao() {
            let indicador = document.getElementById('ui-status-conexao');
            if (indicador || !document.body) return indicador;

            indicador = document.createElement('div');
            indicador.id = 'ui-status-conexao';
            indicador.setAttribute('role', 'status');
            indicador.setAttribute('aria-live', 'polite');
            indicador.style.cssText = [
                'position:fixed',
                'right:12px',
                'bottom:12px',
                'z-index:10000',
                'padding:5px 9px',
                'border-radius:999px',
                'font-size:10px',
                'font-weight:700',
                'letter-spacing:.2px',
                'box-shadow:0 2px 10px rgba(0,0,0,.35)',
                'pointer-events:none',
                'transition:background .2s ease,color .2s ease,border-color .2s ease'
            ].join(';');
            document.body.appendChild(indicador);
            return indicador;
        }

        function atualizarIndicadorConexao(estado, texto) {
            const indicador = garantirIndicadorConexao();
            if (!indicador) return;

            const visual = {
                conectado: { fundo: '#102016', borda: '#285b36', cor: '#6ee7a0' },
                sincronizando: { fundo: '#2b240f', borda: '#6b5719', cor: '#ffd75e' },
                desconectado: { fundo: '#2a1214', borda: '#6b2b30', cor: '#ff8a93' }
            }[estado] || { fundo: '#1b1b1b', borda: '#444', cor: '#bbb' };

            indicador.style.background = visual.fundo;
            indicador.style.border = `1px solid ${visual.borda}`;
            indicador.style.color = visual.cor;
            indicador.textContent = texto;
            indicador.dataset.estado = estado;
        }

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

        function solicitarSnapshotReconexao() {
            if (snapshotReconexaoPendente) return;
            snapshotReconexaoPendente = true;
            interfacePendente = true;
            atualizarIndicadorConexao('sincronizando', '🟡 Reconectado • sincronizando');

            if (atualizacaoEmAndamento) {
                executarNovamente = true;
                return;
            }

            agendarFlush(0);
        }

        async function atualizarInterfaceCompleta({ forcar = false } = {}) {
            const modalCadastro = document.getElementById('modal-cadastro');
            if (!forcar && modalCadastro?.style.display === 'flex') return;

            if (typeof window.inicializarSistema !== 'function') {
                throw new Error('inicializarSistema() não está disponível');
            }

            await window.inicializarSistema();
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
            const executarSnapshotReconexao = executarInterface && snapshotReconexaoPendente;
            if (!executarInterface && !executarRobos) return;

            // Uma atualização completa já inclui carregarRobos(); portanto ela absorve
            // qualquer atualizar_robos que tenha chegado na mesma janela.
            interfacePendente = false;
            robosPendentes = false;
            atualizacaoEmAndamento = true;
            executarNovamente = false;

            let atualizacaoConcluida = false;
            try {
                if (executarInterface) {
                    await atualizarInterfaceCompleta({ forcar: executarSnapshotReconexao });
                } else if (executarRobos) {
                    await atualizarSomenteRobos();
                }
                atualizacaoConcluida = true;
            } catch (erro) {
                console.error('❌ UI Scheduler | falha na atualização realtime coalescida:', erro);
            } finally {
                if (executarSnapshotReconexao) {
                    snapshotReconexaoPendente = false;
                    if (atualizacaoConcluida) {
                        atualizarIndicadorConexao('conectado', '🟢 Conectado • sincronizado');
                    } else {
                        atualizarIndicadorConexao('sincronizando', '🟡 Conectado • sync pendente');
                    }
                }

                atualizacaoEmAndamento = false;
                if (temPendencia() || executarNovamente) {
                    executarNovamente = false;
                    agendarFlush(0);
                }
            }
        }

        onOriginal('connect', () => {
            if (!conexaoInicialConfirmada) {
                conexaoInicialConfirmada = true;
                precisaRessincronizar = false;
                atualizarIndicadorConexao('conectado', '🟢 Conectado');
                return;
            }

            if (!precisaRessincronizar) {
                atualizarIndicadorConexao('conectado', '🟢 Conectado');
                return;
            }

            precisaRessincronizar = false;
            solicitarSnapshotReconexao();
        });

        onOriginal('disconnect', motivo => {
            precisaRessincronizar = true;
            atualizarIndicadorConexao('desconectado', '🔴 Desconectado • reconectando');
            console.warn(`⚠️ UI Socket | desconectado: ${String(motivo || 'motivo não informado')}`);
        });

        onOriginal('connect_error', erro => {
            atualizarIndicadorConexao('desconectado', '🔴 Sem conexão • tentando novamente');
            console.warn('⚠️ UI Socket | falha de conexão:', erro?.message || erro);
        });

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

        atualizarIndicadorConexao(
            socket.connected ? 'conectado' : 'sincronizando',
            socket.connected ? '🟢 Conectado' : '🟡 Conectando...'
        );

        return socket;
    }

    function ioCoalescido(...args) {
        return criarSchedulerParaSocket(ioOriginal(...args));
    }

    iniciarTelemetriaLongTasks();
    window.io = ioCoalescido;
    window.__realtimeUiSchedulerReady = true;
})();
