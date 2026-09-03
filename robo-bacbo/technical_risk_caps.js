'use strict';

const DEFAULT_TECHNICAL_RISK_CAPS = Object.freeze({
    global_router_cap: 20.00,
    per_bridge_cap: 5.00
});

const MAX_CONFIGURABLE_TECHNICAL_CAP = 99999.00;

// Quando a barreira técnica está desabilitada, ainda entregamos valores
// monetários válidos aos consumidores legados, mas em uma faixa que não
// interfere na operação normal. `enabled=false` é a SSOT do bypass.
const DISABLED_TECHNICAL_RISK_CAPS = Object.freeze({
    global_router_cap: 999999.99,
    per_bridge_cap: 999999.99
});

function envMoney(name, fallback, max = MAX_CONFIGURABLE_TECHNICAL_CAP) {
    const value = Number(process.env[name]);
    if (!Number.isFinite(value) || value <= 0 || value > max) return fallback;
    return Math.round(value * 100) / 100;
}

function envBoolean(name, fallback = false) {
    const raw = process.env[name];
    if (raw == null || String(raw).trim() === '') return fallback;
    const normalized = String(raw).trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    return fallback;
}

function getTechnicalRiskCaps() {
    const configuredGlobal = envMoney(
        'SYSTEM_CONFIG_GLOBAL_ROUTER_CAP',
        DEFAULT_TECHNICAL_RISK_CAPS.global_router_cap
    );
    const configuredBridge = envMoney(
        'SYSTEM_CONFIG_PER_BRIDGE_CAP',
        DEFAULT_TECHNICAL_RISK_CAPS.per_bridge_cap
    );
    const enabled = envBoolean('SYSTEM_CONFIG_TECHNICAL_RISK_CAPS_ENABLED', false);

    return Object.freeze({
        enabled,
        configured_global_router_cap: configuredGlobal,
        configured_per_bridge_cap: configuredBridge,
        global_router_cap: enabled
            ? configuredGlobal
            : DISABLED_TECHNICAL_RISK_CAPS.global_router_cap,
        per_bridge_cap: enabled
            ? configuredBridge
            : DISABLED_TECHNICAL_RISK_CAPS.per_bridge_cap
    });
}

module.exports = {
    SAFE_TECHNICAL_RISK_CAPS: DEFAULT_TECHNICAL_RISK_CAPS,
    DEFAULT_TECHNICAL_RISK_CAPS,
    DISABLED_TECHNICAL_RISK_CAPS,
    MAX_CONFIGURABLE_TECHNICAL_CAP,
    TECHNICAL_RISK_CAPS: DEFAULT_TECHNICAL_RISK_CAPS,
    getTechnicalRiskCaps
};
