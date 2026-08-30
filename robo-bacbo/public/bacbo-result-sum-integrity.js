(() => {
    'use strict';

    const SNAPSHOT_URL = '/bacbo-map-snapshot.json';
    const REFRESH_MS = 2000;

    let canonicos = [];
    let refreshTimer = null;
    let refreshInFlight = false;
    let observer = null;

    function winner(valor) {
        const bruto = String(valor || '').trim().toUpperCase();
        if (bruto === 'PLAYER' || bruto === 'PLAYERWON' || bruto === 'P') return 'Player';
        if (bruto === 'BANKER' || bruto === 'BANKERWON' || bruto === 'B') return 'Banker';
        if (bruto === 'TIE' || bruto === 'TIEWON' || bruto === 'T') return 'Tie';
        return '';
    }

    function somaValida(valor) {
        if (
            valor === null
            || valor === undefined
            || valor === ''
            || typeof valor === 'boolean'
        ) {
            return null;
        }

        const n = Number(valor);
        return Number.isInteger(n) && n >= 2 && n <= 12
            ? n
            : null;
    }

    function normalizarCanonico(item) {
        if (!item || typeof item !== 'object') return null;

        const resultado = winner(
            item.winner || item.type || item.resultado
        );

        const soma = somaValida(
            item.result ?? item.resultado_soma ?? item.soma
        );

        const instant = item.instant || item.data_hora || null;
        const ms = Date.parse(String(instant || ''));

        if (
            !resultado
            || soma === null
            || !Number.isFinite(ms)
        ) {
            return null;
        }

        return {
            resultado,
            soma,
            instant: new Date(ms).toISOString(),
            uuid: String(item.uuid || item.round_uuid || '').trim()
        };
    }

    function winnerDaCelula(cell) {
        if (cell.classList.contains('player')) return 'Player';
        if (cell.classList.contains('banker')) return 'Banker';
        if (cell.classList.contains('tie')) return 'Tie';
        return '';
    }

    function modoNumericoAtivo(root) {
        return root
            ?.querySelector('.bacbo-map-mode[data-mode="numbers"]')
            ?.classList.contains('active') === true;
    }

    function corrigirTooltip(cell) {
        const soma = somaValida(cell?.dataset?.mc27ResultadoSoma);
        const tooltip = document.getElementById('bacbo-map-tooltip');

        if (!tooltip || tooltip.style.display !== 'block') return;

        const partes = String(tooltip.textContent || '').split(' - ');
        if (partes.length < 3) return;

        partes[1] = soma === null ? 'N/D' : String(soma);
        tooltip.textContent = partes.join(' - ');
    }

    function vincularTooltip(cell) {
        if (!cell || cell.dataset.mc27TooltipBound === '1') return;

        cell.dataset.mc27TooltipBound = '1';

        const corrigirDepois = () => {
            queueMicrotask(() => corrigirTooltip(cell));
        };

        cell.addEventListener('mouseenter', corrigirDepois);
        cell.addEventListener('focus', corrigirDepois);
        cell.addEventListener('click', corrigirDepois);
    }

    function failClosedZeros(cells, numerico) {
        for (const cell of cells) {
            vincularTooltip(cell);

            if (
                numerico
                && String(cell.textContent || '').trim() === '0'
            ) {
                cell.textContent = '—';
            }
        }
    }

    function aplicarSnapshotCanonico() {
        const root = document.getElementById('bk-fita-historico');
        const grid = root?.querySelector('.bacbo-map-grid');
        if (!root || !grid) return false;

        const cells = [...grid.querySelectorAll('.bacbo-map-cell')];
        if (cells.length === 0) return false;

        const numerico = modoNumericoAtivo(root);
        failClosedZeros(cells, numerico);

        if (canonicos.length < cells.length) return false;

        const fatia = canonicos.slice(-cells.length);

        const sequenciaExata = cells.every(
            (cell, indice) =>
                winnerDaCelula(cell) === fatia[indice].resultado
        );

        if (!sequenciaExata) {
            return false;
        }

        cells.forEach((cell, indice) => {
            const can = fatia[indice];
            cell.dataset.mc27ResultadoSoma = String(can.soma);
            if (can.uuid) cell.dataset.mc27RoundUuid = can.uuid;
            vincularTooltip(cell);

            if (numerico) {
                cell.textContent = String(can.soma);
            }
        });

        return true;
    }

    async function carregarSnapshot() {
        if (refreshInFlight) return false;
        refreshInFlight = true;

        try {
            const resposta = await fetch(
                `${SNAPSHOT_URL}?_mc27=${Date.now()}`,
                {
                    cache: 'no-store',
                    credentials: 'same-origin'
                }
            );

            if (!resposta.ok) return false;

            const corpo = await resposta.json();
            const lista = Array.isArray(corpo)
                ? corpo
                : (Array.isArray(corpo?.rows) ? corpo.rows : []);

            const normalizados = lista
                .map(normalizarCanonico)
                .filter(Boolean);

            if (normalizados.length > 0) {
                canonicos = normalizados;
                aplicarSnapshotCanonico();
                return true;
            }

            return false;
        } catch (_) {
            return false;
        } finally {
            refreshInFlight = false;
        }
    }

    function agendarRefresh() {
        clearTimeout(refreshTimer);

        refreshTimer = setTimeout(async () => {
            await carregarSnapshot();
            agendarRefresh();
        }, REFRESH_MS);
    }

    function observarMapa() {
        if (observer || typeof MutationObserver !== 'function') return;

        observer = new MutationObserver(() => {
            queueMicrotask(aplicarSnapshotCanonico);
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true
        });
    }

    document.addEventListener('click', event => {
        if (event.target?.closest?.('.bacbo-map-mode')) {
            queueMicrotask(aplicarSnapshotCanonico);
        }
    });

    window.addEventListener('DOMContentLoaded', () => {
        observarMapa();
        void carregarSnapshot().finally(agendarRefresh);
    });

    window.__mc27ResultSumIntegrity = {
        somaValida,
        aplicarSnapshotCanonico,
        carregarSnapshot
    };

    window.__mc27ResultSumIntegrityReady = true;
})();
