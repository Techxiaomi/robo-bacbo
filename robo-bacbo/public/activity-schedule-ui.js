(() => {
    'use strict';

    const HORARIO_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
    const FAIXA_PADRAO = Object.freeze({ inicio: '00:00', fim: '23:59' });
    const TIPOS_AMOSTRAGEM = new Set(['NENHUMA', 'PULOS_RANDOMICOS', 'PROBABILIDADE']);
    let configurado = false;

    function horarioValido(valor) {
        return typeof valor === 'string' && HORARIO_RE.test(valor.trim());
    }

    function copiarFaixa(faixa) {
        return { inicio: String(faixa.inicio).trim(), fim: String(faixa.fim).trim() };
    }

    function inteiroSeguro(valor, padrao, minimo = 0, maximo = 1000000) {
        const numero = Number(valor);
        return Number.isInteger(numero) && numero >= minimo && numero <= maximo ? numero : padrao;
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

    function normalizarEstrategiaExecucaoFrontend(config = {}) {
        const cf = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
        const tipoNovo = String(cf.tipo_amostragem || '').trim().toUpperCase();
        const tipo = TIPOS_AMOSTRAGEM.has(tipoNovo)
            ? tipoNovo
            : (String(cf.modo_camuflagem || '').toUpperCase() === 'PULOS' ? 'PULOS_RANDOMICOS' : 'NENHUMA');
        const puloMin = inteiroSeguro(cf.pulo_min, inteiroSeguro(cf.camuflagem_pulos_min, 1, 1, 1000), 1, 1000);
        const puloMax = Math.max(
            puloMin,
            inteiroSeguro(cf.pulo_max, inteiroSeguro(cf.camuflagem_pulos_max, Math.max(3, puloMin), 1, 1000), 1, 1000)
        );
        return {
            gatilho_falhas_monitor: inteiroSeguro(cf.gatilho_falhas_monitor, 0),
            tamanho_lote_processamento: inteiroSeguro(cf.tamanho_lote_processamento, 0),
            tipo_amostragem: tipo,
            chance_execucao_pct: inteiroSeguro(cf.chance_execucao_pct, 100, 1, 100),
            limite_ciclos_sessao: inteiroSeguro(cf.limite_ciclos_sessao, 0),
            pulo_min: puloMin,
            pulo_max: puloMax
        };
    }

    function canonicalizarConfigFrontend(config = {}) {
        const normalizada = { ...(config || {}) };
        normalizada.faixas_horario = normalizarFaixasFrontend(normalizada);
        const execucao = normalizarEstrategiaExecucaoFrontend(normalizada);
        Object.assign(normalizada, execucao);
        delete normalizada.hora_inicio;
        delete normalizada.hora_fim;
        delete normalizada.modo_camuflagem;
        delete normalizada.camuflagem_pulos_min;
        delete normalizada.camuflagem_pulos_max;
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
            <button type="button" class="btn" style="margin-top:10px; background:#17a2b8; height:30px; font-size:11px;" onclick="adicionarFaixaHorarioAutoTrader()">+ Adicionar nova faixa</button>`;
        return true;
    }

    function garantirEstruturaEstrategiaExecucao() {
        const tab = document.getElementById('at-tab-camuflagem');
        if (!tab) return false;
        const botao = document.getElementById('btn-at-tab-camuflagem');
        if (botao) botao.textContent = '⚙️ Estratégia de Execução';
        if (document.getElementById('at-gatilho-falhas-monitor')) return true;

        tab.innerHTML = `
            <select id="at-camuflagem" style="display:none"><option value="TODAS">TODAS</option><option value="PULOS">PULOS</option></select>
            <div id="box-at-pulos" style="display:none"></div>
            <div style="display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px;">
                <div style="background:#1a1a1a; padding:15px; border-radius:8px; border:1px solid #17a2b8;">
                    <h4 style="margin:0 0 8px; color:#17a2b8; font-size:12px; text-transform:uppercase;">1. Gatilho de Início</h4>
                    <p style="font-size:10px; color:#888; margin:0 0 10px;">Quantidade de falhas do sinal original antes de liberar o lote. Zero inicia imediatamente.</p>
                    <div class="form-group"><label>Falhas para ativar:</label><input type="number" id="at-gatilho-falhas-monitor" min="0" value="0"></div>
                </div>
                <div style="background:#1a1a1a; padding:15px; border-radius:8px; border:1px solid #28a745;">
                    <h4 style="margin:0 0 8px; color:#28a745; font-size:12px; text-transform:uppercase;">2. Duração do Lote</h4>
                    <p style="font-size:10px; color:#888; margin:0 0 10px;">Número de sinais realmente executados antes de concluir o ciclo. Zero mantém o processamento sem limite.</p>
                    <div class="form-group"><label>Execuções por lote:</label><input type="number" id="at-tamanho-lote-processamento" min="0" value="0"></div>
                </div>
                <div style="background:#1a1a1a; padding:15px; border-radius:8px; border:1px solid #ffc107;">
                    <h4 style="margin:0 0 8px; color:#ffc107; font-size:12px; text-transform:uppercase;">3. Filtro de Amostragem</h4>
                    <div class="form-group" style="margin-bottom:10px;"><label>Tipo:</label><select id="at-tipo-amostragem" onchange="toggleAmostragemAutoTrader()"><option value="NENHUMA">Nenhuma — executar todos</option><option value="PULOS_RANDOMICOS">Pulos Randômicos</option><option value="PROBABILIDADE">Probabilidade (%)</option></select></div>
                    <div id="at-amostragem-pulos" style="display:none; padding:10px; background:#111; border-radius:6px;">
                        <div style="display:flex; gap:10px;"><div class="form-group" style="flex:1; margin:0;"><label>Pulo mínimo:</label><input type="number" id="at-pulo-min" min="1" value="1"></div><div class="form-group" style="flex:1; margin:0;"><label>Pulo máximo:</label><input type="number" id="at-pulo-max" min="1" value="3"></div></div>
                    </div>
                    <div id="at-amostragem-probabilidade" style="display:none; padding:10px; background:#111; border-radius:6px;">
                        <div class="form-group" style="margin:0;"><label>Chance de execução (%):</label><input type="number" id="at-chance-execucao-pct" min="1" max="100" value="100"></div>
                    </div>
                </div>
                <div style="background:#1a1a1a; padding:15px; border-radius:8px; border:1px solid #ff7777;">
                    <h4 style="margin:0 0 8px; color:#ff7777; font-size:12px; text-transform:uppercase;">4. Limite de Ciclos</h4>
                    <p style="font-size:10px; color:#888; margin:0 0 10px;">Após esta quantidade de lotes completos o motor se auto-desativa. Zero significa infinito.</p>
                    <div class="form-group"><label>Ciclos por sessão:</label><input type="number" id="at-limite-ciclos-sessao" min="0" value="0"></div>
                </div>
            </div>
            <div style="margin-top:12px; background:#1a1a1a; padding:15px; border-radius:8px; border:1px solid #333;">
                <h4 style="margin:0 0 10px; font-size:12px; color:#aaa; text-transform:uppercase;">Limitação de Volume Diário</h4>
                <div class="form-group"><label>Pausar motor automaticamente após X execuções concluídas:</label><input type="number" id="at-max-entradas" value="15" min="1"></div>
            </div>`;
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
        linha.innerHTML = `<div class="form-group" style="margin:0;"><label>Início:</label><input type="time" class="at-faixa-inicio" value="${horarioValido(inicio) ? String(inicio).trim() : FAIXA_PADRAO.inicio}"></div><div class="form-group" style="margin:0;"><label>Fim:</label><input type="time" class="at-faixa-fim" value="${horarioValido(fim) ? String(fim).trim() : FAIXA_PADRAO.fim}"></div><button type="button" class="btn at-remover-faixa" style="background:#ff7777; height:34px; padding:0 12px; font-size:11px;" onclick="removerFaixaHorarioAutoTrader(this)">Remover faixa</button>`;
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
        if (linhas.length === 0) throw new Error('Adicione ao menos uma faixa de horário.');
        return linhas.map((linha, indice) => {
            const inicio = String(linha.querySelector('.at-faixa-inicio')?.value || '').trim();
            const fim = String(linha.querySelector('.at-faixa-fim')?.value || '').trim();
            if (!horarioValido(inicio) || !horarioValido(fim)) throw new Error(`Faixa ${indice + 1}: informe início e fim válidos.`);
            return { inicio, fim };
        });
    }

    function toggleAmostragemAutoTrader() {
        const tipo = document.getElementById('at-tipo-amostragem')?.value || 'NENHUMA';
        const pulos = document.getElementById('at-amostragem-pulos');
        const prob = document.getElementById('at-amostragem-probabilidade');
        if (pulos) pulos.style.display = tipo === 'PULOS_RANDOMICOS' ? 'block' : 'none';
        if (prob) prob.style.display = tipo === 'PROBABILIDADE' ? 'block' : 'none';
    }

    function renderizarEstrategiaExecucaoAutoTrader(config = {}) {
        if (!garantirEstruturaEstrategiaExecucao()) return;
        const cf = normalizarEstrategiaExecucaoFrontend(config);
        document.getElementById('at-gatilho-falhas-monitor').value = cf.gatilho_falhas_monitor;
        document.getElementById('at-tamanho-lote-processamento').value = cf.tamanho_lote_processamento;
        document.getElementById('at-tipo-amostragem').value = cf.tipo_amostragem;
        document.getElementById('at-pulo-min').value = cf.pulo_min;
        document.getElementById('at-pulo-max').value = cf.pulo_max;
        document.getElementById('at-chance-execucao-pct').value = cf.chance_execucao_pct;
        document.getElementById('at-limite-ciclos-sessao').value = cf.limite_ciclos_sessao;
        toggleAmostragemAutoTrader();
    }

    function coletarEstrategiaExecucaoAutoTrader() {
        const gatilho = Number(document.getElementById('at-gatilho-falhas-monitor')?.value);
        const lote = Number(document.getElementById('at-tamanho-lote-processamento')?.value);
        const limite = Number(document.getElementById('at-limite-ciclos-sessao')?.value);
        const tipo = document.getElementById('at-tipo-amostragem')?.value || 'NENHUMA';
        const puloMin = Number(document.getElementById('at-pulo-min')?.value);
        const puloMax = Number(document.getElementById('at-pulo-max')?.value);
        const chance = Number(document.getElementById('at-chance-execucao-pct')?.value);
        if (!Number.isInteger(gatilho) || gatilho < 0) throw new Error('Gatilho de falhas deve ser inteiro maior ou igual a zero.');
        if (!Number.isInteger(lote) || lote < 0) throw new Error('Tamanho do lote deve ser inteiro maior ou igual a zero.');
        if (!Number.isInteger(limite) || limite < 0) throw new Error('Limite de ciclos deve ser inteiro maior ou igual a zero.');
        if (!TIPOS_AMOSTRAGEM.has(tipo)) throw new Error('Selecione um tipo de amostragem válido.');
        if (tipo === 'PULOS_RANDOMICOS' && (!Number.isInteger(puloMin) || puloMin < 1 || !Number.isInteger(puloMax) || puloMax < puloMin)) throw new Error('Revise os valores mínimo e máximo dos pulos randômicos.');
        if (tipo === 'PROBABILIDADE' && (!Number.isInteger(chance) || chance < 1 || chance > 100)) throw new Error('A chance de execução deve ser um inteiro de 1 a 100.');
        return {
            gatilho_falhas_monitor: gatilho,
            tamanho_lote_processamento: lote,
            tipo_amostragem: tipo,
            chance_execucao_pct: tipo === 'PROBABILIDADE' ? chance : 100,
            limite_ciclos_sessao: limite,
            pulo_min: Number.isInteger(puloMin) && puloMin >= 1 ? puloMin : 1,
            pulo_max: Number.isInteger(puloMax) && puloMax >= Math.max(1, puloMin || 1) ? puloMax : Math.max(3, puloMin || 1)
        };
    }

    function envolverAberturaEdicao() {
        if (window.__activityScheduleFormsWrapped) return;
        window.__activityScheduleFormsWrapped = true;
        const abrirOriginal = window.abrirFormularioAutoTrader;
        const editarOriginal = window.prepararEdicaoAutoTrader;
        if (typeof abrirOriginal === 'function') {
            window.abrirFormularioAutoTrader = function(...args) {
                const retorno = abrirOriginal.apply(this, args);
                renderizarFaixasHorarioAutoTrader([FAIXA_PADRAO]);
                renderizarEstrategiaExecucaoAutoTrader({});
                return retorno;
            };
        }
        if (typeof editarOriginal === 'function') {
            window.prepararEdicaoAutoTrader = function(id, ...args) {
                const retorno = editarOriginal.call(this, id, ...args);
                const trader = typeof autoTradersGlobais !== 'undefined' && Array.isArray(autoTradersGlobais)
                    ? autoTradersGlobais.find(item => Number(item.id) === Number(id))
                    : null;
                renderizarFaixasHorarioAutoTrader(normalizarFaixasFrontend(trader?.config || {}));
                renderizarEstrategiaExecucaoAutoTrader(trader?.config || {});
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
        if (ativoAT && ((tieModo === 'PERCENTUAL' && tiePercent <= 0) || (tieModo === 'VALOR' && tieValor <= 0))) return alert('Defina a política financeira da proteção no empate antes de ativar o Auto-Trader.');

        let faixasHorario;
        let estrategiaExecucao;
        try {
            faixasHorario = coletarFaixasHorarioAutoTrader();
            estrategiaExecucao = coletarEstrategiaExecucaoAutoTrader();
        } catch (erro) {
            return alert(erro.message || 'Revise a configuração do Auto-Trader.');
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
                ...estrategiaExecucao,
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
            const res = await fetch(autoTraderEditandoId ? `/api/auto-trader/${autoTraderEditandoId}` : '/api/auto-trader', {
                method: autoTraderEditandoId ? 'PUT' : 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)
            });
            let resposta = {};
            try { resposta = await res.json(); } catch (e) {}
            if (!res.ok) return alert(resposta.mensagem || 'Erro ao salvar o Auto-Trader.');
            fecharFormularioAutoTrader();
            await carregarAutoTraders();
        } catch(e) {
            alert('Erro de conexão.');
        }
    }

    function envolverToggleRapido() {
        window.toggleAutoTraderRapido = async function(id, check) {
            const at = typeof autoTradersGlobais !== 'undefined' && Array.isArray(autoTradersGlobais)
                ? autoTradersGlobais.find(x => Number(x.id) === Number(id))
                : null;
            if (!at) return;
            const novoAtivo = !!check.checked;
            const payload = { ...at, ativo: novoAtivo, config: canonicalizarConfigFrontend(at.config || {}) };
            try {
                const res = await fetch(`/api/auto-trader/${id}`, { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload) });
                let resposta = {};
                try { resposta = await res.json(); } catch (e) {}
                if (!res.ok) throw new Error(resposta.mensagem || 'Falha ao atualizar o Auto-Trader.');
                await carregarAutoTraders();
            } catch(e) {
                check.checked = !novoAtivo;
                alert(e.message || 'Erro ao atualizar o Auto-Trader.');
            }
        };
    }

    function configurarFaixasHorarioAutoTrader() {
        if (configurado) return;
        if (!garantirEstruturaHorario() || !garantirEstruturaEstrategiaExecucao()) return;
        configurado = true;
        envolverAberturaEdicao();
        envolverToggleRapido();
        window.salvarAutoTrader = salvarAutoTraderComFaixas;
        renderizarFaixasHorarioAutoTrader([FAIXA_PADRAO]);
        renderizarEstrategiaExecucaoAutoTrader({});
    }

    window.adicionarFaixaHorarioAutoTrader = adicionarFaixaHorarioAutoTrader;
    window.removerFaixaHorarioAutoTrader = removerFaixaHorarioAutoTrader;
    window.renderizarFaixasHorarioAutoTrader = renderizarFaixasHorarioAutoTrader;
    window.coletarFaixasHorarioAutoTrader = coletarFaixasHorarioAutoTrader;
    window.toggleAmostragemAutoTrader = toggleAmostragemAutoTrader;
    window.renderizarEstrategiaExecucaoAutoTrader = renderizarEstrategiaExecucaoAutoTrader;
    window.coletarEstrategiaExecucaoAutoTrader = coletarEstrategiaExecucaoAutoTrader;
    window.configurarFaixasHorarioAutoTrader = configurarFaixasHorarioAutoTrader;
    window.__activityScheduleUiReady = true;
})();
