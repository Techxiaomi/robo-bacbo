'use strict';

(() => {
    const state = {
        installed: false,
        inFlight: false,
        originalSync: null
    };

    function findSyncButton() {
        return document.querySelector('button[onclick*="sincronizarSaldoPython"]');
    }

    function setBusy(busy) {
        const button = findSyncButton();
        if (!button) return;
        if (busy) {
            if (!button.dataset.syncOriginalText) {
                button.dataset.syncOriginalText = button.textContent || 'Sincronizar';
            }
            button.disabled = true;
            button.setAttribute('aria-busy', 'true');
            button.style.opacity = '0.65';
            button.style.cursor = 'wait';
            button.textContent = '⏳ Sincronizando...';
            return;
        }
        button.disabled = false;
        button.removeAttribute('aria-busy');
        button.style.opacity = '';
        button.style.cursor = '';
        button.textContent = button.dataset.syncOriginalText || '💱 Sincronizar';
    }

    function install() {
        if (state.installed) return true;
        if (typeof window.sincronizarSaldoPython !== 'function') {
            throw new Error('TRADER_BALANCE_SYNC_GUARD_SYNC_FUNCTION_UNAVAILABLE');
        }

        state.originalSync = window.sincronizarSaldoPython;
        window.sincronizarSaldoPython = async function guardedManualBalanceSync(...args) {
            if (state.inFlight) {
                console.warn('TRADER_BALANCE_SYNC_UI_DUPLICATE_IGNORED=true');
                return false;
            }

            state.inFlight = true;
            setBusy(true);
            try {
                return await state.originalSync.apply(this, args);
            } finally {
                state.inFlight = false;
                setBusy(false);
            }
        };

        state.installed = true;
        return true;
    }

    window.__traderBalanceSyncGuardUi = Object.freeze({ install });
})();
