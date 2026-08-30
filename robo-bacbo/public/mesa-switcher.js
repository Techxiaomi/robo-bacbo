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
            .mc25-mesa-strip {
                flex-basis: 100%;
                width: 100%;
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 14px;
                padding: 10px 12px;
                border: 1px solid #3a3a3a;
                border-left: 5px solid var(--mc25-mesa-accent, #6c757d);
                border-radius: 8px;
                background: #181818;
                box-shadow: 0 3px 10px rgba(0,0,0,0.25);
            }

            .mc25-mesa-strip[data-mesa="BACBO_INT"] {
                --mc25-mesa-accent: #28a745;
            }

            .mc25-mesa-strip[data-mesa="BACBO_BR"] {
                --mc25-mesa-accent: #17a2b8;
            }

            .mc25-mesa-identidade {
                display: flex;
                flex-direction: column;
                gap: 2px;
                min-width: 0;
            }

            .mc25-mesa-kicker {
                color: #888;
                font-size: 9px;
                font-weight: 800;
                letter-spacing: 1.2px;
                text-transform: uppercase;
            }

            .mc25-mesa-nome {
                display: flex;
                align-items: center;
                gap: 8px;
                flex-wrap: wrap;
                font-size: 15px;
                font-weight: 800;
                color: #fff;
            }

            .mc25-mesa-codigo {
                display: inline-flex;
                align-items: center;
                padding: 2px 7px;
                border-radius: 999px;
                background: #252525;
                border: 1px solid #444;
                color: var(--mc25-mesa-accent, #ccc);
                font-size: 10px;
                letter-spacing: .5px;
            }

            .mc25-mesa-financeiro {
                font-size: 11px;
                font-weight: 700;
                color: #bbb;
            }

            .mc25-mesa-controls {
                display: flex;
                align-items: center;
                gap: 8px;
                flex-wrap: wrap;
                justify-content: flex-end;
            }

            .mc25-mesa-controls label {
                color: #888;
                font-size: 10px;
                font-weight: 800;
                text-transform: uppercase;
                letter-spacing: .8px;
            }

            #mesa-runtime-select {
                min-width: 220px;
                height: 34px;
                margin: 0;
                padding: 0 10px;
                border-radius: 6px;
                border: 1px solid var(--mc25-mesa-accent, #555);
                background: #101010;
                color: #fff;
                font-size: 12px;
                font-weight: 700;
                cursor: pointer;
            }

            body.mc25-mesa-br #nav-btn-autotrader:disabled {
                opacity: .65;
                cursor: not-allowed !important;
                filter: grayscale(1);
            }

            @media (max-width: 768px) {
                .mc25-mesa-strip {
                    align-items: stretch;
                    flex-direction: column;
                }

                .mc25-mesa-controls {
                    justify-content: stretch;
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

    function protegerAutoTraderNaBr(mesa) {
        const botao = document.getElementById('nav-btn-autotrader');
        if (!botao) return;

        if (!botao.dataset.mc25TextoOriginal) {
            botao.dataset.mc25TextoOriginal = botao.textContent || '';
        }
        if (!botao.dataset.mc25OnclickOriginal) {
            botao.dataset.mc25OnclickOriginal = botao.getAttribute('onclick') || '';
        }

        if (mesa?.codigo === 'BACBO_BR') {
            botao.disabled = true;
            botao.removeAttribute('onclick');
            botao.textContent = '🔒 Auto-Trader (BR bloqueado)';
            botao.title = 'Execução financeira não autorizada para BACBO_BR.';
            botao.style.background = '#444';
            botao.style.boxShadow = 'none';
            return;
        }

        botao.disabled = false;
        botao.textContent = botao.dataset.mc25TextoOriginal;
        botao.title = '';
        botao.style.background = '#28a745';
        botao.style.boxShadow = '0 0 8px rgba(40,167,69,0.5)';
        if (botao.dataset.mc25OnclickOriginal) {
            botao.setAttribute('onclick', botao.dataset.mc25OnclickOriginal);
        }
    }

    function montarStrip(mesa) {
        const header = document.querySelector('.topo-header');
        if (!header || !mesa) return false;

        let strip = document.getElementById('mesa-runtime-switcher');
        if (!strip) {
            strip = document.createElement('div');
            strip.id = 'mesa-runtime-switcher';
            strip.className = 'mc25-mesa-strip';
            header.insertBefore(strip, header.firstChild);
        }

        strip.dataset.mesa = mesa.codigo;
        strip.innerHTML = `
            <div class="mc25-mesa-identidade">
                <span class="mc25-mesa-kicker">Mesa operacional</span>
                <div class="mc25-mesa-nome">
                    <span>${mesa.nome}</span>
                    <span class="mc25-mesa-codigo">${mesa.codigo}</span>
                </div>
                <span class="mc25-mesa-financeiro">
                    ${mesa.financeiro
                        ? '💰 Execução financeira disponível nesta mesa'
                        : '🔒 Execução financeira bloqueada nesta mesa'}
                </span>
            </div>
            <div class="mc25-mesa-controls">
                <label for="mesa-runtime-select">Alternar mesa</label>
                <select id="mesa-runtime-select" aria-label="Alternar mesa operacional">
                    <option value="BACBO_INT">Internacional · BACBO_INT</option>
                    <option value="BACBO_BR">Brasil · BACBO_BR</option>
                </select>
            </div>
        `;

        const select = strip.querySelector('#mesa-runtime-select');
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

        const montou = montarStrip(mesa);
        protegerAutoTraderNaBr(mesa);
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
