'use strict';

const { onHistoricoRecuperado } = require('./bacbo_live_bus');

let instalado = false;
let sequenciaRodadas = 0;
let ultimaSequenciaRodada = 0;
let separarAntesProximaRodada = false;
let ultimoRecoveryCompacto = { count: 0, em: 0 };

const UUIDS_MAX = 5000;
const uuidsRodadas = new Map();
const TIMEZONE = process.env.AUTO_TRADER_TIMEZONE || process.env.TZ || 'America/Sao_Paulo';
const relogio = new Intl.DateTimeFormat('pt-BR', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
});

function lembrarUuid(uuid) {
    const chave = String(uuid || '').trim().toLowerCase();
    if (!chave) return true;
    if (uuidsRodadas.has(chave)) return false;
    uuidsRodadas.set(chave, Date.now());
    while (uuidsRodadas.size > UUIDS_MAX) uuidsRodadas.delete(uuidsRodadas.keys().next().value);
    return true;
}

function horaAtual() {
    try { return relogio.format(new Date()); } catch (_) { return new Date().toTimeString().slice(0, 8); }
}

function horaInstant(valor) {
    const ms = valor ? Date.parse(String(valor)) : NaN;
    if (!Number.isFinite(ms)) return '--:--:--';
    try { return relogio.format(new Date(ms)); } catch (_) { return new Date(ms).toTimeString().slice(0, 8); }
}

function nomeResultado(valor) {
    const tipo = String(valor || '').trim().toUpperCase();
    if (tipo === 'PLAYER' || tipo === 'P' || tipo === 'PLAYERWON') return 'JOGADOR';
    if (tipo === 'BANKER' || tipo === 'B' || tipo === 'BANKERWON') return 'BANCA';
    if (tipo === 'TIE' || tipo === 'T' || tipo === 'TIEWON') return 'EMPATE';
    return tipo || 'RESULTADO';
}

function simboloResultado(valor) {
    const tipo = String(valor || '').trim().toUpperCase();
    if (tipo === 'PLAYER' || tipo === 'P' || tipo === 'PLAYERWON') return 'P';
    if (tipo === 'BANKER' || tipo === 'B' || tipo === 'BANKERWON') return 'B';
    if (tipo === 'TIE' || tipo === 'T' || tipo === 'TIEWON') return 'T';
    return '?';
}

function numeroFormatado(valor) {
    return `#${String(Math.max(0, Number(valor) || 0)).padStart(5, '0')}`;
}

function numeroRodada() {
    sequenciaRodadas += 1;
    ultimaSequenciaRodada = sequenciaRodadas;
    return numeroFormatado(sequenciaRodadas);
}

function numeroUltimaRodada() {
    return numeroFormatado(ultimaSequenciaRodada);
}

function linhaRodada(uuid, tipo, soma) {
    if (!lembrarUuid(uuid)) return null;
    const numero = numeroRodada();
    const horario = horaAtual();
    const resultado = nomeResultado(tipo).padEnd(7, ' ');
    const somaFmt = String(soma).trim().padStart(2, ' ');
    const prefixo = separarAntesProximaRodada ? '\n' : '';
    separarAntesProximaRodada = false;
    return `${prefixo}🎲 ${numero} | ${horario} | ${resultado} | Soma: ${somaFmt}`;
}

function registrarRecoveryOperacional(payload) {
    try {
        const rounds = (Array.isArray(payload?.rounds) ? payload.rounds : [])
            .filter(round => round && typeof round === 'object')
            .sort((a, b) => Date.parse(String(a.instant || '')) - Date.parse(String(b.instant || '')));

        const novos = [];
        for (const round of rounds) {
            if (!lembrarUuid(round.uuid)) continue;
            novos.push(round);
        }
        if (novos.length === 0) return false;

        const inicio = sequenciaRodadas + 1;
        sequenciaRodadas += novos.length;
        ultimaSequenciaRodada = sequenciaRodadas;

        const primeiroNumero = numeroFormatado(inicio);
        const ultimoNumero = numeroFormatado(sequenciaRodadas);
        const primeiroHorario = horaInstant(novos[0].instant);
        const ultimoHorario = horaInstant(novos[novos.length - 1].instant);
        const faixa = `${primeiroNumero}…${ultimoNumero}`;
        const prefixo = '\n';

        ultimoRecoveryCompacto = { count: novos.length, em: Date.now() };
        separarAntesProximaRodada = true;

        if (payload?.continuity === false) {
            console.warn(
                `${prefixo}⚠️ RECOVERY | ${novos.length} rodadas disponíveis | `
                + `${primeiroHorario} → ${ultimoHorario} | ${faixa} | sem âncora na janela; nova fronteira`
            );
            return true;
        }

        console.log(
            `${prefixo}♻️ RECOVERY | ${novos.length} rodada(s) recuperada(s) | `
            + `${primeiroHorario} → ${ultimoHorario} | ${faixa}`
        );
        return true;
    } catch (_) {
        return false;
    }
}

