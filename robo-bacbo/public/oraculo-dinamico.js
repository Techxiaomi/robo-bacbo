(function oraculoFrontendBundle() {
    'use strict';

    const state = {
        instalado: false,
        instalando: false,
        aberto: false,
        analisando: false,
        resultados: [],
        socket: null,
        versaoMesa: 0,
        timerInstalacao: null
    };

    function normalizarResultado(valor) {
        const texto = String(valor || '').trim().toUpperCase();
        if (texto === 'P' || texto === 'PLAYER' || texto === 'PLAYERWON' || texto === 'JOGADOR') return 'Player';
        if (texto === 'B' || texto === 'BANKER' || texto === 'BANKERWON' || texto === 'BANCA') return 'Banker';
        if (texto === 'T' || texto === 'TIE' || texto === 'TIEWON' || texto === 'EMPATE') return 'Tie';
        return '';
    }

    function timestampMs(valor) {
        if (valor === null || valor === undefined || valor === '') return NaN;
        if (typeof valor === 'number' && Number.isFinite(valor)) return valor < 1e12 ? valor * 1000 : valor;
        const parsed = Date.parse(String(valor));
        return Number.isFinite(parsed) ? parsed : NaN;
    }

    function normalizarRound(item) {
        if (!item || typeof item !== 'object') return null;
        const resultado = normalizarResultado(item.resultado || item.winner || item.type);
        if (!resultado) return null;
        return {
            resultado,
            uuid: String(item.uuid || item.round_uuid || '').trim(),
            timestamp_ms: timestampMs(item.data_hora || item.instant || item.timestamp)
        };
    }

    function renderizarFita() {
        const fita = document.getElementById('oraculo-fita');
        if (!fita) return;
        fita.innerHTML = '';
        const ultimos = state.resultados.slice(-20);
        for (const item of ultimos) {
            const bola = document.createElement('div');
            bola.className = 'bk-bola ' + item.resultado.toLowerCase();
            bola.textContent = item.resultado === 'Player' ? 'P' : (item.resultado === 'Banker' ? 'B' : 'T');
            bola.title = item.resultado;
            fita.appendChild(bola);
        }
        if (ultimos.length === 0) {
            const vazio = document.createElement('span');
            vazio.className = 'oraculo-fita-vazia';
            vazio.textContent = 'Aguardando resultados canônicos...';
            fita.appendChild(vazio);
        }
        fita.scrollLeft = fita.scrollWidth;
    }

    function marcarResultadoObsoleto() {
        const box = document.getElementById('oraculo-resultado');
        if (!box || box.dataset.temResultado !== '1') return;
        box.className = 'oraculo-resultado neutro';
        box.dataset.temResultado = '0';
        box.textContent = 'A mesa recebeu uma nova rodada. Execute uma nova análise para evitar usar um snapshot antigo.';
    }

    function incorporarRound(round) {
        if (!round) return false;
        if (round.uuid && state.resultados.some(item => item.uuid && item.uuid === round.uuid)) return false;
        const ultimo = state.resultados[state.resultados.length - 1];
        if (
            ultimo
            && ultimo.resultado === round.resultado
            && Number.isFinite(ultimo.timestamp_ms)
            && Number.isFinite(round.timestamp_ms)
            && Math.abs(ultimo.timestamp_ms - round.timestamp_ms) <= 5000
        ) {
            state.resultados[state.resultados.length - 1] = round;
            renderizarFita();
            return false;
        }
        state.resultados.push(round);
        state.resultados = state.resultados.slice(-20);
        state.versaoMesa++;
        renderizarFita();
        if (state.aberto) marcarResultadoObsoleto();
        return true;
    }

    async function carregarFitaInicial() {
        try {
            const response = await fetch('/api/historico-giros?limit=20&_t=' + Date.now(), {
                cache: 'no-store',
                credentials: 'same-origin'
            });
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const dados = await response.json();
            state.resultados = (Array.isArray(dados) ? dados : []).map(normalizarRound).filter(Boolean).slice(-20);
            state.versaoMesa++;
            renderizarFita();
        } catch (error) {
            const fita = document.getElementById('oraculo-fita');
            if (fita) fita.innerHTML = '<span class="oraculo-fita-vazia">Falha ao carregar a fita canônica.</span>';
        }
    }

    function garantirSocket() {
        if (state.socket || typeof window.io !== 'function') return;
        const socket = window.io();
        state.socket = socket;
        socket.on('bacbo_round_live', payload => {
            incorporarRound(normalizarRound(payload));
        });
        socket.on('bacbo_history_recovered', () => {
            if (state.aberto) void carregarFitaInicial();
        });
        socket.on('connect', () => {
            if (state.aberto) void carregarFitaInicial();
        });
    }

    function escaparHtml(valor) {
        return String(valor ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    }

    function resultadoElemento() {
        return document.getElementById('oraculo-resultado');
    }

    function renderizarResultado(data) {
        const box = resultadoElemento();
        if (!box) return;

        const nota = document.querySelector('.oraculo-nota');
        if (nota) {
            nota.textContent = 'O valor exibido é a taxa de assertividade real (probabilidade bruta) baseada no histórico recente selecionado. É exigido um mínimo de 3 ocorrências para validar o padrão.';
        }

        box.dataset.temResultado = '1';
        if (data && data.status === 'APROVADO') {
            const lado = data.sugerido === 'P' ? '🔵 JOGADOR' : '🔴 BANCA';
            box.className = 'oraculo-resultado aprovado';
            box.innerHTML =
                '<div class="oraculo-res-titulo">✅ APROVADO — ' + lado + '</div>'
                + '<div class="oraculo-res-grid">'
                + '<div><span>Probabilidade</span><strong>' + Number(data.confianca_wilson || 0).toFixed(1) + '%</strong></div>'
                + '<div><span>Amostras</span><strong>' + Number(data.amostras_base || 0) + '</strong></div>'
                + '<div><span>Recorte</span><strong>' + escaparHtml(data.padrao_vencedor || '-') + '</strong></div>'
                + '</div>'
                + '<div class="oraculo-mensagem">' + escaparHtml(data.mensagem || '') + '</div>';
            return;
        }
        box.className = 'oraculo-resultado rejeitado';
        const melhor = Number(data && data.melhor_confianca);
        box.innerHTML =
            '<div class="oraculo-res-titulo">⛔ REJEITADO</div>'
            + '<div class="oraculo-res-grid">'
            + '<div><span>Motivo</span><strong>' + escaparHtml((data && (data.detalhe || data.motivo)) || 'MESA_INSTAVEL') + '</strong></div>'
            + '<div><span>Melhor Prob.</span><strong>' + (Number.isFinite(melhor) ? melhor.toFixed(1) + '%' : '-') + '</strong></div>'
            + '</div>'
            + '<div class="oraculo-mensagem">' + escaparHtml((data && data.mensagem) || 'Mesa Instável. Aguarde.') + '</div>';
    }

    function faseLoading(texto) {
        const fase = document.getElementById('oraculo-loading-fase');
        if (fase) fase.textContent = texto;
    }

    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function analisar() {
        if (state.analisando) return;
        const btn = document.getElementById('oraculo-analisar');
        const loading = document.getElementById('oraculo-loading');
        const box = resultadoElemento();
        const gales = Number(document.getElementById('oraculo-gales').value);
        const janela = String(document.getElementById('oraculo-janela').value || '24h');
        const confiancaMinima = Number(document.getElementById('oraculo-confianca').value);
        if (!Number.isFinite(confiancaMinima) || confiancaMinima < 0 || confiancaMinima > 100) {
            renderizarResultado({
                status: 'REJEITADO',
                detalhe: 'PARAMETRO_INVALIDO',
                melhor_confianca: 0,
                mensagem: 'Informe uma confiança mínima entre 0% e 100%.'
            });
            return;
        }

        state.analisando = true;
        const inicioAnaliseMs = Date.now();
        const versaoInicio = state.versaoMesa;
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Analisando...';
        }
        if (box) {
            box.dataset.temResultado = '0';
            box.className = 'oraculo-resultado neutro';
            box.textContent = '';
        }
        if (loading) loading.style.display = 'flex';
        faseLoading('Método ativo: recortes N-3, N-4, N-5 e N-6.');
        const fases = [
            setTimeout(() => faseLoading('Validação pragmática: taxa bruta com mínimo de 3 ocorrências.'), 850),
            setTimeout(() => faseLoading('Filtros ativos: amostra mínima, confiança e empates.'), 1700)
        ];

        try {
            const payload = {
                gales,
                janela,
                confianca_minima: confiancaMinima,
                mesa_atual: state.resultados.slice(-20).map(item => item.resultado)
            };
            const requisicao = fetch('/api/oraculo/analisar', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }).then(async response => {
                let data = null;
                try { data = await response.json(); } catch (_) {}
                if (!response.ok) {
                    throw new Error((data && (data.mensagem || data.erro)) || ('HTTP ' + response.status));
                }
                return data;
            });

            const [data] = await Promise.all([requisicao, delay(2500)]);
            if (state.versaoMesa !== versaoInicio) {
                renderizarResultado({
                    status: 'REJEITADO',
                    detalhe: 'MESA_ATUALIZADA_DURANTE_ANALISE',
                    melhor_confianca: 0,
                    mensagem: 'A mesa mudou durante a análise. Execute novamente para usar o snapshot mais recente.'
                });
                return;
            }
            renderizarResultado(data);
        } catch (error) {
            await delay(Math.max(0, 2500 - (Date.now() - inicioAnaliseMs)));
            renderizarResultado({
                status: 'REJEITADO',
                detalhe: 'FALHA_DA_ANALISE',
                melhor_confianca: 0,
                mensagem: 'Não foi possível concluir a consulta estatística: ' + String(error && error.message || error)
            });
        } finally {
            fases.forEach(clearTimeout);
            if (loading) loading.style.display = 'none';
            if (btn) {
                btn.disabled = false;
                btn.textContent = '🔮 Analisar Sinal';
            }
            state.analisando = false;
        }
    }

    async function abrir() {
        const modal = document.getElementById('oraculo-modal');
        if (!modal) return;
        state.aberto = true;
        modal.style.display = 'flex';
        await carregarFitaInicial();
        garantirSocket();
    }

    function fechar() {
        const modal = document.getElementById('oraculo-modal');
        if (modal) modal.style.display = 'none';
        state.aberto = false;
    }

    async function tentarInstalar() {
        if (state.instalado || state.instalando) return;
        const backtest = document.getElementById('nav-btn-backtest');
        if (!backtest || !document.body) return;
        state.instalando = true;
        try {
            const response = await fetch('/oraculo-dinamico.html?_t=' + Date.now(), {
                cache: 'no-store',
                credentials: 'same-origin'
            });
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const fragmento = await response.text();
            if (!document.getElementById('oraculo-modal')) {
                document.body.insertAdjacentHTML('beforeend', fragmento);
            }

            const nota = document.querySelector('.oraculo-nota');
            if (nota) {
                nota.textContent = 'O valor exibido é a taxa de assertividade real (probabilidade bruta) baseada no histórico recente selecionado. É exigido um mínimo de 3 ocorrências para validar o padrão.';
            }
            if (!document.getElementById('nav-btn-oraculo')) {
                const botao = document.createElement('button');
                botao.id = 'nav-btn-oraculo';
                botao.type = 'button';
                botao.className = 'btn oraculo-trigger';
                botao.textContent = '🔮 Oráculo Dinâmico';
                backtest.insertAdjacentElement('afterend', botao);
                botao.addEventListener('click', () => { void abrir(); });
            }

            document.getElementById('oraculo-analisar')?.addEventListener('click', () => { void analisar(); });
            document.querySelectorAll('[data-oraculo-fechar]').forEach(item => item.addEventListener('click', fechar));
            document.getElementById('oraculo-modal')?.addEventListener('click', event => {
                if (event.target && event.target.id === 'oraculo-modal') fechar();
            });
            window.addEventListener('keydown', event => {
                if (event.key === 'Escape' && state.aberto) fechar();
            });
            garantirSocket();
            state.instalado = true;
            if (state.timerInstalacao) clearInterval(state.timerInstalacao);
        } catch (error) {
            console.error('Falha ao instalar Oráculo Dinâmico:', error);
        } finally {
            state.instalando = false;
        }
    }

    state.timerInstalacao = setInterval(() => { void tentarInstalar(); }, 250);
    void tentarInstalar();
})();
