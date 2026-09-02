'use strict';

const SAFE_TECHNICAL_RISK_CAPS = Object.freeze({
    global_router_cap: 20.00,
    per_bridge_cap: 5.00
});

function envMoney(name, fallback, max) {
    const value = Number(process.env[name]);
    if (!Number.isFinite(value) || value <= 0 || value > max) return fallback;
    return Math.round(value * 100) / 100;
}

function getTechnicalRiskCaps() {
    return Object.freeze({
        global_router_cap: envMoney(
            'SYSTEM_CONFIG_GLOBAL_ROUTER_CAP',
            SAFE_TECHNICAL_RISK_CAPS.global_router_cap,
            SAFE_TECHNICAL_RISK_CAPS.global_router_cap
        ),
        per_bridge_cap: envMoney(
            'SYSTEM_CONFIG_PER_BRIDGE_CAP',
            SAFE_TECHNICAL_RISK_CAPS.per_bridge_cap,
            SAFE_TECHNICAL_RISK_CAPS.per_bridge_cap
        )
    });
}

module.exports = {
    SAFE_TECHNICAL_RISK_CAPS,
    TECHNICAL_RISK_CAPS: SAFE_TECHNICAL_RISK_CAPS,
    getTechnicalRiskCaps
};
