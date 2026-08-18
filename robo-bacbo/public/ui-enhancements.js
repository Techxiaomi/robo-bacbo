(() => {
    'use strict';

    const PERIODOS_ROBO = ['24h', 'hoje', 'semana', 'mes', 'geral'];
    let roboPeriodoAtual = '24h';

    function numeroSeguro(valor) {
        const numero = Number(valor);
        return Number.isFinite(numero) && numero >= 0 ? Math.floor(numero) : 0;
    }

    function escapar(valor) {
        if (typeof window.escaparHtmlRobo === 'function') return window.escaparHtmlRobo(valor);
        return String(valor ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function boolSeguro(valor) {
        if (typeof window.boolRobo === 'function') return window.boolRobo(valor);
        return valor === true || valor === 1 || valor === '1';
    }

    function resumoPeriodoRobo(robo, periodo) {
        const s = robo?.detalhes?.[periodo] || {};
        const direto = numeroSeguro(s.green_direto);
        const gale1 = numeroSeguro(s.gale1);
        const gale2 = numeroSeguro(s.gale2);
        const reds = numeroSeguro(s.red);
        let ties = 0;
        let htmlTies = '';

        ['direto', 'gale1', 'gale2'].forEach(nivel => {
            const itens = [];
            Object.entries(s.ties?.[nivel] || {}).forEach(([multiplicador, quantidade]) => {
                const qtd = numeroSeguro(quantidade);
                if (qtd <= 0) return;
                ties += qtd;
                itens.push(`<strong>${qtd}</strong> - ${escapar(multiplicador)}`);
            });
            if (itens.length > 0) {
                htmlTies += `<div style="font-size:10px; margin-bottom:2px;">${nivel.toUpperCase()}: ${itens.join(' | ')}</div>`;
            }
        });

        const greensSemTie = direto + gale1 + gale2;
        const greens = greensSemTie + ties;
        const total = greens + reds;
        const assertividade = total > 0 ? ((greens / total) * 100).toFixed(1) : '0.0';
        const pctGreens = total > 0 ? ((greensSemTie / total) * 100).toFixed(1) : '0.0';
        const pctTies = total > 0 ? ((ties / total) * 100).toFixed(1) : '0.0';
        const pctReds = total > 0 ? ((reds / total) * 100).toFixed(1) : '0.0';

        return {
            direto,
            gale1,
            gale2,
            greensSemTie,
            greens,
            reds,
            ties,
            total,
            assertividade,
            pctGreens,
            pctTies,
            pctReds,
            htmlTies,
            maxGreen: numeroSeguro(s.max_green_seq),
            maxRed: numeroSeguro(s.max_red_seq)
        };
    }

    function corAssertividade(valor) {
        return typeof window.getCor === 'function' ? window.getCor(valor) : '#007bff';
    }

    function htmlPeriodoRobo(robo, periodo) {
        const s = resumoPeriodoRobo(robo, periodo);
        return `
            <div class="detalhes-tecnicos" style="margin-top:auto;">
                <div style="display:flex; justify-content:space-between; border-bottom:1px solid #444; margin-bottom:5px; padding-bottom:4px;">
                    <span>Entradas: <strong>${s.total}</strong></span>
                    <span>Assertividade: <strong style="color:${corAssertividade(s.assertividade)};">${s.assertividade}%</strong></span>
                </div>
                <div class="linha-detalhe" style="align-items:center;">
                    <span>✅ Greens: <strong style="color:#28a745;">${s.greensSemTie}</strong> <small style="color:#aaa;">(${s.pctGreens}%)</small></span>
                    <div style="display:flex; gap:10px; font-size:11px; color:#ccc;">
                        <span>Dir: <strong>${s.direto}</strong></span>
                        <span>G1: <strong>${s.gale1}</strong></span>
                        <span>G2: <strong>${s.gale2}</strong></span>
                    </div>
                </div>
                <div class="linha-detalhe" style="flex-direction:column;">
                    <span>🟡 Empates: <strong style="color:#ffc107;">${s.ties}</strong> <small style="color:#aaa;">(${s.pctTies}%)</small></span>
                    <div class="tie-box">${s.htmlTies || '<span style="font-size:10px; color:#666;">Sem empates</span>'}</div>
                </div>
                <div class="linha-detalhe" style="margin-top:5px;">
                    <span>❌ Reds: <strong style="color:#ff7777;">${s.reds}</strong> <small style="color:#aaa;">(${s.pctReds}%)</small></span>
                </div>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:8px;">
                    <div style="background:#102016; border:1px solid #285b36; border-radius:5px; padding:7px; text-align:center;">
                        <span style="display:block; color:#888; font-size:9px; text-transform:uppercase;">Maior sequência Green</span>
                        <strong style="color:#28a745; font-size:17px;">🔥 ${s.maxGreen}</strong>
                    </div>
                    <div style="background:#241314; border:1px solid #683034; border-radius:5px; padding:7px; text-align:center;">
                        <span style="display:block; color:#888; font-size:9px; text-transform:uppercase;">Maior sequência Red</span>
                        <strong style="color:#ff7777; font-size:17px;">${s.maxRed}</strong>
                    </div>
                </div>
            </div>`;
    }

    function htmlTabsRobo(robo) {
        const labels = { '24h': '24H', hoje: 'Hoje', semana: 'Semana', mes: 'Mês', geral: 'Geral' };
        return `<div class="grid-performance">${PERIODOS_ROBO.map(periodo => {
            const s = resumoPeriodoRobo(robo, periodo);
            const texto = s.total > 0 ? `${s.assertividade}%` : '-';
            return `<div class="box-tempo ${roboPeriodoAtual === periodo ? 'ativo' : ''}" onclick="mudarPeriodoCardRobo('${periodo}')"><span>${labels[periodo]}</span><strong style="color:${corAssertividade(texto)}">${texto}</strong></div>`;
        }).join('')}</div>`;
    }

    function renderizarCardsRobosAprimorado() {
        const div = document.getElementById('lista-robos');
        if (!div) return;
        div.innerHTML = '';

        if (typeof robosGlobais === 'undefined' || !Array.isArray(robosGlobais) || robosGlobais.length === 0) {
            div.innerHTML = '<p style="color:#666; text-align:center; padding:20px; grid-column:span 2; background:#1a1a1a; border:1px dashed #333; border-radius:8px;">Nenhum Robô / Canal cadastrado.</p>';
            return;
        }

        robosGlobais.forEach(robo => {
            const cf = robo.config || {};
            const ativo = boolSeguro(robo.ativo);
            const web = boolSeguro(robo.enviar_web);
            const tel = boolSeguro(robo.enviar_telegram);
            const emStandby = numeroSeguro(robo.em_standby_ate) > Date.now();
            const stopRedsLimite = numeroSeguro(robo.stop_reds_seguidos);
            const stopRedsAtual = numeroSeguro(robo.reds_consecutivos);
            const emStopReds = !ativo && stopRedsLimite > 0 && stopRedsAtual >= stopRedsLimite;
            const qtdDest = Array.isArray(robo.destinatarios) ? robo.destinatarios.length : 0;
            const origens = Array.isArray(cf.origens) ? cf.origens : [];
            const avulsos = Array.isArray(cf.avulsos) ? cf.avulsos : [];
            const excecoes = Array.isArray(cf.excecoes) ? cf.excecoes : [];
            const cor = escapar(robo.cor_hex || '#007bff');

            const tagsOrigem = origens.length
                ? origens.map(origem => `<span class="badge" style="margin-right:4px;">${escapar(origem)}</span>`).join('')
                : '<span style="color:#666; font-size:11px;">Nenhuma origem incluída</span>';

            const status = emStopReds
                ? '<span style="color:#ff7777; font-size:11px; font-weight:bold;">🛑 STOP REDS — DESLIGADO</span>'
                : !ativo
                    ? '<span style="color:#ff7777; font-size:11px; font-weight:bold;">🔴 DESLIGADO</span>'
                    : emStandby
                        ? '<span style="color:#ffc107; font-size:11px; font-weight:bold;">🛡️ EM PROTEÇÃO</span>'
                        : '<span style="color:#28a745; font-size:11px; font-weight:bold;">🟢 ATIVO</span>';

            div.innerHTML += `
                <div class="card" style="border-left:4px solid ${cor}; ${ativo ? '' : 'opacity:0.6; filter:grayscale(30%);'}">
                    <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start;">
                        <div>
                            <h3 style="margin:0 0 5px 0; font-size:14px; display:flex; align-items:center; gap:8px;">🤖 ${escapar(robo.nome || 'Robô')} ${robo.tag_visual ? `<span class="robo-tag-badge" style="background:${cor};">${escapar(robo.tag_visual)}</span>` : ''}</h3>
                            ${status}
                        </div>
                        <div style="display:flex; align-items:center; gap:8px;">
                            <label class="switch" title="Ativar/Desativar"><input type="checkbox" ${ativo ? 'checked' : ''} onchange="toggleRoboRapido(${Number(robo.id)}, this)"><span class="slider"></span></label>
                            <button class="btn" style="background:transparent; color:#ffc107; padding:2px; height:auto;" onclick="prepararEdicaoRobo(${Number(robo.id)})">✏️</button>
                            <button class="btn" style="background:transparent; color:#ff7777; padding:2px; height:auto;" onclick="excluirRobo(${Number(robo.id)})">🗑️</button>
                        </div>
                    </div>

                    <div style="margin-top:10px; display:flex; gap:6px; flex-wrap:wrap; font-size:10px;">
                        <span style="background:#111; padding:4px 7px; border-radius:4px;">💻 Web: <strong>${web ? 'ON' : 'OFF'}</strong></span>
                        <span style="background:#111; padding:4px 7px; border-radius:4px;">📱 Telegram: <strong>${tel ? 'ON' : 'OFF'}</strong></span>
                        <span style="background:#111; padding:4px 7px; border-radius:4px;">👥 ${qtdDest}</span>
                        <span style="background:#111; padding:4px 7px; border-radius:4px;">⚡ IA: <strong>${numeroSeguro(robo.qtd_padroes_ia)}</strong></span>
                        ${stopRedsLimite > 0 ? `<span style="background:#111; padding:4px 7px; border-radius:4px;">🛑 Stop Reds: <strong>${stopRedsAtual}/${stopRedsLimite}</strong></span>` : ''}
                    </div>

                    <div style="margin-top:10px; padding:8px; background:#181818; border:1px solid #2b2b2b; border-radius:6px;">
                        <div style="font-size:9px; color:#888; text-transform:uppercase; margin-bottom:5px;">Sintonização</div>
                        <div>${tagsOrigem}</div>
                        <div style="font-size:10px; color:#888; margin-top:6px;">Avulsos: ${avulsos.length} • Exceções: ${excecoes.length}</div>
                    </div>

                    ${htmlTabsRobo(robo)}
                    ${htmlPeriodoRobo(robo, roboPeriodoAtual)}
                </div>`;
        });
    }

    function mudarPeriodoCardRobo(periodo) {
        if (!PERIODOS_ROBO.includes(periodo)) return;
        roboPeriodoAtual = periodo;
        renderizarCardsRobosAprimorado();
    }

    function garantirDashboardDetalhado() {
        const grid = document.querySelector('#aba-dashboard .dashboard-global .grid-dash');
        if (!grid) return;
        grid.id = 'dashboard-resumo-grid';

        if (!document.getElementById('dash-ties')) {
            const ties = document.createElement('div');
            ties.className = 'dash-box';
            ties.innerHTML = '<span>Empates</span><strong id="dash-ties" style="color:#ffc107;">0</strong>';
            grid.appendChild(ties);
        }

        if (!document.getElementById('dash-max-green')) {
            const sequencias = document.createElement('div');
            sequencias.className = 'dash-box';
            sequencias.style.borderColor = '#555';
            sequencias.innerHTML = '<span>Maior Sequência</span><div style="display:flex; justify-content:center; gap:10px; align-items:center; margin-top:3px;"><strong id="dash-max-green" style="color:#28a745; font-size:16px;">✅ 0</strong><strong id="dash-max-red" style="color:#ff7777; font-size:16px;">❌ 0</strong></div>';
            grid.appendChild(sequencias);
        }

        const ordem = [
            document.getElementById('dash-sinais')?.closest('.dash-box'),
            document.getElementById('dash-greens')?.closest('.dash-box'),
            document.getElementById('dash-ties')?.closest('.dash-box'),
            document.getElementById('dash-reds')?.closest('.dash-box'),
            document.getElementById('dash-max-green')?.closest('.dash-box'),
            document.getElementById('dash-assertividade')?.closest('.dash-box')
        ];
        ordem.filter(Boolean).forEach(card => grid.appendChild(card));

        if (!document.getElementById('ux-dashboard-grid-style')) {
            const style = document.createElement('style');
            style.id = 'ux-dashboard-grid-style';
            style.textContent = `
                #dashboard-resumo-grid { grid-template-columns: repeat(6, minmax(0, 1fr)); }
                @media (max-width: 900px) { #dashboard-resumo-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
                @media (max-width: 600px) { #dashboard-resumo-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
            `;
            document.head.appendChild(style);
        }
    }

    function ajustarIconeAutoTrader() {
        const botao = document.getElementById('nav-btn-autotrader');
        if (!botao) return;
        botao.textContent = '📈 Auto-Trader';
        botao.title = 'Motor de execução automática';
    }

    function aplicarAprimoramentosUI() {
        garantirDashboardDetalhado();
        ajustarIconeAutoTrader();
        window.renderizarCardsRobos = renderizarCardsRobosAprimorado;
        window.mudarPeriodoCardRobo = mudarPeriodoCardRobo;

        if (typeof robosGlobais !== 'undefined' && Array.isArray(robosGlobais) && robosGlobais.length > 0) {
            renderizarCardsRobosAprimorado();
        }
        if (typeof window.atualizarDashboardValores === 'function') {
            window.atualizarDashboardValores();
        }
    }

    window.aplicarAprimoramentosUI = aplicarAprimoramentosUI;
    window.renderizarCardsRobosAprimorado = renderizarCardsRobosAprimorado;
    window.mudarPeriodoCardRobo = mudarPeriodoCardRobo;
})();
