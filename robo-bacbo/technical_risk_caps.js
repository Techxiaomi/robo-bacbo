'use strict';

const TECHNICAL_RISK_CAPS = Object.freeze({
    global_router_cap: 20.00,
    per_bridge_cap: 5.00
});

function getTechnicalRiskCaps() {
    return TECHNICAL_RISK_CAPS;
}

module.exports = {
    TECHNICAL_RISK_CAPS,
    getTechnicalRiskCaps
};
