'use strict';

const { resolverPreferencias } = require('./telegram_signal_config');

let instalado = false;
let fetchAnterior = null;
let atualizacaoStatsEmCurso = null;

const TELEGRAM_HOST = 'api.telegram.org';
const STATS_REFRESH_MS = 15000;
const statsCache = new Map();

function alvoTelegram(input) {
    const bruto = typeof input === 'string' || input instanceof URL
        ? String(input)
        : String(input?.url || '');
    try {
        const url = new URL(bruto);
        if (url.hostname !== TELEGRAM_HOST) return null;
        const match = /^\/bot[^/]+\/(sendMessage|editMessageText)$/.exec(url.pathname);
        return match ? { metodo: match[1] } : null;
    } catch (_) {
        return null;
    }
}

function corpoJson(init) {
    if (!init || typeof init.body !== 'string') return null;
    try {
        const dados = JSON.parse(init.body);
        return dados && typeof dados === 'object' && !Array.isArray(dados) ? dados : null;
    } catch (_) {
        return null;
    }
}

function tipoMensagem(texto) {
    const t = String(texto || '').toUpperCase();
    if (t.includes('NOVA ENTRADA')) return 'ENTRADA';
    if (t.includes('POSSÍVEL GALE') || t.includes('POSSIVEL GALE') || t.includes('🔁 GALE ')) return 'GALE';
    if (t.includes('GREEN CONFIRMADO') || t.includes('EMPATE PROTEGIDO') || t.includes('GREEN - ')) return 'GREEN';
    if (t.includes('RED CONFIRMADO') || t.includes('RED - ')) return 'RED';
    return null;
}

function extrairLinha(texto, regex) {
    return String(texto || '').split('\n').find(item => regex.test(item.trim()))?.trim() || '';
}

function extrairNomeRobo(texto) {
    return extrairLinha(texto, /^🤖\s*Robô:/i).replace(/^🤖\s*Robô:\s*/i, '').trim();
}

function extrairNomeEstrategia(texto) {
    return extrairLinha(texto, /^📊\s*Estratégia:/i).replace(/^📊\s*Estratégia:\s*/i, '').trim();
}

function extrairAssertividadeOriginal(texto) {
    const linha = extrairLinha(texto, /^📈\s*Assertividade\s*:/i);
    const match = linha.match(/([0-9]+(?:[.,][0-9]+)?)\s*%/);
    if (!match) return null;
    const valor = Number(match[1].replace(',', '.'));
    return Number.isFinite(valor) ? valor : null;
}

function botoesDoTeclado(replyMarkup) {
    const linhas = Array.isArray(replyMarkup?.inline_keyboard) ? replyMarkup.inline_keyboard : [];
    return linhas.flat().filter(botao => botao && typeof botao === 'object');
}

function entradaPeloTeclado(replyMarkup) {
    for (const botao of botoesDoTeclado(replyMarkup)) {
        const texto = String(botao.text || '').toUpperCase();
        if (texto.includes('ENTRADA PLAYER')) return 'PLAYER';
        if (texto.includes('ENTRADA BANKER')) return 'BANKER';
        if (texto.includes('ENTRADA TIE') || texto.includes('ENTRADA EMPATE')) return 'EMPATE';
    }
    return '';
}

function entradaPeloCabecalho(texto, tipo) {
    const linhas = String(texto || '').split('\n');
    const regex = tipo === 'RED' ? /RED/i : /GREEN|EMPATE\s+PROTEGIDO/i;
    const linha = linhas.find(item => regex.test(item));
    const t = String(linha || '').toUpperCase();
    if (t.includes('PLAYER')) return 'PLAYER';
    if (t.includes('BANKER')) return 'BANKER';
    if (t.includes('EMPATE') || t.includes('TIE')) return 'EMPATE';
    return '';
}

function cabecalhoGreen(entrada) {
    if (entrada === 'PLAYER') return '✅ GREEN - 🔵 PLAYER';
    if (entrada === 'BANKER') return '✅ GREEN - 🔴 BANKER';
    if (entrada === 'EMPATE') return '✅ GREEN - 🟡 EMPATE';
    return '✅ GREEN';
}

function cabecalhoRed(entrada) {
    if (entrada === 'PLAYER') return '❌ RED - 🔵 PLAYER';
    if (entrada === 'BANKER') return '❌ RED - 🔴 BANKER';
    if (entrada === 'EMPATE') return '❌ RED - 🟡 EMPATE';
    return '❌ RED';
}

