'use strict';

const { EventEmitter } = require('events');

const EVENTO_LIVE = 'bacbo_round_live';
const EVENTO_RECOVERY = 'bacbo_history_recovered';
const MAX_UUIDS = 5000;

let ioServer = null;
let logAtivoEmitido = false;
const uuidsEmitidos = new Map();
const eventosInternos = new EventEmitter();
eventosInternos.setMaxListeners(20);

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

function normalizarLote(rounds) {
    const unicos = new Map();
    for (const item of Array.isArray(rounds) ? rounds : []) {
        const round = normalizarRound(item);
        if (round) unicos.set(round.uuid, round);
    }
    return [...unicos.values()].sort((a, b) => {
        const ams = Date.parse(a.instant);
        const bms = Date.parse(b.instant);
        return ams - bms || a.uuid.localeCompare(b.uuid);
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

function publicarHistoricoRecuperado(rounds, meta = {}) {
    const lote = normalizarLote(rounds);
    if (lote.length === 0) return false;

    for (const round of lote) lembrarUuid(round.uuid);

    const payload = Object.freeze({
        count: lote.length,
        continuity: meta.continuidade !== false,
        window: Math.max(0, Number(meta.janela) || 0),
        first_instant: lote[0].instant,
        last_instant: lote[lote.length - 1].instant,
        rounds: lote
    });

    eventosInternos.emit(EVENTO_RECOVERY, payload);
    if (ioServer) ioServer.emit(EVENTO_RECOVERY, payload);
    return payload;
}

function onHistoricoRecuperado(listener) {
    if (typeof listener !== 'function') return () => {};
    eventosInternos.on(EVENTO_RECOVERY, listener);
    return () => eventosInternos.off(EVENTO_RECOVERY, listener);
}

module.exports = {
    EVENTO_LIVE,
    EVENTO_RECOVERY,
    vincularSocketServer,
    publicarRodadaLive,
    publicarHistoricoRecuperado,
    onHistoricoRecuperado
};