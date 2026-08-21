(() => {
    'use strict';

    const fontesUI2 = {
        renderizarCardsRobos: function renderizarCardsRobos() {
            const div = document.getElementById('lista-robos');
            if (!div) return;

            if (!Array.isArray(robosGlobais) || robosGlobais.length === 0) {
                div.innerHTML = '<p style="color:#666; text-align:center; padding:20px; grid-column:span 2; background:#1a1a1a; border:1px dashed #333; border-radius:8px;">Nenhum Robô / Canal cadastrado.</p>';
                return;
            }

            div.innerHTML = robosGlobais.map(robo => {
                const cf = robo.config || {};
                const stats = resumoRobo24h(robo);
                const ativo = boolRobo(robo.ativo);
                const web = boolRobo(robo.enviar_web);
                const tel = boolRobo(robo.enviar_telegram);
                const emStandby = Number(robo.em_standby_ate || 0) > Date.now();
                const stopRedsLimite = Math.max(0, Number(robo.stop_reds_seguidos) || 0);
                const stopRedsAtual = Math.max(0, Number(robo.reds_consecutivos) || 0);
                const emStopReds = !ativo && stopRedsLimite > 0 && stopRedsAtual >= stopRedsLimite;
                const qtdDest = Array.isArray(robo.destinatarios) ? robo.destinatarios.length : 0;
                const origens = Array.isArray(cf.origens) ? cf.origens : [];
                const avulsos = Array.isArray(cf.avulsos) ? cf.avulsos : [];
                const excecoes = Array.isArray(cf.excecoes) ? cf.excecoes : [];

                const tagsOrigem = origens.length
                    ? origens.map(o => `<span class="badge" style="margin-right:4px;">${escaparHtmlRobo(o)}</span>`).join('')
                    : '<span style="color:#666; font-size:11px;">Nenhuma origem incluída</span>';

                const status = emStopReds
                    ? '<span style="color:#ff7777; font-size:11px; font-weight:bold;">🛑 STOP REDS — DESLIGADO</span>'
                    : !ativo
                        ? '<span style="color:#ff7777; font-size:11px; font-weight:bold;">🔴 DESLIGADO</span>'
                        : emStandby
                            ? '<span style="color:#ffc107; font-size:11px; font-weight:bold;">🛡️ EM PROTEÇÃO</span>'
                            : '<span style="color:#28a745; font-size:11px; font-weight:bold;">🟢 ATIVO</span>';

                return `
                    <div class="card" style="border-left:4px solid ${escaparHtmlRobo(robo.cor_hex || '#007bff')}; ${ativo ? '' : 'opacity:0.6;'}">
                        <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start;">
                            <div>
                                <h3 style="margin:0 0 5px 0; font-size:16px;">🤖 ${escaparHtmlRobo(robo.nome || 'Robô')} ${robo.tag_visual ? `<span class="robo-tag-badge" style="background:${escaparHtmlRobo(robo.cor_hex || '#007bff')};">${escaparHtmlRobo(robo.tag_visual)}</span>` : ''}</h3>
                                ${status}
                            </div>
                            <div style="display:flex; align-items:center; gap:8px;">
                                <label class="switch" title="Ativar/Desativar"><input type="checkbox" ${ativo ? 'checked' : ''} onchange="toggleRoboRapido(${Number(robo.id)}, this)"><span class="slider"></span></label>
                                <button class="btn" style="background:transparent; color:#ffc107; padding:2px; height:auto;" onclick="prepararEdicaoRobo(${Number(robo.id)})">✏️</button>
                                <button class="btn" style="background:transparent; color:#ff7777; padding:2px; height:auto;" onclick="excluirRobo(${Number(robo.id)})">🗑️</button>
                            </div>
                        </div>

                        <div style="margin-top:12px; display:flex; gap:8px; flex-wrap:wrap; font-size:11px;">
                            <span style="background:#111; padding:4px 7px; border-radius:4px;">💻 Web: <strong>${web ? 'ON' : 'OFF'}</strong></span>
                            <span style="background:#111; padding:4px 7px; border-radius:4px;">📱 Telegram: <strong>${tel ? 'ON' : 'OFF'}</strong></span>
                            <span style="background:#111; padding:4px 7px; border-radius:4px;">👥 Destinatários: <strong>${qtdDest}</strong></span>
                            <span style="background:#111; padding:4px 7px; border-radius:4px;">⚡ IA: <strong>${Number(robo.qtd_padroes_ia_ativos ?? robo.qtd_padroes_ia ?? 0)}</strong> <small style="color:#888;">(+${Number(robo.qtd_padroes_ia_reserva || 0)} reserva / ${Number(robo.qtd_padroes_ia_sombra || 0)} sombra)</small></span>
                            ${stopRedsLimite > 0 ? `<span style="background:#111; padding:4px 7px; border-radius:4px;">🛑 Stop Reds: <strong>${stopRedsAtual}/${stopRedsLimite}</strong></span>` : ''}
                        </div>

                        <div style="margin-top:12px;">
                            <div style="font-size:10px; color:#888; text-transform:uppercase; margin-bottom:5px;">Sintonização</div>
                            <div>${tagsOrigem}</div>
                            <div style="font-size:10px; color:#888; margin-top:6px;">Avulsos: ${avulsos.length} • Exceções: ${excecoes.length}</div>
                        </div>

                        <div style="margin-top:12px; padding-top:10px; border-top:1px dashed #333; display:flex; justify-content:space-between; font-size:11px;">
                            <span>24h: <strong>${stats.total}</strong> sinais</span>
                            <span style="color:#28a745;">✅ ${stats.greens}</span>
                            <span style="color:#ff7777;">❌ ${stats.reds}</span>
                            <span>🎯 ${stats.assert}%</span>
                        </div>
                    </div>
                `;
            }).join('');
        },

        renderizarCardsAutoTraders: function renderizarCardsAutoTraders() {
            const div = document.getElementById('lista-autotraders');
            if (!div) return;

            if (!Array.isArray(autoTradersGlobais) || autoTradersGlobais.length === 0) {
                div.innerHTML = '<p style="color:#666; text-align:center; padding:20px; background:#1a1a1a; border-radius:8px; border:1px dashed #333;">Nenhum Motor de Execução criado.</p>';
                return;
            }

            div.innerHTML = autoTradersGlobais.map(at => {
                const cf = at.config || {};
                const lucroLiquido = at.saldo_atual - at.saldo_inicial;
                const percLucro = at.saldo_inicial > 0 ? (lucroLiquido / at.saldo_inicial) * 100 : 0;
                const corLucro = lucroLiquido >= 0 ? '#28a745' : '#ff7777';
                const sinalLucro = lucroLiquido >= 0 ? '+' : '';
                let pctWin = 0;
                let pctLoss = 0;
                const stopWinAlvo = cf.stop_win || 100;
                const stopLossAlvo = cf.stop_loss || 250;
                if (lucroLiquido >= 0) pctWin = Math.min(100, (lucroLiquido / stopWinAlvo) * 100);
                else pctLoss = Math.min(100, (Math.abs(lucroLiquido) / stopLossAlvo) * 100);

                const stopRedsLimite = Math.max(0, Number(cf.stop_reds_seguidos) || 0);
                const redsConsecutivos = Math.max(0, Number(at.reds_consecutivos) || 0);
                const stopRedsAcao = String(cf.stop_reds_acao || 'PAUSAR').toUpperCase() === 'DESLIGAR' ? 'DESLIGAR' : 'PAUSAR';
                const pausaStopRedsAte = Math.max(0, Number(at.stop_reds_pausado_ate) || 0);
                const pausaStopRedsMin = Math.max(0, Math.ceil((pausaStopRedsAte - Date.now()) / 60000));
                const stopRedsHTML = stopRedsLimite > 0
                    ? `<div style="margin-top:10px; font-size:11px; color:#fd7e14;">Stop Reds Auto-Trader: <strong>${redsConsecutivos}/${stopRedsLimite}</strong> | ${stopRedsAcao === 'DESLIGAR' ? 'Desligar ao atingir' : 'Pausa de ' + Math.max(1, Number(cf.stop_reds_pausa_min) || 60) + ' min'}</div>`
                    : '<div style="margin-top:10px; font-size:11px; color:#666;">Stop Reds Auto-Trader: desativado</div>';

                let tagStatus = '';
                if (at.status_operacao === 'STOP_WIN') tagStatus = '<span style="background:#198754; color:white; padding:2px 8px; border-radius:4px; font-size:10px;">🏁 STOP WIN ATINGIDO</span>';
                else if (at.status_operacao === 'STOP_LOSS') tagStatus = '<span style="background:#dc3545; color:white; padding:2px 8px; border-radius:4px; font-size:10px;">🛑 STOP LOSS ATINGIDO</span>';
                else if (at.status_operacao === 'TRAILING_STOP') tagStatus = '<span style="background:#6f42c1; color:white; padding:2px 8px; border-radius:4px; font-size:10px;">🛡️ TRAILING STOP ATINGIDO</span>';
                else if (at.status_operacao === 'STOP_REDS') tagStatus = '<span style="background:#dc3545; color:white; padding:2px 8px; border-radius:4px; font-size:10px;">STOP REDS - DESLIGADO</span>';
                else if (at.status_operacao === 'STOP_REDS_PAUSA' && at.ativo) tagStatus = `<span style="background:#fd7e14; color:white; padding:2px 8px; border-radius:4px; font-size:10px;">STOP REDS - ${pausaStopRedsMin > 0 ? `PAUSADO (${pausaStopRedsMin} min)` : 'REARMANDO'}</span>`;
                else if (at.status_operacao === 'DADOS_INCOMPLETOS') tagStatus = '<span style="background:#b02a37; color:white; padding:2px 8px; border-radius:4px; font-size:10px;">⚠️ DADOS INCOMPLETOS</span>';
                else if (at.status_operacao === 'BLOQUEADO_AMBIGUIDADE') tagStatus = '<span style="background:#7f1d1d; color:white; padding:2px 8px; border-radius:4px; font-size:10px;">🚨 BLOQUEADO - ACEITE AMBÍGUO</span>';
                else if (!at.ativo) tagStatus = '<span style="background:#555; color:white; padding:2px 8px; border-radius:4px; font-size:10px;">🔴 DESLIGADO</span>';
                else if (at.status_operacao === 'STANDBY') tagStatus = '<span style="background:#ffc107; color:black; padding:2px 8px; border-radius:4px; font-size:10px;">🟡 AGUARDANDO MESA</span>';
                else if (at.status_operacao === 'META_ATINGIDA') tagStatus = '<span style="background:#17a2b8; color:white; padding:2px 8px; border-radius:4px; font-size:10px;">💤 META DO DIA BATIDA</span>';
                else tagStatus = '<span style="background:#28a745; color:white; padding:2px 8px; border-radius:4px; font-size:10px; animation: animar-piscar 1.5s infinite;">🟢 OPERANDO</span>';

                const trailingRecuo = Math.max(0, Number(cf.trailing_recuo) || 0);
                const trailingPico = Math.max(0, Number(at.trailing_pico_lucro) || 0);
                let trailingHTML = '';
                if (cf.trailing_stop && trailingRecuo > 0) {
                    trailingHTML = `<div style="font-size:10px; color:#aaa; margin-top:2px;">↳ Trailing: recuo R$ ${trailingRecuo.toFixed(2).replace('.',',')} | pico registrado +R$ ${trailingPico.toFixed(2).replace('.',',')}</div>`;
                } else if (cf.trailing_stop) {
                    trailingHTML = '<div style="font-size:10px; color:#ffc107; margin-top:2px;">↳ Trailing habilitado, mas ainda sem recuo configurado.</div>';
                }

                const camuflagemHTML = cf.modo_camuflagem === 'PULOS'
                    ? `<span style="display:inline-block; margin-top:5px; background:#111; padding:4px 8px; border-radius:4px; border:1px solid #333; font-size:11px;">🕵️ Camuflagem: Pulará <strong>${at.pulos_restantes}</strong> ordens.</span>`
                    : '';

                const strFontes = (cf.fontes_sinal || []).map(f => {
                    const rotulo = rotuloFonteAutoTrader(f);
                    const fonteRobo = /^(?:ROBO|AUTO_PILOT_IA):/i.test(String(f || '')) || rotulo.includes('[AUTO]');
                    return `<span style="font-size:10px; padding:2px 6px; border-radius:4px; background:${fonteRobo?'#17a2b8':'#444'}; color:white; margin-right:4px;">${rotulo}</span>`;
                }).join('');

                return `
                    <div class="card" style="border-left: 4px solid #28a745; ${at.ativo?'':'opacity:0.6; filter:grayscale(50%);'}">
                        <div style="display:flex; justify-content:space-between; align-items:start;">
                            <div><h3 style="margin:0 0 5px 0; font-size:18px; color:#fff;">🎯 ${at.nome}</h3>${tagStatus}</div>
                            <div style="display:flex; gap:10px; align-items:center;">
                                <label class="switch" title="On/Off Motor"><input type="checkbox" ${at.ativo?'checked':''} onchange="toggleAutoTraderRapido(${at.id}, this)"><span class="slider"></span></label>
                                <button class="btn" style="background:transparent; color:#ffc107; padding:2px; font-size:14px; height:auto;" onclick="prepararEdicaoAutoTrader(${at.id})" title="Configurar Cérebro">⚙️</button>
                                <button class="btn" style="background:transparent; color:#ff7777; padding:2px; font-size:14px; height:auto;" onclick="excluirAutoTrader(${at.id})" title="Excluir Motor">🗑️</button>
                            </div>
                        </div>
                        <div style="margin-top:20px; display:flex; gap:20px; flex-wrap:wrap;">
                            <div style="flex:1; min-width:200px;">
                                <h4 style="margin:0 0 10px 0; font-size:11px; color:#888; text-transform:uppercase;">🏦 Status Financeiro da Conta</h4>
                                <div style="font-size:13px; margin-bottom:5px;">Banca Inicial Lida: <strong style="color:#aaa;">R$ ${at.saldo_inicial.toFixed(2).replace('.',',')}</strong></div>
                                <div style="font-size:13px; margin-bottom:10px;">Saldo Atual da Corretora: <strong style="color:#fff; font-size:16px;">R$ ${at.saldo_atual.toFixed(2).replace('.',',')}</strong></div>
                                <div style="background:#111; border:1px solid #333; padding:10px; border-radius:6px;">
                                    <span style="display:block; font-size:10px; color:#888; text-transform:uppercase;">Variação do saldo sincronizado</span>
                                    <strong style="font-size:22px; color:${corLucro};">${sinalLucro} R$ ${Math.abs(lucroLiquido).toFixed(2).replace('.',',')}</strong>
                                    <span style="font-size:12px; color:${corLucro}; margin-left:10px;">(${sinalLucro}${percLucro.toFixed(2)}%)</span>
                                </div>
                            </div>
                            <div style="flex:1; min-width:200px;">
                                <h4 style="margin:0 0 10px 0; font-size:11px; color:#888; text-transform:uppercase;">🛡️ Limites de Risco e Metas</h4>
                                <div style="margin-bottom:15px;"><div style="display:flex; justify-content:space-between; font-size:11px; margin-bottom:2px;"><span style="color:#28a745;">🏆 Stop Win: R$ ${stopWinAlvo.toFixed(2).replace('.',',')}</span><span>${pctWin.toFixed(1)}% Completo</span></div><div class="progress-bar-bg"><div class="progress-bar-fill" style="width:${pctWin}%; background:#28a745;"></div></div>${trailingHTML}</div>
                                <div style="margin-bottom:10px;"><div style="display:flex; justify-content:space-between; font-size:11px; margin-bottom:2px;"><span style="color:#ff7777;">🛑 Stop Loss: R$ ${stopLossAlvo.toFixed(2).replace('.',',')}</span><span>${pctLoss.toFixed(1)}% Consumido</span></div><div class="progress-bar-bg"><div class="progress-bar-fill" style="width:${pctLoss}%; background:#ff7777;"></div></div></div>
                                ${stopRedsHTML}
                            </div>
                        </div>
                        <div style="margin-top:20px; border-top:1px dashed #333; padding-top:15px; display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:10px;">
                            <div><div style="font-size:12px; margin-bottom:5px;">📊 Volume: <strong>${at.entradas_feitas} / ${cf.limite_entradas||'∞'} Execuções</strong></div><div style="margin-bottom:5px;">📡 Escutando: ${strFontes || '<span style="color:#666; font-size:11px;">Sem robôs vinculados</span>'}</div>${camuflagemHTML}</div>
                            <button class="btn" style="background:#fff; color:#000; box-shadow: 0 4px 10px rgba(255,255,255,0.2);" onclick="gerarRelatorioPDF(${at.id})">📄 Gerar Auditoria PDF</button>
                        </div>
                    </div>
                `;
            }).join('');
        },

        gerarHtmlCardEstrategia: function gerarHtmlCardEstrategia(est, idPrefixo, periodoGlobal) {
            const periodos = ['24h', 'hoje', 'semana', 'mes', 'geral'];
            const isAtivo = idPrefixo === 'ativo';
            const periodoSelecionado = periodos.includes(isAtivo ? dashPeriodoAtual : periodoGlobal)
                ? (isAtivo ? dashPeriodoAtual : periodoGlobal)
                : '24h';

            const calcularResumo = (periodo) => {
                const s = est.detalhes?.[periodo];
                if (!s) return { perc: '-', totais: 0 };
                let tiesNum = 0;
                ['direto', 'gale1', 'gale2'].forEach(nivel => {
                    Object.values(s.ties?.[nivel] || {}).forEach(q => {
                        tiesNum += Number(q) || 0;
                    });
                });
                const greens = (Number(s.green_direto) || 0) + (Number(s.gale1) || 0) + (Number(s.gale2) || 0) + tiesNum;
                const reds = Number(s.red) || 0;
                const total = greens + reds;
                const assertividade = total > 0 ? (greens / total) * 100 : 0;
                return {
                    perc: assertividade > 0 ? `${assertividade.toFixed(1)}%` : '-',
                    totais: total
                };
            };

            const resumos = Object.fromEntries(periodos.map(periodo => [periodo, calcularResumo(periodo)]));

            const renderizarDetalhe = (periodo) => {
                const s = est.detalhes?.[periodo];
                if (!s) return '';

                let tiesNum = 0;
                const htmlTies = ['direto', 'gale1', 'gale2'].map(nivel => {
                    const itens = Object.entries(s.ties?.[nivel] || {})
                        .filter(([, quantidade]) => Number(quantidade) > 0)
                        .map(([multiplicador, quantidade]) => {
                            const qtd = Number(quantidade) || 0;
                            tiesNum += qtd;
                            return `<strong>${qtd}</strong> - ${multiplicador}`;
                        });
                    return itens.length
                        ? `<div style="font-size: 10px; margin-bottom:2px;">${nivel.toUpperCase()}: ${itens.join(' | ')}</div>`
                        : '';
                }).join('');

                const greensSemTie = (Number(s.green_direto) || 0) + (Number(s.gale1) || 0) + (Number(s.gale2) || 0);
                const greensTotal = greensSemTie + tiesNum;
                const reds = Number(s.red) || 0;
                const total = greensTotal + reds;
                const pctGreen = total > 0 ? ((greensSemTie / total) * 100).toFixed(1) : '0.0';
                const pctTie = total > 0 ? ((tiesNum / total) * 100).toFixed(1) : '0.0';
                const pctRed = total > 0 ? ((reds / total) * 100).toFixed(1) : '0.0';
                const assertividade = total > 0 ? ((greensTotal / total) * 100).toFixed(1) : '0.0';

                return `<div id="detalhe-${idPrefixo}-${est.id}-${periodo}" class="detalhes-tecnicos detalhes-grupo-${idPrefixo}-${est.id}" style="display:block; margin-top:auto;"><div style="display:flex; justify-content:space-between; border-bottom:1px solid #444; margin-bottom:5px; padding-bottom:4px;"><span>Entradas: <strong>${total}</strong></span><span>Assertividade: <strong style="color:${getCor(assertividade)};">${assertividade}%</strong></span></div><div class="linha-detalhe" style="align-items:center;"><span>✅ Greens: <strong style="color:#28a745;">${greensSemTie}</strong> <small style="color:#aaa;">(${pctGreen}%)</small></span><div style="display:flex; gap:10px; font-size:11px; color:#ccc;"><span>Dir: <strong>${Number(s.green_direto) || 0}</strong></span><span>G1: <strong>${Number(s.gale1) || 0}</strong></span><span>G2: <strong>${Number(s.gale2) || 0}</strong></span></div></div><div class="linha-detalhe" style="flex-direction:column;"><span>🟡 Empates: <strong style="color:#ffc107;">${tiesNum}</strong> <small style="color:#aaa;">(${pctTie}%)</small></span><div class="tie-box">${htmlTies || '<span style="font-size:10px; color:#666;">Sem empates</span>'}</div></div><div class="linha-detalhe" style="margin-top:5px; border-bottom:none; padding-bottom:0;"><span>❌ Reds: <strong style="color:#ff7777;">${reds}</strong> <small style="color:#aaa;">(${pctRed}%)</small></span></div></div>`;
            };

            let switchHtml = '';
            if (!isAtivo) {
                if (est.is_dinamico) {
                    switchHtml = '<span style="font-size:11px; color:#17a2b8; font-weight:bold;">⚡ IA Automática</span>';
                } else {
                    switchHtml = `<label class="switch" title="Ativar/Pausar"><input type="checkbox" ${est.ativo?'checked':''} onchange="toggleEstrategiaRapido('${est.id}', this)"><span class="slider"></span></label><button class="btn" style="background:transparent; color:#ffc107; padding:2px; font-size:14px; height:auto;" onclick="prepararEdicao('${est.id}')">✏️</button><button class="btn" style="background:transparent; color:#ff7777; padding:2px; font-size:14px; height:auto;" onclick="excluirEstrategia('${est.id}')">🗑️</button>`;
                }
            }

            let padraoArr = [];
            try {
                padraoArr = Array.isArray(est.padrao) ? est.padrao : JSON.parse(est.padrao);
            } catch (_) {
                padraoArr = [];
            }
            const bolinhasHtml = padraoArr.map(j => {
                const bk = j === 'Player' ? '#007bff' : (j === 'Banker' ? '#ff7777' : '#ffc107');
                const cl = j === 'Tie' ? '#000' : '#fff';
                return `<span style="background:${bk}; color:${cl}; padding: 4px 8px; font-size: 11px; border-radius:4px; font-weight:bold;">${String(j).charAt(0)}</span>`;
            }).join(' <span style="color:#555; font-size:10px;">➡️</span> ');

            const rotulos = { '24h': '24H', hoje: 'Hoje', semana: 'Semana', mes: 'Mês', geral: 'Geral' };
            const menusTabs = `<div class="grid-performance">${periodos.map(periodo => {
                const resumo = resumos[periodo];
                return `<div class="box-tempo ${periodoSelecionado === periodo ? 'ativo' : ''}" onclick="mudarPeriodoCardEstrategia('${idPrefixo}', '${periodo}')"><span>${rotulos[periodo]}</span><strong style="color:${getCor(resumo.perc)}">${resumo.perc}</strong></div>`;
            }).join('')}</div>`;

            const detailsToRender = renderizarDetalhe(periodoSelecionado);
            const iaBadge = est.is_dinamico
                ? '<span style="background: #17a2b8; color: white; padding: 2px 5px; font-size: 10px; border-radius: 4px; margin-left: 8px;">🤖 IA Dinâmica</span>'
                : '';
            let lockMsg = '';
            if (est.is_dinamico && !isAtivo) {
                lockMsg = est.quarentena_restante > 0
                    ? `<div style="text-align:center; margin-top:10px; padding:4px; background:#222; border-radius:4px; font-size:10px; color:#ffc107; border:1px dashed #ffc107;">⏱️ EM QUARENTENA: Restam ${est.quarentena_restante} giros.</div>`
                    : '<div style="text-align:center; margin-top:10px; padding:4px; background:#222; border-radius:4px; font-size:10px; color:#28a745; border:1px dashed #28a745;">✅ Padrão Aprovado e Gerenciado pela IA</div>';
            }

            return `<div class="card" style="${est.ativo?'':'opacity: 0.6; filter: grayscale(30%);'} ${isAtivo?'margin-bottom:0;':''}"><div style="display:flex; justify-content:space-between; align-items:start;"><h3 style="margin:0 0 5px 0; font-size: 14px; display:flex; align-items:center; gap:8px;">${est.nome} <span class="badge" style="margin:0;">${est.origem}</span> ${iaBadge}</h3><div style="display:flex; gap:10px; align-items:center;">${switchHtml}</div></div><div style="margin: 12px 0;">${bolinhasHtml}</div><p style="margin: 0 0 10px 0; font-size: 11px; color: #aaa;">Entrada: <strong style="color:${est.entrada==='Player'?'#007bff':'#ff7777'}">${est.entrada==='Player'?'🔵 Player':'🔴 Banker'}</strong> | G${est.gales} ${est.proteger_empate?'| 🟡 Prot. Empate':''}</p>${menusTabs}${detailsToRender}${lockMsg}</div>`;
        },

        aplicarFiltrosEOrdenar: function aplicarFiltrosEOrdenar() {
            const oFiltro = document.getElementById('select-origem-filtro').value;
            const tFiltro = document.getElementById('select-tipo-filtro').value;
            const div = document.getElementById('lista-padroes');
            if (!div) return;

            let filtradas = [...estrategiasGlobais];
            if (oFiltro.startsWith('MANUAL:')) {
                const origemManual = decodeURIComponent(oFiltro.slice('MANUAL:'.length));
                filtradas = filtradas.filter(est =>
                    !estrategiaEhDinamica(est) && String(est.origem || '') === origemManual
                );
            } else if (oFiltro.startsWith('IA:')) {
                const roboDonoId = decodeURIComponent(oFiltro.slice('IA:'.length));
                filtradas = filtradas.filter(est =>
                    estrategiaEhDinamica(est) && String(est.robo_dono_id) === roboDonoId
                );
            }

            if (tFiltro === 'MANUAIS') {
                filtradas = filtradas.filter(est => !estrategiaEhDinamica(est));
            } else if (tFiltro === 'DINAMICOS') {
                filtradas = filtradas.filter(estrategiaEhDinamica);
            }

            const ordem = document.getElementById('select-ordem-filtro').value;
            if (ordem === 'nome') {
                filtradas.sort((a, b) => String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR'));
            } else if (ordem === 'status') {
                filtradas.sort((a, b) =>
                    Number(b.ativo === 1 || b.ativo === true) - Number(a.ativo === 1 || a.ativo === true)
                );
            } else if (ordem === 'ocorr' || ordem === 'assert') {
                const statsPorId = new Map(filtradas.map(est => {
                    const s = est.detalhes?.[padroesPeriodoAtual];
                    if (!s) return [String(est.id), { tot: 0, ass: 0 }];
                    let tiesNum = 0;
                    ['direto', 'gale1', 'gale2'].forEach(nivel => {
                        Object.values(s.ties?.[nivel] || {}).forEach(q => {
                            tiesNum += Number(q) || 0;
                        });
                    });
                    const greens = (Number(s.green_direto) || 0) + (Number(s.gale1) || 0) + (Number(s.gale2) || 0) + tiesNum;
                    const reds = Number(s.red) || 0;
                    const tot = greens + reds;
                    return [String(est.id), { tot, ass: tot > 0 ? (greens / tot) * 100 : 0 }];
                }));

                filtradas.sort((a, b) => {
                    const sA = statsPorId.get(String(a.id)) || { tot: 0, ass: 0 };
                    const sB = statsPorId.get(String(b.id)) || { tot: 0, ass: 0 };
                    return ordem === 'ocorr' ? sB.tot - sA.tot : sB.ass - sA.ass;
                });
            }

            div.innerHTML = filtradas.length
                ? filtradas.map(est => gerarHtmlCardEstrategia(est, 'lista', padroesPeriodoAtual)).join('')
                : '<p style="color: #666; text-align: center; padding: 20px; grid-column: span 2;">Nenhuma estratégia encontrada.</p>';
        }
    };

    function substituirFuncao(codigo, marcadorInicio, marcadorSeguinte, funcaoNova) {
        const inicio = codigo.indexOf(marcadorInicio);
        if (inicio < 0) throw new Error(`UI-2: início não encontrado: ${marcadorInicio}`);

        const fim = codigo.indexOf(marcadorSeguinte, inicio + marcadorInicio.length);
        if (fim < 0) throw new Error(`UI-2: fim não encontrado após: ${marcadorInicio}`);

        return codigo.slice(0, inicio) + funcaoNova.toString() + '\n\n        ' + codigo.slice(fim);
    }

    function otimizarScriptPrincipalUI2(codigoOriginal) {
        let codigo = String(codigoOriginal || '');

        codigo = substituirFuncao(
            codigo,
            'function renderizarCardsRobos() {',
            'function atualizarFiltrosRoboUI() {',
            fontesUI2.renderizarCardsRobos
        );
        codigo = substituirFuncao(
            codigo,
            'function renderizarCardsAutoTraders() {',
            'function escaparHtmlPdf(valor) {',
            fontesUI2.renderizarCardsAutoTraders
        );
        codigo = substituirFuncao(
            codigo,
            'function gerarHtmlCardEstrategia(est, idPrefixo, periodoGlobal) {',
            'function mudarPeriodoCardEstrategia(tipoCard, periodo) {',
            fontesUI2.gerarHtmlCardEstrategia
        );
        codigo = substituirFuncao(
            codigo,
            'function aplicarFiltrosEOrdenar() {',
            'function mudarAbaRoboStats(idC, p) {',
            fontesUI2.aplicarFiltrosEOrdenar
        );

        return codigo;
    }

    window.otimizarScriptPrincipalUI2 = otimizarScriptPrincipalUI2;
    window.__domUi2Ready = true;
})();
