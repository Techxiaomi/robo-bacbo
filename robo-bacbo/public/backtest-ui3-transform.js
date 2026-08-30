(() => {
    'use strict';

    const TRECHO_RELOAD_REALTIME = " if (document.getElementById('aba-backtest').classList.contains('visivel')) carregarHistoricoMemoria(false);";
    const TRECHO_LIMIT_ANTIGO = "let limit = document.getElementById('bk-range') ? document.getElementById('bk-range').value : 10000;";
    const TRECHO_LIMIT_NOVO = "const selecionado = Number.parseInt(document.getElementById('bk-range')?.value || '10000', 10); const limit = [100, 500, 1000, 3000, 10000].includes(selecionado) ? selecionado : 10000;";
    const FETCH_ANTIGO = "fetch(`/api/historico-giros?limit=10000&_t=${Date.now()}`)";
    const FETCH_NOVO = "fetch(`/api/historico-giros?limit=${limit}&_t=${Date.now()}`)";
    const FITA_ANTIGA = "function renderizarFitaTemporal(dados, indicesHighlight) { const fita = document.getElementById('bk-fita-historico'); fita.innerHTML = ''; let exibir = dados.slice(-200); let offset = dados.length - 200; exibir.forEach((d, idx) => { let div = document.createElement('div'); div.className = `bk-bola ${d.resultado.toLowerCase()}`; let val = ''; if (d.resultado === 'Tie') val = 'T'; else if (d.resultado === 'Player') val = 'P'; else val = 'B'; div.innerText = val; let realIndex = offset + idx; let highlight = indicesHighlight.find(h => h.index === realIndex); if (highlight) { if (highlight.status === 'win') { div.classList.add('found'); } else if (highlight.status === 'loss') { div.classList.add('loss'); } } fita.appendChild(div); }); fita.scrollLeft = fita.scrollWidth; }";
    const MAPA_NOVO = "function renderizarFitaTemporal(dados, indicesHighlight) { if (!window.__bacboResultMap?.render) throw new Error('Mapa Bac Bo não carregado'); return window.__bacboResultMap.render(dados, indicesHighlight); }";

    const BIND_RANGE = `

        window.addEventListener('DOMContentLoaded', () => {
            const range = document.getElementById('bk-range');
            if (!range || range.dataset.ui3BacktestBound === '1') return;
            range.dataset.ui3BacktestBound = '1';
            range.addEventListener('change', () => {
                if (document.getElementById('aba-backtest')?.classList.contains('visivel')) {
                    void carregarHistoricoMemoria(true);
                }
            });
        });`;

    function substituirUmaVez(codigo, antigo, novo, descricao) {
        const primeira = codigo.indexOf(antigo);
        if (primeira < 0) {
            throw new Error(`UI-3 não encontrou ${descricao}.`);
        }
        if (codigo.indexOf(antigo, primeira + antigo.length) >= 0) {
            throw new Error(`UI-3 encontrou ${descricao} mais de uma vez.`);
        }
        return codigo.slice(0, primeira) + novo + codigo.slice(primeira + antigo.length);
    }

    function otimizarScriptPrincipalUI3(codigoOriginal) {
        if (typeof codigoOriginal !== 'string' || codigoOriginal.trim() === '') {
            throw new Error('UI-3 recebeu JavaScript principal vazio.');
        }
        if (!window.__bacboResultMap?.render) {
            throw new Error('UI-3 requer o componente Mapa Bac Bo carregado.');
        }

        // O mapa recebe deltas diretamente por Socket.IO. O evento geral da interface
        // não dispara mais polling do histórico a cada rodada.
        let codigo = substituirUmaVez(
            codigoOriginal,
            TRECHO_RELOAD_REALTIME,
            '',
            'o reload realtime do Backtest'
        );
        codigo = substituirUmaVez(
            codigo,
            TRECHO_LIMIT_ANTIGO,
            TRECHO_LIMIT_NOVO,
            'a leitura do #bk-range'
        );
        codigo = substituirUmaVez(
            codigo,
            FETCH_ANTIGO,
            FETCH_NOVO,
            'o fetch com limit=10000 fixo'
        );
        codigo = substituirUmaVez(
            codigo,
            FITA_ANTIGA,
            MAPA_NOVO,
            'a fita temporal antiga'
        );

        if (codigo.includes('historico-giros?limit=10000')) {
            throw new Error('UI-3 detectou limit=10000 fixo remanescente no Backtest.');
        }
        if (codigo.includes('carregarHistoricoMemoria(false)')) {
            throw new Error('UI-3 detectou reload pesado remanescente do Backtest.');
        }
        if (codigo.includes('bk-bola ${d.resultado.toLowerCase()}')) {
            throw new Error('UI-3 detectou a fita temporal antiga remanescente.');
        }

        return codigo + BIND_RANGE;
    }

    window.otimizarScriptPrincipalUI3 = otimizarScriptPrincipalUI3;
    window.__backtestUi3Ready = true;
})();