function registrarSinalOperacional(payload) {
    if (!payload || String(payload.tipo || '').toUpperCase() !== 'ENTRADA') return false;
    const robos = Array.isArray(payload.robosNotificados) ? payload.robosNotificados : [];
    if (robos.length === 0) return false;

    const padrao = (Array.isArray(payload.padrao) ? payload.padrao : [])
        .map(simboloResultado)
        .filter(simbolo => simbolo !== '?')
        .join('-');
    const entradaSimbolo = simboloResultado(payload.entrada);
    const entradaNome = nomeResultado(payload.entrada);
    const assinatura = `${padrao || '?'} → ${entradaSimbolo}`;

    robos.forEach((robo, indice) => {
        const id = robo?.id !== undefined && robo?.id !== null ? String(robo.id) : '?';
        const prefixo = indice === 0 ? '\n' : '';
        console.log(`${prefixo}🎯 SINAL    | Robô ${id} | ${assinatura} | Entrada: ${entradaNome}`);
    });

    separarAntesProximaRodada = true;
    return true;
}

function formatarTexto(valor) {
    let texto = String(valor);

    if (
        texto.includes('🔥 Vencedor:')
        && texto.includes('🔵 Jogador :')
        && texto.includes('🔴 Banca:')
    ) {
        return null;
    }

    if (/^⚠️ bacbo_events recebido mas ignorado \| motivo=evento_nao_reconhecido \| action=history_sync\.$/i.test(texto)) {
        return null;
    }

    let match = texto.match(
        /^🔄 Mapeamento BacBo -> IA \| uuid=([0-9a-f-]{36}) \| type=(PLAYER|BANKER|TIE) -> interno=(Player|Banker|Tie) \| simbolo=([PBT]) \| soma=(.+)$/i
    );
    if (match) {
        return linhaRodada(match[1], match[2], match[5]);
    }

    if (/^✅ Nova rodada processada pela IA -> Vencedor:/i.test(texto)) return null;
    if (/^✅ IA atualizada \|/i.test(texto)) return null;

    match = texto.match(/^📨 Robô\s+(\d+):\s+Telegram confirmado em\s+(\d+)\/(\d+)\s+destino\(s\)\.$/i);
    if (match) {
        return `📨 TELEGRAM | Robô ${match[1]} | Confirmado     | Destinos: ${match[2]}/${match[3]}`;
    }

    match = texto.match(/^📨 Robô\s+(\d+):\s+teste Telegram confirmado em\s+(\d+)\/(\d+)\s+destino\(s\)\.$/i);
    if (match) {
        return `📨 TESTE TG | Robô ${match[1]} | Confirmado     | Destinos: ${match[2]}/${match[3]}`;
    }

    match = texto.match(/^🧩 Recovery analítico \| (\d+) giro\(s\) recomposto\(s\) cronologicamente \| janela=(\d+)(.*)$/i);
    if (match) {
        const count = Number(match[1]) || 0;
        if (count === ultimoRecoveryCompacto.count && Date.now() - ultimoRecoveryCompacto.em < 5000) return null;
        return `🧩 ANALÍTICO | ${count} giro(s) recomposto(s) | Janela: ${match[2]}${match[3] || ''}`;
    }

    match = texto.match(/^⚠️ Continuidade de dados comprometida \(([^)]+)\): (\d+) sinal\(is\) pendente\(s\) invalidado\(s\), (\d+) Auto-Trader\(s\) com ordem pendente bloqueado\(s\)\.$/i);
    if (match) {
        return `🛡️ CONTINUIDADE | ${match[1]} | Sinais invalidados: ${match[2]} | Traders bloqueados: ${match[3]}`;
    }

    if (/^⏳ Fila live aguardando o backend concluir a inicialização\.$/i.test(texto)) {
        return `⏳ FILA     | ${numeroUltimaRodada()} | Backend inicializando; rodada preservada.`;
    }
    if (/^⏳ Fila live aguardando o servidor local ficar disponível\.$/i.test(texto)) {
        return `⏳ FILA     | ${numeroUltimaRodada()} | Servidor local indisponível; rodada preservada.`;
    }
    if (/^✅ Fila live liberada \| backend pronto; processamento retomado em ordem\.$/i.test(texto)) {
        return `✅ FILA     | ${numeroUltimaRodada()} | Backend pronto; processamento retomado.`;
    }
    if (/^⚠️ Rodada live não entregue ao backend; fila preservada sem marcar como processada\.$/i.test(texto)) {
        return `❌ ERRO     | ${numeroUltimaRodada()} | Rodada live não entregue; fila preservada.`;
    }
    if (/^⚠️ Persistencia bacbo_rounds falhou/i.test(texto)) {
        texto = texto.replace(/^⚠️ Persistencia bacbo_rounds falhou[^:]*:\s*/i, '');
        return `⚠️ ALERTA   | ${numeroUltimaRodada()} | Persistência canônica falhou${texto ? ` | ${texto}` : ''}`;
    }

    match = texto.match(/^♻️ TipMiner HISTORY atualizado \| janela=(\d+) \| novas=(\d+) \| origem=([^\.]+)\.$/i);
    if (match) {
        const novas = Math.max(0, Number(match[2]) || 0);
        if (novas === 0) return null;
        return `♻️ HISTÓRICO | ${novas} nova(s) detectada(s) | Janela: ${match[1]}.`;
    }

    texto = texto.replace(/TIPMINER/gi, 'BAC BO');
    texto = texto.replace(/TipMiner/g, 'Bac Bo');

    texto = texto.replace(/\buuid=[0-9a-f-]{36}\s*\|\s*/gi, '');
    texto = texto.replace(/\s*\|\s*uuid=[0-9a-f-]{36}/gi, '');
    texto = texto.replace(/\s*\|\s*UUID:\s*[0-9a-f-]{36}/gi, '');

    if (/^🎧 Bac Bo Redis V3 ativo em bacbo_events:/i.test(texto)) {
        return '🎧 Redis Bac Bo ativo | canal=bacbo_events | contrato=type+result.';
    }

    if (/^🎧 Adaptador Bac Bo HISTORY_SYNC ativo:/i.test(texto)) {
        return '🎧 Sincronização de histórico ativa | Redis -> Runtime V3.';
    }

    match = texto.match(/^♻️ Bac Bo HISTORY_SYNC -> Node \| (\d+) giro\(s\).*$/i);
    if (match) {
        return `♻️ Histórico inicial carregado | ${match[1]} giro(s).`;
    }

    match = texto.match(/^🧠 Bac Bo HISTORY schema novo persistido \| (\d+) rodada\(s\)\.$/i);
    if (match) {
        const novas = Math.max(0, Number(match[1]) || 0);
        if (novas === 0) return null;
        return `🧠 Histórico canônico | ${novas} nova(s) persistida(s).`;
    }

    match = texto.match(/^✅ Bac Bo HISTORY sincronizado com Runtime V3 \| (\d+) giro\(s\)\.$/i);
    if (match) {
        return `✅ Histórico inicial sincronizado | ${match[1]} giro(s).`;
    }

    texto = texto.replace(/Bac Bo HISTORY_SYNC/gi, 'Histórico Bac Bo');
    texto = texto.replace(/Bac Bo HISTORY/gi, 'Histórico Bac Bo');

    return texto;
}

function instalarLogOperacional() {
    if (instalado) return;

    for (const nivel of ['log', 'info', 'warn', 'error']) {
        const original = console[nivel].bind(console);
        console[nivel] = (...args) => {
            const saida = [];
            for (const arg of args) {
                if (typeof arg !== 'string') {
                    saida.push(arg);
                    continue;
                }
                const formatado = formatarTexto(arg);
                if (formatado === null) return;
                saida.push(formatado);
            }
            original(...saida);
        };
    }

    onHistoricoRecuperado(registrarRecoveryOperacional);
    instalado = true;
}

module.exports = {
    instalarLogOperacional,
    formatarTexto,
    registrarSinalOperacional,
    registrarRecoveryOperacional
};
