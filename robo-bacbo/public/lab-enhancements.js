(() => {
    'use strict';

    const MODOS_APOSTA = Object.freeze([
        { value: 'PLAYER', label: '🔵 Player', titulo: 'Player', alvo: 'Player', protegeEmpate: false, cor: '#007bff' },
        { value: 'PLAYER_TIE', label: '🔵 Player + 🟡 Empate', titulo: 'Player + Empate', alvo: 'Player', protegeEmpate: true, cor: '#17a2b8' },
        { value: 'BANKER', label: '🔴 Banker', titulo: 'Banker', alvo: 'Banker', protegeEmpate: false, cor: '#ff7777' },
        { value: 'BANKER_TIE', label: '🔴 Banker + 🟡 Empate', titulo: 'Banker + Empate', alvo: 'Banker', protegeEmpate: true, cor: '#dc8b32' }
    ]);

    const OPCOES_RANGE = Object.freeze([
        { value: '100', label: '100 Rodadas' },
        { value: '200', label: '200 Rodadas' },
        { value: '500', label: '500 Rodadas' },
        { value: '1000', label: '1.000 Rodadas' },
        { value: '2000', label: '2.000 Rodadas' },
        { value: '5000', label: '5.000 Rodadas' },
        { value: 'MAX', label: 'Toda a Base (Max)' }
    ]);

    let calcularEstatisticasMesaBase = null;
    let abrirAbaBacktestBase = null;

    function resolverModoAposta(valor) {
        return MODOS_APOSTA.find(modo => modo.value === valor) || null;
    }

    function contarTies(stats) {
        let total = 0;
        ['direto', 'g1', 'g2'].forEach(nivel => {
            Object.values(stats?.ties?.[nivel] || {}).forEach(quantidade => {
                const n = Number(quantidade);
                if (Number.isFinite(n) && n > 0) total += n;
            });
        });
        return total;
    }

    function resumirStats(stats) {
        const ties = contarTies(stats);
        const direto = Number(stats?.sg) || 0;
        const g1 = Number(stats?.g1) || 0;
        const g2 = Number(stats?.g2) || 0;
        const reds = Number(stats?.red) || 0;
        const greensSemTie = direto + g1 + g2;
        const vitorias = greensSemTie + ties;
        const totalValido = vitorias + reds;
        const assertividade = totalValido > 0 ? (vitorias / totalValido) * 100 : 0;
        return {
            direto,
            g1,
            g2,
            ties,
            reds,
            greensSemTie,
            vitorias,
            ocorrencias: Number(stats?.totalEncontrado) || 0,
            assertividade
        };
    }

    function ordenarResultadosAutomaticos(resultados) {
        return resultados
            .map((item, indiceOriginal) => ({
                ...item,
                indiceOriginal,
                assertividadeOrdenacao: resumirStats(item?.resultado?.stats).assertividade
            }))
            .sort((a, b) => {
                const diferenca = b.assertividadeOrdenacao - a.assertividadeOrdenacao;
                return diferenca !== 0 ? diferenca : a.indiceOriginal - b.indiceOriginal;
            })
            .map(({ indiceOriginal, assertividadeOrdenacao, ...item }) => item);
    }

    function cortarDadosPorRange(valor, dados = null) {
        const fonte = Array.isArray(dados)
            ? dados
            : (typeof girosInMemoria !== 'undefined' && Array.isArray(girosInMemoria) ? girosInMemoria : []);
        if (valor === 'MAX') return fonte.slice();
        const limite = Number.parseInt(valor, 10);
        if (!Number.isFinite(limite) || limite <= 0) return fonte.slice();
        return fonte.slice(-limite);
    }

    function preencherRange(select, selecionado) {
        if (!select) return;
        select.innerHTML = OPCOES_RANGE
            .map(opcao => `<option value="${opcao.value}">${opcao.label}</option>`)
            .join('');
        select.value = OPCOES_RANGE.some(opcao => opcao.value === selecionado) ? selecionado : 'MAX';
    }

    function obterDadosCorte() {
        const valor = document.getElementById('bk-range')?.value || 'MAX';
        return cortarDadosPorRange(valor);
    }

    function obterDadosDashboardBacktest() {
        const valor = document.getElementById('bk-dashboard-range')?.value || 'MAX';
        return cortarDadosPorRange(valor);
    }

    function atualizarDashboardBacktestPorRange() {
        if (typeof calcularEstatisticasMesaBase !== 'function') return;
        return calcularEstatisticasMesaBase(obterDadosDashboardBacktest());
    }

    function garantirFiltroDashboardBacktest() {
        const qtd = document.getElementById('bk-qtd-giros');
        const cabecalho = qtd?.parentElement?.parentElement;
        if (!cabecalho) return;

        let box = document.getElementById('bk-dashboard-range-box');
        if (!box) {
            box = document.createElement('div');
            box.id = 'bk-dashboard-range-box';
            box.style.cssText = 'display:flex; align-items:center; gap:7px; background:#181818; border:1px solid #333; border-radius:6px; padding:5px 8px; margin-left:auto;';
            box.innerHTML = '<label for="bk-dashboard-range" style="font-size:9px; color:#777; text-transform:uppercase; font-weight:bold; white-space:nowrap;">Resumo:</label><select id="bk-dashboard-range" style="width:auto; min-width:145px; padding:4px 7px; height:28px; font-size:10px; margin:0;"></select>';
            cabecalho.appendChild(box);
        }

        const select = document.getElementById('bk-dashboard-range');
        const valorAnterior = select?.value || 'MAX';
        preencherRange(select, valorAnterior);
        if (select && !select.dataset.ux006aBound) {
            select.dataset.ux006aBound = '1';
            select.addEventListener('change', atualizarDashboardBacktestPorRange);
        }
    }

    function instalarFiltroDashboardBacktest() {
        garantirFiltroDashboardBacktest();

        if (!calcularEstatisticasMesaBase && typeof window.calcularEstatisticasMesa === 'function') {
            calcularEstatisticasMesaBase = window.calcularEstatisticasMesa;
        }

        if (calcularEstatisticasMesaBase) {
            window.calcularEstatisticasMesa = () => atualizarDashboardBacktestPorRange();
        }

        if (!abrirAbaBacktestBase && typeof window.abrirAbaBacktest === 'function') {
            abrirAbaBacktestBase = window.abrirAbaBacktest;
            window.abrirAbaBacktest = async (...args) => {
                const retorno = await abrirAbaBacktestBase(...args);
                atualizarDashboardBacktestPorRange();
                return retorno;
            };
        }
    }

    function garantirAreaAutomatica() {
        let area = document.getElementById('bk-resultados-auto');
        if (area) return area;

        const boxPadrao = document.getElementById('bk-resultados-box');
        if (!boxPadrao?.parentElement) return null;

        area = document.createElement('div');
        area.id = 'bk-resultados-auto';
        area.style.display = 'none';
        area.innerHTML = `
            <div style="margin-bottom:12px; text-align:center;">
                <h4 style="margin:0; color:#ddd; font-size:12px; text-transform:uppercase;">Comparativo Automático</h4>
                <span style="font-size:10px; color:#777;">As quatro possibilidades calculadas sobre a mesma sequência e base.</span>
            </div>
            <div id="bk-auto-grid" style="display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px;"></div>`;
        boxPadrao.parentElement.appendChild(area);

        if (!document.getElementById('ux004-lab-style')) {
            const style = document.createElement('style');
            style.id = 'ux004-lab-style';
            style.textContent = `
                .bk-auto-card { background:#111; border:1px solid #333; border-radius:8px; padding:12px; min-width:0; }
                .bk-auto-card h4 { margin:0 0 8px 0; font-size:12px; }
                .bk-auto-assert { font-size:24px; font-weight:800; line-height:1; margin-bottom:4px; }
                .bk-auto-ocorrencias { display:flex; justify-content:space-between; align-items:center; background:#181818; border:1px solid #303030; border-radius:6px; padding:7px 9px; margin:8px 0 10px; }
                .bk-auto-ocorrencias span { color:#888; font-size:9px; text-transform:uppercase; letter-spacing:.3px; }
                .bk-auto-ocorrencias strong { color:#fff; font-size:16px; line-height:1; }
                .bk-auto-metricas { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:5px; }
                .bk-auto-metrica { background:#191919; border:1px solid #292929; border-radius:5px; padding:5px 3px; text-align:center; }
                .bk-auto-metrica span { display:block; color:#777; font-size:8px; text-transform:uppercase; }
                .bk-auto-metrica strong { display:block; font-size:12px; margin-top:2px; }
                @media (max-width:700px) { #bk-auto-grid { grid-template-columns:1fr !important; } }
            `;
            document.head.appendChild(style);
        }
        return area;
    }

    function cardAutomatico(modo, stats) {
        const s = resumirStats(stats);
        const corAssert = typeof window.getCor === 'function' ? window.getCor(s.assertividade) : modo.cor;
        return `
            <div class="bk-auto-card" data-bk-modo="${modo.value}" style="border-top:3px solid ${modo.cor};">
                <h4 style="color:${modo.cor};">${modo.label}</h4>
                <div class="bk-auto-assert" style="color:${corAssert};">${s.assertividade.toFixed(1)}%</div>
                <div class="bk-auto-ocorrencias"><span>Ocorrências</span><strong>${s.ocorrencias}</strong></div>
                <div class="bk-auto-metricas">
                    <div class="bk-auto-metrica"><span>Greens</span><strong style="color:#28a745;">${s.greensSemTie}</strong></div>
                    <div class="bk-auto-metrica"><span>Empates</span><strong style="color:#ffc107;">${s.ties}</strong></div>
                    <div class="bk-auto-metrica"><span>Reds</span><strong style="color:#ff7777;">${s.reds}</strong></div>
                    <div class="bk-auto-metrica"><span>Direto</span><strong>${s.direto}</strong></div>
                    <div class="bk-auto-metrica"><span>G1</span><strong>${s.g1}</strong></div>
                    <div class="bk-auto-metrica"><span>G2</span><strong>${s.g2}</strong></div>
                </div>
            </div>`;
    }

    function mostrarResultadoUnico() {
        const auto = document.getElementById('bk-resultados-auto');
        if (auto) auto.style.display = 'none';
    }

    function mostrarResultadosAutomaticos(resultados) {
        const placeholder = document.getElementById('bk-resultados-placeholder');
        const box = document.getElementById('bk-resultados-box');
        const area = garantirAreaAutomatica();
        const grid = document.getElementById('bk-auto-grid');
        if (!area || !grid) return [];

        const ordenados = ordenarResultadosAutomaticos(resultados);
        if (placeholder) placeholder.style.display = 'none';
        if (box) box.style.display = 'none';
        area.style.display = 'block';
        grid.innerHTML = ordenados.map(item => cardAutomatico(item.modo, item.resultado.stats)).join('');
        return ordenados;
    }

    function rodarBacktestManualAprimorado() {
        if (typeof bkPadraoAtual === 'undefined' || !Array.isArray(bkPadraoAtual) || bkPadraoAtual.length < 2) {
            return alert('Construa um padrão de pelo menos 2 cores.');
        }
        if (typeof girosInMemoria === 'undefined' || !Array.isArray(girosInMemoria) || girosInMemoria.length === 0) {
            return alert('Aguarde o carregamento dos giros.');
        }

        const modoSelecionado = document.getElementById('bk-entrada')?.value || 'AUTO';
        const gales = Number.parseInt(document.getElementById('bk-gales')?.value || '0', 10);
        const dadosCorte = obterDadosCorte();

        if (modoSelecionado === 'AUTO') {
            const resultados = MODOS_APOSTA.map(modo => ({
                modo,
                resultado: simularBacktestCore(bkPadraoAtual, modo.alvo, gales, modo.protegeEmpate, dadosCorte)
            }));
            const ordenados = mostrarResultadosAutomaticos(resultados);
            atualizarDashboardBacktestPorRange();
            renderizarFitaTemporal(dadosCorte, []);
            return ordenados;
        }

        const modo = resolverModoAposta(modoSelecionado);
        if (!modo) return alert('Selecione uma modalidade válida em Apostar em.');

        const resultado = simularBacktestCore(bkPadraoAtual, modo.alvo, gales, modo.protegeEmpate, dadosCorte);
        mostrarResultadoUnico();
        renderizarResultadoManual(resultado.stats);
        atualizarDashboardBacktestPorRange();
        renderizarFitaTemporal(dadosCorte, resultado.highlights);
        return resultado;
    }

    function salvarComoEstrategiaAprimorado() {
        if (typeof bkPadraoAtual === 'undefined' || !Array.isArray(bkPadraoAtual) || bkPadraoAtual.length < 2) {
            return alert('Rode o backtest primeiro.');
        }

        const valor = document.getElementById('bk-entrada')?.value || 'AUTO';
        if (valor === 'AUTO') {
            return alert('Para salvar, escolha Player, Player + Empate, Banker ou Banker + Empate.');
        }

        const modo = resolverModoAposta(valor);
        if (!modo) return alert('Selecione uma modalidade válida em Apostar em.');

        abrirFormularioNova();
        bkPadraoAtual.forEach(jogada => adicionarNoPadraoModal(jogada));
        document.getElementById('entrada').value = modo.alvo;
        document.getElementById('gales').value = document.getElementById('bk-gales').value;
        document.getElementById('proteger_empate').checked = modo.protegeEmpate;
    }

    function configurarLabPadroes() {
        const entrada = document.getElementById('bk-entrada');
        const range = document.getElementById('bk-range');
        if (!entrada || !range) return;

        entrada.innerHTML = [
            '<option value="AUTO">⚡ Automático — comparar as 4 opções</option>',
            ...MODOS_APOSTA.map(modo => `<option value="${modo.value}">${modo.label}</option>`)
        ].join('');
        entrada.value = 'AUTO';

        preencherRange(range, 'MAX');
        preencherRange(document.getElementById('mn-range'), '1000');

        const prot = document.getElementById('bk-prot');
        const labelProt = prot?.closest('label');
        if (labelProt) labelProt.remove();

        garantirAreaAutomatica();
        instalarFiltroDashboardBacktest();
        window.rodarBacktestManual = rodarBacktestManualAprimorado;
        window.bkSalvarComoEstrategia = salvarComoEstrategiaAprimorado;
    }

    window.configurarLabPadroes = configurarLabPadroes;
    window.rodarBacktestManualAprimorado = rodarBacktestManualAprimorado;
    window.bkSalvarComoEstrategiaAprimorado = salvarComoEstrategiaAprimorado;
    window.atualizarDashboardBacktestPorRange = atualizarDashboardBacktestPorRange;
    window.ux004ResolverModoAposta = resolverModoAposta;
    window.ux004ResumirStats = resumirStats;
    window.ux005OrdenarResultadosAutomaticos = ordenarResultadosAutomaticos;
    window.ux006CortarDadosPorRange = cortarDadosPorRange;
})();
