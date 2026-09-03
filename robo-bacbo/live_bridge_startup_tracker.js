'use strict';

const PYTHON_STARTUP_MARKERS = Object.freeze([
    ['CONTROLLED_BOOT', /^=== LIVE BRIDGE CONTROLLED ===$/],
    ['HOME_STAGE', /^BRASIL_DA_SORTE_STAGE=HOME$/],
    ['HOME_NAVIGATED', /^BRASIL_DA_SORTE_HOME_NAVIGATED=true$/],
    ['LOGIN_TRIGGERED', /^BRASIL_DA_SORTE_LOGIN_TRIGGERED=true$/],
    ['LOGIN_FORM_OPENED', /^BRASIL_DA_SORTE_LOGIN_FORM_OPENED=true$/],
    ['LOGIN_FORM_READY', /^BRASIL_DA_SORTE_LOGIN_FORM_READY=true$/],
    ['LOGIN_SUBMITTED', /^BRASIL_DA_SORTE_LOGIN_SUBMITTED=true$/],
    ['LOGIN_CONFIRMED', /^BRASIL_DA_SORTE_LOGIN_CONFIRMED=true$/],
    ['SESSION_REUSED', /^BRASIL_DA_SORTE_SESSION_REUSED=true$/],
    ['GAME_URL_STAGE', /^BRASIL_DA_SORTE_STAGE=GAME_URL$/],
    ['GAME_NAVIGATED', /^BRASIL_DA_SORTE_GAME_NAVIGATED_URL=/],
    ['PLAY_EVIDENCE', /^BRASIL_DA_SORTE_PLAY_EVIDENCE=/],
    ['PLAY_CLICK', /^BRASIL_DA_SORTE_PLAY_CLICK_METHOD=/],
    ['PLAY_TRIGGERED', /^BRASIL_DA_SORTE_PLAY_TRIGGERED=true$/],
    ['CONTEXT_ISOLATED', /^LIVE_BRIDGE_CONTEXT_ISOLATED=/],
    ['ADAPTER_PAGE_READY', /^LIVE_BRIDGE_ADAPTER_PAGE_READY=true$/],
    ['BRIDGE_READY', /^LIVE_BRIDGE_READY=true$/],
]);

function startupStageForLine(line) {
    const text = String(line || '').trim();
    for (const [stage, pattern] of PYTHON_STARTUP_MARKERS) {
        if (pattern.test(text)) return stage;
    }
    return null;
}

function createStartupTracker({ now = () => Date.now(), log = console.log } = {}) {
    const startedAt = now();
    let previousAt = startedAt;
    const seen = new Set();

    const emit = stage => {
        if (!stage || seen.has(stage)) return false;
        const current = now();
        seen.add(stage);
        log(
            `LIVE_BRIDGE_STARTUP_STAGE=${stage} ` +
            `delta_ms=${Math.max(0, current - previousAt)} ` +
            `elapsed_ms=${Math.max(0, current - startedAt)}`
        );
        previousAt = current;
        return true;
    };

    emit('PYTHON_SPAWN');

    return Object.freeze({
        observe(line) {
            return emit(startupStageForLine(line));
        },
        emit,
    });
}

module.exports = Object.freeze({
    PYTHON_STARTUP_MARKERS,
    startupStageForLine,
    createStartupTracker,
});
