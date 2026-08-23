'use strict';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NUMERIC_TYPE_MAP = new Map([
    [1, 'Player'],
    [2, 'Banker'],
    [3, 'Tie']
]);

function objeto(valor) {
    return valor && typeof valor === 'object' && !Array.isArray(valor) ? valor : null;
}

function valorJson(valor) {
    if (typeof valor !== 'string') return valor;
    const texto = valor.trim();
    if (!texto || (!texto.startsWith('{') && !texto.startsWith('['))) return valor;
    try { return JSON.parse(texto); } catch (_) { return valor; }
}

function parseMensagem(mensagem) {
    const bruto = Buffer.isBuffer(mensagem) ? mensagem.toString('utf8') : mensagem;
    const parsed = valorJson(bruto);
    return objeto(parsed);
}

function extrairPayloadLive(raiz) {
    const root = objeto(raiz);
    if (!root) return null;
    for (const chave of ['data', 'payload', 'event']) {
        const candidato = objeto(valorJson(root[chave]));
        if (candidato) return candidato;
    }
    return root;
}

function normalizarTipoBacbo(valor) {
    if (typeof valor === 'number' && Number.isInteger(valor)) {
        return NUMERIC_TYPE_MAP.get(valor) || null;
    }

    const texto = String(valor ?? '').trim().toUpperCase();
    if (!texto) return null;
    if (/^[123]$/.test(texto)) return NUMERIC_TYPE_MAP.get(Number(texto)) || null;
    if (['PLAYER', 'PLAYERWON', 'P', 'JOGADOR', 'AZUL'].includes(texto)) return 'Player';
    if (['BANKER', 'BANKERWON', 'B', 'BANCA', 'VERMELHO'].includes(texto)) return 'Banker';
    if (['TIE', 'TIEWON', 'T', 'DRAW', 'EMPATE'].includes(texto)) return 'Tie';
    return null;
}

function simboloIA(vencedor) {
    if (vencedor === 'Player') return 'P';
    if (vencedor === 'Banker') return 'B';
    if (vencedor === 'Tie') return 'T';
    return null;
}

function tipoWire(vencedor) {
    if (vencedor === 'Player') return 'PLAYER';
    if (vencedor === 'Banker') return 'BANKER';
    if (vencedor === 'Tie') return 'TIE';
    return null;
}

function vencedorLegado(vencedor) {
    if (vencedor === 'Player') return 'PlayerWon';
    if (vencedor === 'Banker') return 'BankerWon';
    if (vencedor === 'Tie') return 'Tie';
    return null;
}

function validarLiveRound(mensagem) {
    const raiz = parseMensagem(mensagem) || objeto(mensagem);
    if (!raiz) return { ok: false, erro: 'payload_invalido' };

    const payload = extrairPayloadLive(raiz);
    if (!payload) return { ok: false, erro: 'payload_live_ausente' };

    const uuid = String(payload.uuid ?? '').trim().toLowerCase();
    if (!UUID_RE.test(uuid)) return { ok: false, erro: 'uuid_invalido' };

    const vencedor = normalizarTipoBacbo(payload.type);
    if (!vencedor) return { ok: false, erro: 'type_invalido' };

    const brutoResultado = payload.result;
    if (typeof brutoResultado !== 'number' || !Number.isFinite(brutoResultado)) {
        return { ok: false, erro: 'result_invalido' };
    }

    const instantBruto = payload.instant;
    const timestampParseado = instantBruto === undefined || instantBruto === null || instantBruto === ''
        ? Date.now()
        : Date.parse(String(instantBruto));
    const timestampMs = Number.isFinite(timestampParseado) ? timestampParseado : Date.now();

    return {
        ok: true,
        round: {
            uuid,
            type: tipoWire(vencedor),
            winner: vencedor,
            winner_symbol: simboloIA(vencedor),
            winner_legacy: vencedorLegado(vencedor),
            result: brutoResultado,
            instant: new Date(timestampMs).toISOString(),
            timestamp_ms: timestampMs
        }
    };
}

module.exports = {
    UUID_RE,
    parseMensagem,
    extrairPayloadLive,
    normalizarTipoBacbo,
    simboloIA,
    tipoWire,
    vencedorLegado,
    validarLiveRound
};
