'use strict';

let instalado = false;

function nomeResultado(valor) {
    const tipo = String(valor || '').trim().toUpperCase();
    if (tipo === 'PLAYER' || tipo === 'P' || tipo === 'PLAYERWON' || tipo === 'PLAYER') return '🔵 JOGADOR';
    if (tipo === 'BANKER' || tipo === 'B' || tipo === 'BANKERWON') return '🔴 BANCA';
    if (tipo === 'TIE' || tipo === 'T' || tipo === 'TIEWON') return '🟡 EMPATE';
    return tipo || 'RESULTADO';
}

function formatarTexto(valor) {
    let texto = String(valor);

    // O contrato atual não possui placares individuais. O bloco legado 00/00 é enganoso e deve sumir.
    if (
        texto.includes('🔥 Vencedor:')
        && texto.includes('🔵 Jogador :')
        && texto.includes('🔴 Banca:')
    ) {
        return null;
    }

    // O history_sync é consumido pelo adaptador dedicado; o consumidor genérico pode ignorá-lo sem alarme.
    if (/^⚠️ bacbo_events recebido mas ignorado \| motivo=evento_nao_reconhecido \| action=history_sync\.$/i.test(texto)) {
        return null;
    }

    // Nomes de fornecedor não fazem parte do log operacional.
    texto = texto.replace(/TIPMINER/gi, 'BAC BO');
    texto = texto.replace(/TipMiner/g, 'Bac Bo');

    // UUID continua existindo internamente para deduplicação, mas não polui o terminal.
    texto = texto.replace(/\buuid=[0-9a-f-]{36}\s*\|\s*/gi, '');
    texto = texto.replace(/\s*\|\s*uuid=[0-9a-f-]{36}/gi, '');
    texto = texto.replace(/\s*\|\s*UUID:\s*[0-9a-f-]{36}/gi, '');

    let match = texto.match(
        /^🔄 Mapeamento BacBo -> IA \| type=(PLAYER|BANKER|TIE) -> interno=(Player|Banker|Tie) \| simbolo=([PBT]) \| soma=(.+)$/
    );
    if (match) {
        return `🎲 Rodada recebida | ${nomeResultado(match[1])} | Soma: ${match[4]}`;
    }

    match = texto.match(
        /^✅ Nova rodada processada pela IA -> Vencedor: ([PBT]) \((Player|Banker|Tie)\) \| Soma: (.+)$/
    );
    if (match) {
        return `✅ IA atualizada | ${nomeResultado(match[1])} | Soma: ${match[3]}`;
    }

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
        return `🧠 Histórico inicial persistido | ${match[1]} rodada(s).`;
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

    instalado = true;
}

module.exports = {
    instalarLogOperacional,
    formatarTexto
};
