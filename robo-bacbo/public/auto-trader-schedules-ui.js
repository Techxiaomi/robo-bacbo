(() => {
    'use strict';

    const REGEX_HORARIO = /^([01]\d|2[0-3]):([0-5]\d)$/;
    let instalado = false;
    let abrirOriginal = null;
    let editarOriginal = null;

    function horarioValido(valor) {
        return REGEX_HORARIO.test(String(valor || '').trim());
    }

    function normalizarFaixas(config = {}) {
        const cf = config && typeof config === 'object' ? config : {};
        const faixas = Array.isArray(cf.faixas_horario)
            ? cf.faixas_horario
                .map(faixa => ({
                    inicio: String(faixa?.inicio || '').trim(),
                    fim: String(faixa?.fim || '').trim()
                }))
                .filter(faixa => horarioValido(faixa.inicio) && horarioValido(faixa.fim))
            : [];

        if (faixas.length > 0) return faixas;

        return [{
            inicio: horarioValido(cf.hora_inicio) ? cf.hora_inicio : '00:00',
            fim: horarioValido(cf.hora_fim) ? cf.hora_fim : '23:59'
        }];
    }

    function coletarFaixas() {
        const container = document.getElementById('at-faixas-horario');
        if (!container) return [];
        return Array.from(container.querySelectorAll('.at-faixa-horario'))
            .map(linha => ({
                inicio: String(linha.querySelector('.at-faixa-inicio')?.value || '').trim(),
                fim: String(linha.querySelector('.at-faixa-fim')?.value || '').trim()
            }));
    }

    function renderizarFaixas(faixasBrutas) {
        const container = document.getElementById('at-faixas-horario');
        if (!container) return;

        const faixas = Array.isArray(faixasBrutas) && faixasBrutas.length > 0
            ? faixasBrutas
            : [{ inicio: '00:00', fim: '23:59' }];

        container.innerHTML = faixas.map((faixa, indice) => `
            <div class="at-faixa-horario" style="display:flex; gap:10px; align-items:flex-end; padding:10px; background:#111; border:1px solid #333; border-radius:6px; flex-wrap:wrap;">
                <div class="form-group" style="flex:1; min-width:150px; margin:0;">
                    <label>Início:</label>
                    <input type="time" class="at-faixa-inicio" value="${horarioValido(faixa.inicio) ? faixa.inicio : '00:00'}">
                </div>
                <div class="form-group" style="flex:1; min-width:150px; margin:0;">
                    <label>Fim:</label>
                    <input type="time" class="at-faixa-fim" value="${horarioValido(faixa.fim) ? faixa.fim : '23:59'}">
                </div>
                <button type="button" class="btn" onclick="removerFaixaHorarioAutoTrader(${indice})"
                    style="background:#6c2730; height:34px; padding:0 12px;" ${faixas.length <= 1 ? 'disabled' : ''}>Remover</button>
            </div>
        `).join('');
    }

    function adicionarFaixa() {
        const faixas = coletarFaixas();
        faixas.push({ inicio: '00:00', fim: '23:59' });
        renderizarFaixas(faixas);
    }

    function removerFaixa(indice) {
        const faixas = coletarFaixas();
        if (faixas.length <= 1) return;
        faixas.splice(Number(indice), 1);
        renderizarFaixas(faixas);
    }

    function garantirEstrutura() {
        if (document.getElementById('at-faixas-horario')) return true;

        const inicioLegado = document.getElementById('at-hora-inicio');
        const fimLegado = document.getElementById('at-hora-fim');
        const linhaLegada = inicioLegado?.parentElement?.parentElement;
        const secao = linhaLegada?.parentElement;
        if (!inicioLegado || !fimLegado || !secao) return false;

        secao.innerHTML = `
            <input type="hidden" id="at-hora-inicio" value="00:00">
            <input type="hidden" id="at-hora-fim" value="23:59">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:10px; flex-wrap:wrap;">
                <h4 style="margin:0; font-size:12px; color:#aaa; text-transform:uppercase;">Horário de Execução</h4>
                <button type="button" class="btn" onclick="adicionarFaixaHorarioAutoTrader()"
                    style="height:30px; padding:0 12px; font-size:11px; background:#1769aa;">+ Adicionar Faixa</button>
            </div>
            <div id="at-faixas-horario" style="display:flex; flex-direction:column; gap:8px;"></div>
            <small style="display:block; color:#777; margin-top:8px;">O motor pode operar dentro de qualquer uma das faixas cadastradas.</small>
        `;
        renderizarFaixas([{ inicio: '00:00', fim: '23:59' }]);
        return true;
    }

    async function salvarComFaixas() {
        const nome = document.getElementById('at-nome').value.trim();
        if (!nome) return alert('Preencha o Nome do Motor.');

        const faixas = coletarFaixas();
        if (faixas.length === 0) return alert('Cadastre ao menos uma faixa de horário.');
        for (let i = 0; i < faixas.length; i++) {
            if (!horarioValido(faixas[i].inicio) || !horarioValido(faixas[i].fim)) {
                return alert(`Faixa ${i + 1}: informe início e fim válidos.`);
            }
        }

        const ativoAT = document.getElementById('at-ativo').checked;
        const tieModo = document.getElementById('at-tie-modo').value === 'VALOR' ? 'VALOR' : 'PERCENTUAL';
        const tiePercent = Number(document.getElementById('at-tie-percent').value) || 0;
        const tieValor = Number(document.getElementById('at-tie-valor').value) || 0;
        if (ativoAT && ((tieModo === 'PERCENTUAL' && tiePercent <= 0) || (tieModo === 'VALOR' && tieValor <= 0))) {
            return alert('Defina a política financeira da proteção no empate antes de ativar o Auto-Trader.');
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
                faixas_horario: faixas,
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
        } catch (e) {
            alert('Erro de conexão.');
        }
    }

    function instalarHooks() {
        if (instalado) return;
        if (!garantirEstrutura()) return;
        if (typeof window.abrirFormularioAutoTrader !== 'function' || typeof window.prepararEdicaoAutoTrader !== 'function') return;

        abrirOriginal = window.abrirFormularioAutoTrader;
        editarOriginal = window.prepararEdicaoAutoTrader;

        window.abrirFormularioAutoTrader = function abrirFormularioAutoTraderComFaixas() {
            abrirOriginal();
            renderizarFaixas([{ inicio: '00:00', fim: '23:59' }]);
        };

        window.prepararEdicaoAutoTrader = function prepararEdicaoAutoTraderComFaixas(id) {
            editarOriginal(id);
            const trader = typeof autoTradersGlobais !== 'undefined' && Array.isArray(autoTradersGlobais)
                ? autoTradersGlobais.find(item => Number(item.id) === Number(id))
                : null;
            renderizarFaixas(normalizarFaixas(trader?.config || {}));
        };

        window.salvarAutoTrader = salvarComFaixas;
        window.adicionarFaixaHorarioAutoTrader = adicionarFaixa;
        window.removerFaixaHorarioAutoTrader = removerFaixa;
        instalado = true;
    }

    window.aplicarHorariosAutoTrader = instalarHooks;
})();
