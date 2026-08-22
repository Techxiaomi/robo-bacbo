(() => {
    'use strict';

    const HORARIO_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
    const FAIXA_PADRAO = Object.freeze({ inicio: '00:00', fim: '23:59' });
    let configurado = false;

    function horarioValido(valor) {
        return typeof valor === 'string' && HORARIO_RE.test(valor.trim());
    }

    function copiarFaixa(faixa) {
        return {
            inicio: String(faixa.inicio).trim(),
            fim: String(faixa.fim).trim()
        };
    }

    function normalizarFaixasFrontend(config = {}) {
        const cf = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
        if (Array.isArray(cf.faixas_horario) && cf.faixas_horario.length > 0) {
            const validas = cf.faixas_horario
                .filter(faixa => faixa && typeof faixa === 'object' && horarioValido(faixa.inicio) && horarioValido(faixa.fim))
                .map(copiarFaixa);
            if (validas.length === cf.faixas_horario.length) return validas;
        }

        const inicioLegado = horarioValido(cf.hora_inicio) ? String(cf.hora_inicio).trim() : FAIXA_PADRAO.inicio;
        const fimLegado = horarioValido(cf.hora_fim) ? String(cf.hora_fim).trim() : FAIXA_PADRAO.fim;
        return [{ inicio: inicioLegado, fim: fimLegado }];
    }

    function canonicalizarConfigFrontend(config = {}) {
        const normalizada = { ...(config || {}) };
        normalizada.faixas_horario = normalizarFaixasFrontend(normalizada);
        delete normalizada.hora_inicio;
        delete normalizada.hora_fim;
        return normalizada;
    }

    function garantirEstruturaHorario() {
        if (document.getElementById('at-faixas-horario')) return true;

        const inicioLegado = document.getElementById('at-hora-inicio');
        const fimLegado = document.getElementById('at-hora-fim');
        if (!inicioLegado || !fimLegado) return false;

        const linhaLegada = inicioLegado.closest('.form-group')?.parentElement;
        const secao = linhaLegada?.parentElement;
        if (!secao) return false;

        secao.innerHTML = `
            <h4 style="margin:0 0 8px 0; font-size:12px; color:#aaa; text-transform:uppercase;">Horário de Atividade</h4>
            <p style="font-size:10px; color:#888; margin:0 0 10px 0;">O motor aceita novas entradas quando o horário atual estiver dentro de qualquer faixa configurada.</p>
            <input type="hidden" id="at-hora-inicio" value="00:00">
            <input type="hidden" id="at-hora-fim" value="23:59">
            <div id="at-faixas-horario" style="display:flex; flex-direction:column; gap:8px;"></div>
            <button type="button" class="btn" style="margin-top:10px; background:#17a2b8; height:30px; font-size:11px;" onclick="adicionarFaixaHorarioAutoTrader()">+ Adicionar nova faixa</button>
        `;
        return true;
    }

    function atualizarBotoesRemover() {
        const linhas = Array.from(document.querySelectorAll('#at-faixas-horario .at-faixa-horario'));
        linhas.forEach(linha => {
            const botao = linha.querySelector('.at-remover-faixa');
            if (!botao) return;
            botao.disabled = linhas.length <= 1;
            botao.style.opacity = linhas.length <= 1 ? '0.35' : '1';
            botao.style.cursor = linhas.length <= 1 ? 'not-allowed' : 'pointer';
        });
    }

    function adicionarFaixaHorarioAutoTrader(inicio = '00:00', fim = '23:59') {
        if (!garantirEstruturaHorario()) return;
        const box = document.getElementById('at-faixas-horario');
        const linha = document.createElement('div');
        linha.className = 'at-faixa-horario';
        linha.style.cssText = 'display:grid; grid-template-columns:minmax(120px,1fr) minmax(120px,1fr) auto; gap:10px; align-items:end; padding:10px; background:#111; border:1px solid #333; border-radius:6px;';
        linha.innerHTML = `
            <div class="form-group" style="margin:0;">
                <label>Início:</label>
                <input type="time" class="at-faixa-inicio" value="${horarioValido(inicio) ? String(inicio).trim() : FAIXA_PADRAO.inicio}">
            </div>
            <div class="form-group" style="margin:0;">
                <label>Fim:</label>
                <input type="time" class="at-faixa-fim" value="${horarioValido(fim) ? String(fim).trim() : FAIXA_PADRAO.fim}">
            </div>
            <button type="button" class="btn at-remover-faixa" style="background:#ff7777; height:34px; padding:0 12px; font-size:11px;" onclick="removerFaixaHorarioAutoTrader(this)">Remover faixa</button>
        `;
        box.appendChild(linha);
        atualizarBotoesRemover();
    }

    function removerFaixaHorarioAutoTrader(botao) {
        const linhas = document.querySelectorAll('#at-faixas-horario .at-faixa-horario');
        if (linhas.length <= 1) return;
        botao?.closest('.at-faixa-horario')?.remove();
        atualizarBotoesRemover();
    }

    function renderizarFaixasHorarioAutoTrader(faixas) {
        if (!garantirEstruturaHorario()) return;
        const box = document.getElementById('at-faixas-horario');
        box.innerHTML = '';
        const lista = Array.isArray(faixas) && faixas.length > 0 ? faixas : [FAIXA_PADRAO];
        lista.forEach(faixa => adicionarFaixaHorarioAutoTrader(faixa.inicio, faixa.fim));
        atualizarBotoesRemover();
    }

    function coletarFaixasHorarioAutoTrader() {
        const linhas = Array.from(document.querySelectorAll('#at-faixas-horario .at-faixa-horario'));
        if (linhas.length === 0) {
            throw new Error('Adicione ao menos uma faixa de horário.');
        }

        return linhas.map((linha, indice) => {
            const inicio = String(linha.querySelector('.at-faixa-inicio')?.value || '').trim();
            const fim = String(linha.querySelector('.at-faixa-fim')?.value || '').trim();
            if (!horarioValido(inicio) || !horarioValido(fim)) {
                throw new Error(`Faixa ${indice + 1}: informe início e fim válidos.`);
            }
            return { inicio, fim };
        });
    }

    function envolverAberturaEdicao() {
        if (window.__activityScheduleFormsWrapped) return;
        window.__activityScheduleFormsWrapped = true;

        const abrirOriginal = window.abrirFormularioAutoTrader;
        const editarOriginal = window.prepararEdicaoAutoTrader;

        if (typeof abrirOriginal === 'function') {
            window.abrirFormularioAutoTrader = function abrirFormularioAutoTraderComFaixas(...args) {
                const retorno = abrirOriginal.apply(this, args);
                renderizarFaixasHorarioAutoTrader([FAIXA_PADRAO]);
                return retorno;
            };
        }

        if (typeof editarOriginal === 'function') {
            window.prepararEdicaoAutoTrader = function prepararEdicaoAutoTraderComFaixas(id, ...args) {
                const retorno = editarOriginal.call(this, id, ...args);
                const trader = typeof autoTradersGlobais !== 'undefined' && Array.isArray(autoTradersGlobais)
                    ? autoTradersGlobais.find(item => Number(item.id) === Number(id))
                    : null;
                renderizarFaixasHorarioAutoTrader(normalizarFaixasFrontend(trader?.config || {}));
                return retorno;
            };
        }
    }

    async function salvarAutoTraderComFaixas() {
        const nome = document.getElementById('at-nome').value.trim();
        if (!nome) return alert('Preencha o Nome do Motor.');
        const ativoAT = document.getElementById('at-ativo').checked;
        const tieModo = document.getElementById('at-tie-modo').value === 'VALOR' ? 'VALOR' : 'PERCENTUAL';
        const tiePercent = Number(document.getElementById('at-tie-percent').value) || 0;
        const tieValor = Number(document.getElementById('at-tie-valor').value) || 0;
        if (ativoAT && ((tieModo === 'PERCENTUAL' && tiePercent <= 0) || (tieModo === 'VALOR' && tieValor <= 0))) {
            return alert('Defina a política financeira da proteção no empate antes de ativar o Auto-Trader.');
        }

        let faixasHorario;
        try {
            faixasHorario = coletarFaixasHorarioAutoTrader();
        } catch (erro) {
            return alert(erro.message || 'Revise as faixas de horário.');
        }

        const payload = {
            nome,
            ativo: ativoAT,
            config: {
                stake_inicial: parseFloat(document.getElementById('at-stake').value) || 10.0,
                gale_1_mult: parseFloat(document.getElementById('at-gale1').value) || 2.0,
                gale_2_mult: parseFloat(document.getElementById('at-gale2').value) || 4.0,
                tie_stake_mode: tieModo,
                tie_stake_percent: tiePercent,
                tie_stake_value: tieValor,
                modo_camuflagem: document.getElementById('at-camuflagem').value,
                camuflagem_pulos_min: parseInt(document.getElementById('at-pulo-min').value) || 1,
                camuflagem_pulos_max: parseInt(document.getElementById('at-pulo-max').value) || 3,
                limite_entradas: parseInt(document.getElementById('at-max-entradas').value) || 15,
                stop_win: parseFloat(document.getElementById('at-stop-win').value) || 100.0,
                trailing_stop: document.getElementById('at-trailing-stop').checked,
                trailing_recuo: Math.max(0, parseFloat(document.getElementById('at-trailing-recuo').value) || 0),
                stop_loss: parseFloat(document.getElementById('at-stop-loss').value) || 250.0,
                stop_reds_seguidos: Math.max(0, parseInt(document.getElementById('at-stop-reds').value) || 0),
                stop_reds_acao: document.getElementById('at-stop-reds-acao').value === 'DESLIGAR' ? 'DESLIGAR' : 'PAUSAR',
                stop_reds_pausa_min: Math.max(1, parseInt(document.getElementById('at-stop-reds-pausa').value) || 60),
                faixas_horario: faixasHorario,
                fontes_sinal: Array.from(document.querySelectorAll('.chk-at-fonte:checked')).map(i => i.value)
            }
        };

        try {
            const res = await fetch(
                autoTraderEditandoId ? `/api/auto-trader/${autoTraderEditandoId}` : '/api/auto-trader',
                {
                    method: autoTraderEditandoId ? 'PUT' : 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(payload)
                }
            );

            let resposta = {};
            try { resposta = await res.json(); } catch (e) {}

            if (!res.ok) {
                return alert(resposta.mensagem || 'Erro ao salvar o Auto-Trader.');
            }

            fecharFormularioAutoTrader();
            await carregarAutoTraders();
        } catch(e) {
            alert('Erro de conexão.');
        }
    }

    function envolverToggleRapido() {
        window.toggleAutoTraderRapido = async function toggleAutoTraderRapidoComFaixas(id, check) {
            const at = typeof autoTradersGlobais !== 'undefined' && Array.isArray(autoTradersGlobais)
                ? autoTradersGlobais.find(x => Number(x.id) === Number(id))
                : null;
            if (!at) return;

            const novoAtivo = !!check.checked;
            const payload = {
                ...at,
                ativo: novoAtivo,
                config: canonicalizarConfigFrontend(at.config || {})
            };

            try {
                const res = await fetch(`/api/auto-trader/${id}`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(payload)
                });

                let resposta = {};
                try { resposta = await res.json(); } catch (e) {}
                if (!res.ok) {
                    throw new Error(resposta.mensagem || 'Falha ao atualizar o Auto-Trader.');
                }

                await carregarAutoTraders();
            } catch(e) {
                check.checked = !novoAtivo;
                alert(e.message || 'Erro ao atualizar o Auto-Trader.');
            }
        };
    }

    function configurarFaixasHorarioAutoTrader() {
        if (configurado) return;
        if (!garantirEstruturaHorario()) return;
        configurado = true;
        envolverAberturaEdicao();
        envolverToggleRapido();
        window.salvarAutoTrader = salvarAutoTraderComFaixas;
        renderizarFaixasHorarioAutoTrader([FAIXA_PADRAO]);
    }

    window.adicionarFaixaHorarioAutoTrader = adicionarFaixaHorarioAutoTrader;
    window.removerFaixaHorarioAutoTrader = removerFaixaHorarioAutoTrader;
    window.renderizarFaixasHorarioAutoTrader = renderizarFaixasHorarioAutoTrader;
    window.coletarFaixasHorarioAutoTrader = coletarFaixasHorarioAutoTrader;
    window.configurarFaixasHorarioAutoTrader = configurarFaixasHorarioAutoTrader;
    window.__activityScheduleUiReady = true;
})();
