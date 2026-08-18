(() => {
    'use strict';

    const PERIODOS_DASHBOARD = new Set(['24h', 'hoje', 'semana', 'mes', 'geral']);
    let dashboardPeriodoAtual = '24h';
    let dashboardAtualizacaoSeq = 0;

    function periodoDashboardSeguro(periodo) {
        return PERIODOS_DASHBOARD.has(periodo) ? periodo : '24h';
    }

    function inteiroDashboardSeguro(valor) {
        const numero = Number(valor);
        return Number.isFinite(numero) && numero >= 0 ? Math.floor(numero) : 0;
    }

    function atualizarBotoesPeriodoDashboard() {
        dashboardPeriodoAtual = periodoDashboardSeguro(dashboardPeriodoAtual);
        document.querySelectorAll('.btn-dash').forEach(btn => {
            const ativo = btn.id === `btn-dash-${dashboardPeriodoAtual}`;
            btn.style.background = ativo ? '#007bff' : 'transparent';
            btn.style.color = ativo ? '#fff' : '#888';
            btn.setAttribute('aria-pressed', ativo ? 'true' : 'false');
        });
    }

    function renderizarDashboardIndisponivel() {
        ['dash-sinais', 'dash-greens', 'dash-reds', 'dash-assertividade'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerText = '—';
        });

        const boxAssert = document.getElementById('box-assertividade');
        const labelAssert = document.getElementById('label-assertividade');
        if (boxAssert) boxAssert.style.borderColor = '#666';
        if (labelAssert) labelAssert.style.color = '#888';
    }

    async function atualizarDashboardValores() {
        atualizarBotoesPeriodoDashboard();

        const roboId = document.getElementById('select-robo-dash')?.value || 'TODOS';
        const origem = document.getElementById('select-origem-dash')?.value || 'TODAS';
        const periodo = periodoDashboardSeguro(dashboardPeriodoAtual);
        dashboardPeriodoAtual = periodo;

        const params = new URLSearchParams();
        params.set('robo_id', roboId);
        params.set('periodo', periodo);
        params.set('origem', origem);
        params.set('_t', String(Date.now()));

        const requestSeq = ++dashboardAtualizacaoSeq;
        try {
            const res = await fetch(`/api/dashboard-stats?${params.toString()}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const data = await res.json();
            if (requestSeq !== dashboardAtualizacaoSeq) return;

            const sinais = inteiroDashboardSeguro(data.sinais);
            const greens = inteiroDashboardSeguro(data.greens);
            const reds = inteiroDashboardSeguro(data.reds);
            const assertNumero = Number.parseFloat(String(data.assertividade ?? '').replace('%', ''));
            const assertividade = Number.isFinite(assertNumero) && assertNumero >= 0
                ? Math.min(100, assertNumero)
                : (sinais > 0 ? (greens / sinais) * 100 : 0);
            const assertTexto = `${assertividade.toFixed(1)}%`;

            document.getElementById('dash-sinais').innerText = sinais;
            document.getElementById('dash-greens').innerText = greens;
            document.getElementById('dash-reds').innerText = reds;
            document.getElementById('dash-assertividade').innerText = assertTexto;

            const corAssert = typeof window.getCor === 'function'
                ? window.getCor(assertividade)
                : '#007bff';
            document.getElementById('dash-assertividade').style.color = corAssert;
            document.getElementById('box-assertividade').style.borderColor = corAssert;
            document.getElementById('label-assertividade').style.color = corAssert;
        } catch (erro) {
            if (requestSeq !== dashboardAtualizacaoSeq) return;
            console.error('Falha ao atualizar Resumo Executivo:', erro);
            renderizarDashboardIndisponivel();
        }
    }

    async function mudarDashGeral(periodo) {
        if (!PERIODOS_DASHBOARD.has(periodo)) return;
        dashboardPeriodoAtual = periodo;
        atualizarBotoesPeriodoDashboard();
        await atualizarDashboardValores();
    }

    async function mudarFiltrosDash() {
        await atualizarDashboardValores();
    }

    window.atualizarDashboardValores = atualizarDashboardValores;
    window.mudarDashGeral = mudarDashGeral;
    window.mudarFiltrosDash = mudarFiltrosDash;
    window.atualizarBotoesPeriodoDashboard = atualizarBotoesPeriodoDashboard;
})();