function padronizarResultadoFinal(texto, replyMarkup) {
    const original = String(texto || '');
    const upper = original.toUpperCase();
    const entradaTeclado = entradaPeloTeclado(replyMarkup);

    let tipo = '';
    let entrada = '';

    if (upper.includes('EMPATE PROTEGIDO')) {
        tipo = 'GREEN';
        entrada = 'EMPATE';
    } else if (upper.includes('GREEN CONFIRMADO') || upper.includes('GREEN - ')) {
        tipo = 'GREEN';
        entrada = entradaPeloCabecalho(original, 'GREEN') || entradaTeclado;
    } else if (upper.includes('RED CONFIRMADO') || upper.includes('RED - ')) {
        tipo = 'RED';
        entrada = entradaPeloCabecalho(original, 'RED') || entradaTeclado;
    }

    if (!tipo) return original;
    const alvo = tipo === 'GREEN' ? cabecalhoGreen(entrada) : cabecalhoRed(entrada);

    return original.split('\n').map(linha => {
        if (tipo === 'GREEN' && (
            /EMPATE\s+PROTEGIDO/i.test(linha)
            || /GREEN\s+CONFIRMADO/i.test(linha)
            || /^\s*(?:✅\s*)?GREEN\s*-/i.test(linha)
        )) return alvo;
        if (tipo === 'RED' && (
            /RED\s+CONFIRMADO/i.test(linha)
            || /^\s*(?:❌\s*)?RED\s*-/i.test(linha)
        )) return alvo;
        return linha;
    }).join('\n');
}

function normalizarTeclado(replyMarkup, finalizado) {
    if (finalizado) return { inline_keyboard: [] };
    if (!replyMarkup || !Array.isArray(replyMarkup.inline_keyboard)) return replyMarkup;

    const linhas = [];
    for (const botao of botoesDoTeclado(replyMarkup)) {
        const texto = String(botao.text || '').toUpperCase();
        if (texto.includes('SEM PROTEÇÃO EMPATE') || texto.includes('PROTEÇÃO: VERIFICAR')) continue;
        linhas.push([botao]);
    }
    return { ...replyMarkup, inline_keyboard: linhas };
}

function contarTies(ties) {
    let total = 0;
    if (!ties || typeof ties !== 'object') return total;
    for (const nivel of Object.values(ties)) {
        if (!nivel || typeof nivel !== 'object') continue;
        for (const valor of Object.values(nivel)) total += Math.max(0, Number(valor) || 0);
    }
    return total;
}

function assertividadeDetalhe(detalhe) {
    if (!detalhe || typeof detalhe !== 'object') return null;
    const greens = (Number(detalhe.green_direto) || 0)
        + (Number(detalhe.gale1) || 0)
        + (Number(detalhe.gale2) || 0)
        + contarTies(detalhe.ties);
    const reds = Number(detalhe.red) || 0;
    const total = greens + reds;
    return total > 0 ? (greens / total) * 100 : null;
}

async function atualizarStatsCache() {
    if (atualizacaoStatsEmCurso) return atualizacaoStatsEmCurso;

    atualizacaoStatsEmCurso = (async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);
        try {
            const porta = Number(process.env.NODE_PORT || 3000);
            const resposta = await fetchAnterior(`http://127.0.0.1:${porta}/api/estrategias`, {
                method: 'GET',
                headers: { Accept: 'application/json' },
                signal: controller.signal
            });
            if (!resposta.ok) return false;
            const corpo = await resposta.json();
            const lista = Array.isArray(corpo) ? corpo : (Array.isArray(corpo?.estrategias) ? corpo.estrategias : []);
            const agora = Date.now();
            for (const estrategia of lista) {
                const nome = String(estrategia?.nome || '').trim();
                if (!nome) continue;
                statsCache.set(nome, {
                    em: agora,
                    geral: assertividadeDetalhe(estrategia?.detalhes?.geral),
                    h24: assertividadeDetalhe(estrategia?.detalhes?.['24h'])
                });
            }
            return true;
        } catch (_) {
            return false;
        } finally {
            clearTimeout(timeoutId);
        }
    })().finally(() => {
        atualizacaoStatsEmCurso = null;
    });

    return atualizacaoStatsEmCurso;
}

function iniciarCacheStats() {
    const atualizar = () => { void atualizarStatsCache(); };
    setTimeout(atualizar, 1500).unref?.();
    const timer = setInterval(atualizar, STATS_REFRESH_MS);
    timer.unref?.();
}

function statsEstrategia(nome) {
    return statsCache.get(String(nome || '').trim()) || null;
}

function formatarPercentual(valor) {
    return Number.isFinite(Number(valor)) ? `${Number(valor).toFixed(1)}%` : 'N/D';
}

function limparStatusAtivoEstrategia(linha) {
    const bruto = String(linha || '');
    if (!/^\s*📊\s*Estratégia:/i.test(bruto)) return bruto;
    return bruto
        .replace(/\s*\[ATIVO\]\s*/gi, ' ')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/[ \t]+$/g, '');
}

