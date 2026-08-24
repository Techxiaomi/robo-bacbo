(function () {
    'use strict';

    if (window.__telegramFormUiV2Ready) return;
    window.__telegramFormUiV2Ready = true;

    const IDS = {
        nomeRobo: 'robo-tg-nome-robo',
        nomeEstrategia: 'robo-tg-nome-estrategia',
        padrao: 'robo-tg-padrao',
        assertGeral: 'robo-tg-assert-geral',
        assert24h: 'robo-tg-assert-24h',
        detalharEmpates: 'robo-tg-detalhar-empates'
    };

    const LEGADOS = [
        'robo-mostrar-nome',
        'robo-mostrar-padrao',
        'robo-mostrar-assertividade',
        'robo-detalhar-empates'
    ];

    let funcoesEnvolvidas = false;
    let aplicandoEdicao = 0;

    function boolConfig(config, chaveNova, chaveLegada, padrao) {
        const cf = config && typeof config === 'object' ? config : {};
        if (Object.prototype.hasOwnProperty.call(cf, chaveNova)) return cf[chaveNova] !== false;
        if (chaveLegada && Object.prototype.hasOwnProperty.call(cf, chaveLegada)) return cf[chaveLegada] !== false;
        return !!padrao;
    }

    function marcar(id, valor) {
        const el = document.getElementById(id);
        if (el) el.checked = !!valor;
    }

    function marcado(id, padrao) {
        const el = document.getElementById(id);
        return el ? !!el.checked : !!padrao;
    }

    function forcarContextoInterno() {
        LEGADOS.forEach(id => marcar(id, true));
    }

    function preferenciasPadrao() {
        marcar(IDS.nomeRobo, true);
        marcar(IDS.nomeEstrategia, true);
        marcar(IDS.padrao, true);
        marcar(IDS.assertGeral, true);
        marcar(IDS.assert24h, false);
        marcar(IDS.detalharEmpates, true);
        forcarContextoInterno();
    }

    function carregarPreferencias(config) {
        const cf = config && typeof config === 'object' ? config : {};
        marcar(IDS.nomeRobo, boolConfig(cf, 'telegram_nome_robo', null, true));
        marcar(IDS.nomeEstrategia, boolConfig(cf, 'telegram_nome_estrategia', 'mostrar_nome', true));
        marcar(IDS.padrao, boolConfig(cf, 'telegram_padrao', 'mostrar_padrao', true));
        marcar(IDS.assertGeral, boolConfig(cf, 'telegram_assertividade_geral', 'mostrar_assertividade', true));
        marcar(IDS.assert24h, boolConfig(cf, 'telegram_assertividade_24h', null, false));
        marcar(IDS.detalharEmpates, boolConfig(cf, 'telegram_detalhar_empates', 'detalhar_empates', true));
        forcarContextoInterno();
    }

    function montarOpcao(id, texto, checked) {
        const label = document.createElement('label');
        label.style.cssText = 'cursor:pointer;display:flex;align-items:center;gap:7px;min-width:210px;';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.id = id;
        input.checked = checked;
        input.style.cssText = 'width:14px;height:14px;';
        label.appendChild(input);
        label.appendChild(document.createTextNode(texto));
        return label;
    }

    function instalarFormularioVisual() {
        if (document.getElementById(IDS.nomeRobo)) return true;

        const legado = document.getElementById('robo-mostrar-nome');
        if (!legado) return false;

        let bloco = legado.closest('div[style*="background"]');
        if (!bloco) bloco = legado.parentElement?.parentElement?.parentElement || null;
        if (!bloco) return false;

        const titulo = bloco.querySelector('h4');
        if (titulo) titulo.textContent = '📨 Informações exibidas nos sinais Telegram';

        const container = legado.parentElement?.parentElement;
        if (!container) return false;

        LEGADOS.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.checked = true;
                const label = el.closest('label');
                if (label) label.style.display = 'none';
            }
        });

        const grid = document.createElement('div');
        grid.id = 'telegram-opcoes-exibicao-v2';
        grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(235px,1fr));gap:10px 16px;font-size:13px;width:100%;';
        grid.appendChild(montarOpcao(IDS.nomeRobo, 'Nome do Robô', true));
        grid.appendChild(montarOpcao(IDS.nomeEstrategia, 'Nome da Estratégia', true));
        grid.appendChild(montarOpcao(IDS.padrao, 'Padrão (Sequência de cores)', true));
        grid.appendChild(montarOpcao(IDS.assertGeral, 'Assertividade (Geral)', true));
        grid.appendChild(montarOpcao(IDS.assert24h, 'Assertividade (24h)', false));
        grid.appendChild(montarOpcao(IDS.detalharEmpates, 'Detalhar Empates', true));
        container.appendChild(grid);

        forcarContextoInterno();
        return true;
    }

    async function obterRoboAtual(id) {
        try {
            if (Array.isArray(window.robosGlobais)) {
                const local = window.robosGlobais.find(r => Number(r.id) === Number(id));
                if (local) return local;
            }
        } catch (_) {}

        try {
            const resposta = await fetch('/api/robos', { cache: 'no-store', credentials: 'same-origin' });
            if (!resposta.ok) return null;
            const corpo = await resposta.json();
            const lista = Array.isArray(corpo) ? corpo : (Array.isArray(corpo?.robos) ? corpo.robos : []);
            return lista.find(r => Number(r.id) === Number(id)) || null;
        } catch (_) {
            return null;
        }
    }

    function envolverFuncoes() {
        if (funcoesEnvolvidas) return true;
        if (typeof window.abrirFormularioRobo !== 'function'
            || typeof window.prepararEdicaoRobo !== 'function'
            || typeof window.construirPayloadRobo !== 'function') {
            return false;
        }

        const abrirOriginal = window.abrirFormularioRobo;
        const editarOriginal = window.prepararEdicaoRobo;
        const payloadOriginal = window.construirPayloadRobo;

        window.abrirFormularioRobo = function (...args) {
            const retorno = abrirOriginal.apply(this, args);
            instalarFormularioVisual();
            preferenciasPadrao();
            return retorno;
        };

        window.prepararEdicaoRobo = function (id, ...args) {
            const retorno = editarOriginal.call(this, id, ...args);
            instalarFormularioVisual();
            const marcador = ++aplicandoEdicao;
            void obterRoboAtual(id).then(robo => {
                if (marcador !== aplicandoEdicao) return;
                carregarPreferencias(robo?.config || {});
            });
            return retorno;
        };

        window.construirPayloadRobo = function (...args) {
            instalarFormularioVisual();
            forcarContextoInterno();
            const payload = payloadOriginal.apply(this, args);
            if (!payload || typeof payload !== 'object') return payload;

            const config = payload.config && typeof payload.config === 'object'
                ? { ...payload.config }
                : {};

            payload.config = {
                ...config,
                telegram_nome_robo: marcado(IDS.nomeRobo, true),
                telegram_nome_estrategia: marcado(IDS.nomeEstrategia, true),
                telegram_padrao: marcado(IDS.padrao, true),
                telegram_assertividade_geral: marcado(IDS.assertGeral, true),
                telegram_assertividade_24h: marcado(IDS.assert24h, false),
                telegram_detalhar_empates: marcado(IDS.detalharEmpates, true),

                // Mantém contexto completo para o lifecycle interno; apenas o presenter oculta visualmente.
                mostrar_nome: true,
                mostrar_padrao: true,
                mostrar_assertividade: true,
                detalhar_empates: true
            };
            return payload;
        };

        funcoesEnvolvidas = true;
        return true;
    }

    function tentarInstalar() {
        const visual = instalarFormularioVisual();
        const funcoes = envolverFuncoes();
        if (visual) forcarContextoInterno();
        return visual && funcoes;
    }

    if (!tentarInstalar()) {
        const observer = new MutationObserver(() => {
            if (tentarInstalar()) observer.disconnect();
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });

        let tentativas = 0;
        const timer = setInterval(() => {
            tentativas++;
            if (tentarInstalar() || tentativas >= 120) clearInterval(timer);
        }, 250);
    }
})();
