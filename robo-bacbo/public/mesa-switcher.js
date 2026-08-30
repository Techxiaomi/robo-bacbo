'use strict';

(() => {
    const MESAS = Object.freeze({
        BACBO_INT: Object.freeze({
            codigo: 'BACBO_INT',
            nome: 'Internacional',
            sigla: 'INT',
            porta: '3000',
            financeiro: true
        }),
        BACBO_BR: Object.freeze({
            codigo: 'BACBO_BR',
            nome: 'Brasil',
            sigla: 'BR',
            porta: '3001',
            financeiro: false
        })
    });

    function detectarMesaAtual() {
        const porta = String(window.location.port || '');
        return Object.values(MESAS).find(mesa => mesa.porta === porta) || null;
    }

    function injetarEstilos() {
        if (document.getElementById('mc25-mesa-switcher-style')) return;

        const style = document.createElement('style');
        style.id = 'mc25-mesa-switcher-style';
        style.textContent = `
            .topo-header {
                gap: 10px !important;
                padding-bottom: 10px !important;
                margin-bottom: 16px !important;
            }

            .topo-header > h1 {
                flex: 1 1 100%;
                width: 100%;
                flex-wrap: wrap;
                gap: 6px;
                min-width: 0;
            }

            .topo-header > h1 .versao-tag {
                margin-left: 4px;
            }

            .topo-header > h1 .gear-icon {
                margin-left: 4px;
            }

            .topo-header > div {
                width: 100%;
                justify-content: flex-start;
            }

            .mc26-mesa-inline {
                --mc26-mesa-accent: #6c757d;
                display: inline-flex;
                align-items: center;
                gap: 6px;
                min-width: 0;
                margin-left: 6px;
                padding: 3px 5px;
                border: 1px solid #3a3a3a;
                border-left: 3px solid var(--mc26-mesa-accent);
                border-radius: 7px;
                background: #181818;
                box-shadow: 0 2px 7px rgba(0,0,0,0.22);
                font-size: 12px;
                line-height: 1;
            }

            .mc26-mesa-inline[data-mesa="BACBO_INT"] {
                --mc26-mesa-accent: #28a745;
            }

            .mc26-mesa-inline[data-mesa="BACBO_BR"] {
                --mc26-mesa-accent: #f59e0b;
            }

            .mc26-mesa-codigo {
                display: inline-flex;
                align-items: center;
                height: 26px;
                padding: 0 8px;
                border-radius: 999px;
                background: #232323;
                border: 1px solid #444;
                color: var(--mc26-mesa-accent);
                font-size: 10px;
                font-weight: 900;
                letter-spacing: .45px;
                white-space: nowrap;
            }

            .mc26-mesa-financeiro {
                display: inline-flex;
                align-items: center;
                height: 26px;
                padding: 0 7px;
                border-radius: 999px;
                border: 1px solid #3c3c3c;
                background: #111;
                color: #d0d0d0;
                font-size: 10px;
                font-weight: 800;
                white-space: nowrap;
            }

            .mc26-mesa-inline[data-mesa="BACBO_INT"] .mc26-mesa-financeiro {
                color: #7ee394;
                border-color: rgba(40,167,69,.55);
            }

            .mc26-mesa-inline[data-mesa="BACBO_BR"] .mc26-mesa-financeiro {
                color: #ffd17a;
                border-color: rgba(245,158,11,.6);
            }

            #mesa-runtime-select {
                width: auto;
                min-width: 188px;
                height: 28px;
                margin: 0;
                padding: 0 28px 0 9px;
                border-radius: 6px;
                border: 1px solid var(--mc26-mesa-accent);
                background: #101010;
                color: #fff;
                font-size: 11px;
                font-weight: 800;
                cursor: pointer;
            }

            .mc26-sr-only {
                position: absolute !important;
                width: 1px !important;
                height: 1px !important;
                padding: 0 !important;
                margin: -1px !important;
                overflow: hidden !important;
                clip: rect(0, 0, 0, 0) !important;
                white-space: nowrap !important;
                border: 0 !important;
            }

            #nav-btn-dashboard,
            #nav-btn-padroes,
            #nav-btn-robos,
            #nav-btn-autotrader,
            #nav-btn-backtest,
            #nav-btn-oraculo {
                padding-left: 14px !important;
                padding-right: 14px !important;
            }

            body.mc25-mesa-br #nav-btn-autotrader:disabled {
                opacity: .82;
                cursor: not-allowed !important;
                filter: grayscale(.4);
                border: 1px solid rgba(245,158,11,.6);
                color: #ffd17a !important;
            }

            @media (max-width: 900px) {
                .mc26-mesa-inline {
                    flex: 1 1 100%;
                    margin-left: 0;
                    margin-top: 4px;
                }

                #mesa-runtime-select {
                    flex: 1 1 auto;
                    min-width: 170px;
                }
            }

            @media (max-width: 520px) {
                .mc26-mesa-inline {
                    width: 100%;
                    flex-wrap: wrap;
                }

                #mesa-runtime-select {
                    width: 100%;
                    min-width: 0;
                }
            }
        `;
        document.head.appendChild(style);
    }

    async function existeAutoTraderAtivo() {
        try {
            const response = await fetch('/api/auto-traders', {
                cache: 'no-store',
                credentials: 'same-origin'
            });

            if (!response.ok) return false;

            const traders = await response.json();
            if (!Array.isArray(traders)) return false;

            return traders.some(trader => (
                trader && (trader.ativo === true || trader.ativo === 1)
            ));
        } catch (_) {
            return false;
        }
    }

    async function trocarMesa(codigoDestino) {
        const destino = MESAS[String(codigoDestino || '').toUpperCase()];
        const atual = detectarMesaAtual();

        if (!destino || (atual && atual.codigo === destino.codigo)) return;

        if (atual?.codigo === 'BACBO_INT' && destino.codigo === 'BACBO_BR') {
            const traderAtivo = await existeAutoTraderAtivo();
            if (traderAtivo) {
                const confirmou = window.confirm(
                    'Existe Auto-Trader ativo na mesa INTERNACIONAL. ' +
                    'Trocar a visualização para a mesa BRASIL não interrompe o runtime INT. ' +
                    'Deseja continuar mesmo assim?'
                );
                if (!confirmou) return;
            }
        }

        const url = new URL(window.location.href);
        url.port = destino.porta;
        window.location.assign(url.toString());
    }

    function compactarBotoesNavegacao() {
        const rotulos = Object.freeze({
            'nav-btn-dashboard': '📊 Dashboard',
            'nav-btn-padroes': '⚙️ Padrões',
            'nav-btn-robos': '🤖 Robôs',
            'nav-btn-backtest': '🔬 Backtest'
        });

        for (const [id, texto] of Object.entries(rotulos)) {
            const botao = document.getElementById(id);
            if (botao) botao.textContent = texto;
        }
    }

    function observarRotuloOraculo() {
        const aplicar = () => {
            const botao = document.getElementById('nav-btn-oraculo');
            if (!botao) return false;
            botao.textContent = '🔮 Oráculo';
            return true;
        };

        if (aplicar() || !document.body || typeof MutationObserver !== 'function') return;

        const observer = new MutationObserver(() => {
            if (aplicar()) observer.disconnect();
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        window.setTimeout(() => observer.disconnect(), 15000);
    }

    function protegerAutoTraderNaBr(mesa) {
        const botao = document.getElementById('nav-btn-autotrader');
        if (!botao) return;

        if (!botao.dataset.mc25OnclickOriginal) {
            botao.dataset.mc25OnclickOriginal = botao.getAttribute('onclick') || '';
        }

        if (mesa?.codigo === 'BACBO_BR') {
            botao.disabled = true;
            botao.removeAttribute('onclick');
            botao.textContent = '🔒 Trader';
            botao.title = 'Execução financeira não autorizada para BACBO_BR.';
            botao.style.background = '#444';
            botao.style.boxShadow = 'none';
            return;
        }

        botao.disabled = false;
        botao.textContent = '💸 Trader';
        botao.title = 'Abrir módulo Trader da mesa BACBO_INT.';
        botao.style.background = '#28a745';
        botao.style.boxShadow = '0 0 8px rgba(40,167,69,0.5)';
        if (botao.dataset.mc25OnclickOriginal) {
            botao.setAttribute('onclick', botao.dataset.mc25OnclickOriginal);
        }
    }

    function montarHeaderCompacto(mesa) {
        const header = document.querySelector('.topo-header');
        const headerTitulo = header?.querySelector('h1');
        if (!header || !headerTitulo || !mesa) return false;

        let switcher = document.getElementById('mesa-runtime-switcher');
        if (!switcher) {
            switcher = document.createElement('span');
            switcher.id = 'mesa-runtime-switcher';
            switcher.className = 'mc26-mesa-inline';
            switcher.setAttribute('aria-label', 'Mesa operacional e alternador de mesa');

            const versao = headerTitulo.querySelector('.versao-tag');
            if (versao?.nextSibling) {
                headerTitulo.insertBefore(switcher, versao.nextSibling);
            } else {
                headerTitulo.appendChild(switcher);
            }
        }

        const descricaoFinanceira = mesa.financeiro
            ? 'Execução financeira disponível nesta mesa'
            : 'Execução financeira bloqueada nesta mesa';

        switcher.dataset.mesa = mesa.codigo;
        switcher.innerHTML = `
            <span class="mc26-mesa-codigo" title="Mesa operacional: ${mesa.nome}">${mesa.codigo}</span>
            <span class="mc26-mesa-financeiro" title="${descricaoFinanceira}">
                ${mesa.financeiro ? '💰 Ativo' : '🔒 Bloqueado'}
            </span>
            <label for="mesa-runtime-select" class="mc26-sr-only">Alternar mesa</label>
            <select id="mesa-runtime-select" aria-label="Alternar mesa operacional" title="Alternar mesa operacional">
                <option value="BACBO_INT">Internacional · BACBO_INT</option>
                <option value="BACBO_BR">Brasil · BACBO_BR</option>
            </select>
        `;

        const select = switcher.querySelector('#mesa-runtime-select');
        select.value = mesa.codigo;
        select.addEventListener('change', event => {
            void trocarMesa(event.target.value);
        });

        return true;
    }

    function mount() {
        const mesa = detectarMesaAtual();
        if (!mesa) {
            document.title = 'Inteligência Bac Bo · Mesa não identificada';
            return false;
        }

        injetarEstilos();

        document.documentElement.dataset.mesaCodigo = mesa.codigo;
        document.body.classList.toggle('mc25-mesa-int', mesa.codigo === 'BACBO_INT');
        document.body.classList.toggle('mc25-mesa-br', mesa.codigo === 'BACBO_BR');
        document.title = `[${mesa.sigla}] Inteligência Bac Bo`;

        const montou = montarHeaderCompacto(mesa);
        compactarBotoesNavegacao();
        protegerAutoTraderNaBr(mesa);
        observarRotuloOraculo();
        return montou;
    }

    window.__mesaSwitcher = Object.freeze({
        mount,
        trocarMesa,
        detectarMesaAtual,
        mesas: MESAS
    });
    window.__mesaSwitcherReady = true;
})();