function garantirEspacoAposStatus(linhas) {
    if (!Array.isArray(linhas) || linhas.length === 0) return linhas;
    const indice = linhas.findIndex(linha => {
        const trim = String(linha || '').trim();
        return /^(?:🎯\s*NOVA\s+ENTRADA|✅\s*GREEN\b|❌\s*RED\b|🔁\s*(?:POSSÍVEL\s+)?GALE\b)/iu.test(trim);
    });
    if (indice < 0 || indice >= linhas.length - 1) return linhas;
    if (String(linhas[indice + 1] || '').trim() !== '') linhas.splice(indice + 1, 0, '');
    return linhas;
}

function filtrarEComplementarTexto(texto, preferencias, stats) {
    const original = String(texto || '');
    const assertOriginal = extrairAssertividadeOriginal(original);
    let linhas = original.split('\n').map(limparStatusAtivoEstrategia).filter(linha => {
        const trim = linha.trim();
        // Remove apenas o aviso operacional redundante. A linha `🏁 Resultado:`
        // é evidência do desfecho/etapa e nunca deve ser descartada, inclusive no empate.
        if (/^🛡️\s*Proteção\s+(?:de|do|no)?\s*empate/i.test(trim)) return false;
        if (!preferencias.nomeRobo && /^🤖\s*Robô:/i.test(trim)) return false;
        if (!preferencias.nomeEstrategia && /^📊\s*Estratégia:/i.test(trim)) return false;
        if (!preferencias.padrao && /^🧩\s*Padrão:/i.test(trim)) return false;
        if (/^📈\s*Assertividade(?:\s*\([^)]*\))?\s*:/i.test(trim)) return false;
        if (!preferencias.detalharEmpates && /^✨?\s*Multiplicador:/i.test(trim)) return false;
        return true;
    });

    const linhasAssertividade = [];
    if (preferencias.assertividadeGeral) {
        const geral = Number.isFinite(Number(assertOriginal)) ? assertOriginal : stats?.geral;
        linhasAssertividade.push(`📈 Assertividade (Geral): ${formatarPercentual(geral)}`);
    }
    if (preferencias.assertividade24h) {
        linhasAssertividade.push(`🕒 Assertividade (24h): ${formatarPercentual(stats?.h24)}`);
    }

    if (linhasAssertividade.length > 0) {
        let indice = linhas.findIndex(linha => /^(🏁|🔥|⏳|✨)/u.test(linha.trim()));
        if (indice < 0) indice = linhas.length;
        linhas.splice(indice, 0, ...linhasAssertividade);
    }

    garantirEspacoAposStatus(linhas);

    const saida = [];
    let vazioAnterior = false;
    for (const linha of linhas) {
        const limpa = linha.replace(/[ \t]+$/g, '');
        const vazio = limpa.trim() === '';
        if (vazio && vazioAnterior) continue;
        saida.push(limpa);
        vazioAnterior = vazio;
    }
    return saida.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 4096);
}

async function apresentarPayload(payload) {
    if (!payload || typeof payload.text !== 'string') return payload;
    const tipo = tipoMensagem(payload.text);
    if (!tipo) return payload;

    const finalizado = tipo === 'GREEN' || tipo === 'RED';
    const replyMarkupOriginal = payload.reply_markup;
    let texto = padronizarResultadoFinal(payload.text, replyMarkupOriginal);

    const nomeRobo = extrairNomeRobo(texto);
    const nomeEstrategia = extrairNomeEstrategia(texto);
    const preferencias = await resolverPreferencias(nomeRobo, payload.chat_id);
    const stats = statsEstrategia(nomeEstrategia);
    if (preferencias.assertividade24h && !stats) void atualizarStatsCache();

    texto = filtrarEComplementarTexto(texto, preferencias, stats);
    const replyMarkup = normalizarTeclado(replyMarkupOriginal, finalizado);
    return { ...payload, text: texto, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) };
}

async function fetchTelegramPresenter(input, init = {}) {
    const alvo = alvoTelegram(input);
    const metodoHttp = String(init?.method || input?.method || 'GET').toUpperCase();
    if (!alvo || metodoHttp !== 'POST') return fetchAnterior(input, init);

    const payload = corpoJson(init);
    if (!payload) return fetchAnterior(input, init);

    const apresentado = await apresentarPayload(payload);
    return fetchAnterior(input, { ...init, body: JSON.stringify(apresentado) });
}

function instalarTelegramSignalPresenter() {
    if (instalado) return true;
    if (typeof globalThis.fetch !== 'function') throw new Error('Runtime Node sem fetch nativo para apresentação Telegram');

    fetchAnterior = globalThis.fetch.bind(globalThis);
    globalThis.fetch = fetchTelegramPresenter;
    instalado = true;
    iniciarCacheStats();
    console.log('🎨 Telegram: apresentação limpa ativa | campos configuráveis + botões verticais + resultado por cor.');
    return true;
}

module.exports = { instalarTelegramSignalPresenter };
