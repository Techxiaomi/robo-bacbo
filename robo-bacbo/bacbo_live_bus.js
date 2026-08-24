'use strict';

const EVENTO_LIVE = 'bacbo_round_live';
const MAX_UUIDS = 5000;

let ioServer = null;
let logAtivoEmitido = false;
const uuidsEmitidos = new Map();

function winner(valor) {
    const bruto = String(valor || '').trim().toUpperCase();
    if (bruto === 'PLAYER' || bruto === 'PLAYERWON' || bruto === 'P') return 'Player';
    if (bruto === 'BANKER' || bruto === 'BANKERWON' || bruto === 'B') return 'Banker';
    if (bruto === 'TIE' || bruto === 'TIEWON' || bruto === 'T') return 'Tie';
    return '';
}

function normalizarRound(round) {
    if (!round || typeof round !== 'object') return null;
    const uuid = String(round.uuid || round.round_uuid || '').trim();
    const resultado = winner(round.winner || round.type || round.resultado || round.vencedor);
    const soma = Number(round.result ?? round.resultado_soma ?? round.soma);
    const instantBruto = round.instant || round.data_hora || round.timestamp || null;
    const ms = instantBruto ? Date.parse(String(instantBruto)) : NaN;

    if (!uuid || !resultado || !Number.isFinite(soma) || !Number.isFinite(ms)) return null;

    return Object.freeze({
        uuid,
        winner: resultado,
        result: soma,
        instant: new Date(ms).toISOString()
    });
}

function vincularSocketServer(server) {
    if (!server || typeof server.emit !== 'function') return false;
    ioServer = server;
    if (!logAtivoEmitido) {
        logAtivoEmitido = true;
        console.log(`⚡ Mapa Bac Bo live ativo | Socket.IO -> ${EVENTO_LIVE}.`);
    }
    return true;
}

function lembrarUuid(uuid) {
    uuidsEmitidos.set(uuid, Date.now());
    while (uuidsEmitidos.size > MAX_UUIDS) {
        uuidsEmitidos.delete(uuidsEmitidos.keys().next().value);
    }
}

function publicarRodadaLive(round) {
    const payload = normalizarRound(round);
    if (!payload || !ioServer) return false;
    if (uuidsEmitidos.has(payload.uuid)) return false;

    lembrarUuid(payload.uuid);
    ioServer.emit(EVENTO_LIVE, payload);
    return true;
}

module.exports = {
    EVENTO_LIVE,
    vincularSocketServer,
    publicarRodadaLive
};
