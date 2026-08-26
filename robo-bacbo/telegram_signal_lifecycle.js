'use strict';

const mysql = require('mysql2/promise');

let instalado = false;
let fetchNativo = null;
let pool = null;

const ciclos = new Map();
const TELEGRAM_HOST = 'api.telegram.org';
const URL_BOTAO_PADRAO = 'https://t.me';
const AUX_TIMEOUT_MS = Math.max(1500, Number(process.env.TELEGRAM_SIGNAL_AUX_TIMEOUT_MS || 4000));
const DELETE_MAX_ATTEMPTS = Math.max(1, Math.min(5, Number(process.env.TELEGRAM_DELETE_MAX_ATTEMPTS || 3)));
const DELETE_BACKOFF_MS = Math.max(100, Math.min(5000, Number(process.env.TELEGRAM_DELETE_BACKOFF_MS || 250)));
const CLEANUP_MAX_ROUNDS = Math.max(1, Math.min(8, Number(process.env.TELEGRAM_CLEANUP_MAX_ROUNDS || 5)));
const limpezasPendentes = new Map();

function dbPool() {
    if (pool) return pool;
    pool = mysql.createPool({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        waitForConnections: true,
        connectionLimit: 2,
        queueLimit: 0
    });
    return pool;
}

function textoSeguro(valor) {
    return String(valor ?? '').replace(/\r/g, '').trim();
}

function urlBotao() {
    const candidato = String(process.env.TELEGRAM_SIGNAL_BUTTON_URL || URL_BOTAO_PADRAO).trim();
    try {
        const url = new URL(candidato);
        if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
    } catch (_) {}
    return URL_BOTAO_PADRAO;
}

function urlTelegram(input) {
    const bruto = typeof input === 'string' || input instanceof URL
        ? String(input)
        : String(input?.url || '');
    try {
        const url = new URL(bruto);
        if (url.hostname !== TELEGRAM_HOST) return null;
        const match = /^\/bot([^/]+)\/(sendMessage)$/.exec(url.pathname);
        if (!match) return null;
        return { token: match[1], metodo: match[2], url: bruto };
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
    const t = textoSeguro(texto).toUpperCase();
    if (t.includes('🎯 NOVA ENTRADA')) return 'ENTRADA';
    if (t.includes('🔁 GALE ')) return 'GALE';
    if (t.includes('✅ GREEN CONFIRMADO') || t.includes('🟡 EMPATE PROTEGIDO')) return 'GREEN';
    if (t.includes('❌ RED CONFIRMADO')) return 'RED';
    return null;
}

function nivelGale(texto) {
    const match = textoSeguro(texto).match(/🔁\s*GALE\s*(\d+)/i);
    return match ? Math.max(1, Number(match[1]) || 1) : 1;
}

function removerTarjas(texto) {
    const decoracao = /^[\s━─═_—–-]{3,}$/u;
    const linhas = textoSeguro(texto)
        .split('\n')
        .filter(linha => !decoracao.test(linha.trim()));

    const saida = [];
    let vazioAnterior = false;
    for (const linha of linhas) {
        const vazio = linha.trim() === '';
        if (vazio && vazioAnterior) continue;
        saida.push(linha.replace(/[ \t]+$/g, ''));
        vazioAnterior = vazio;
    }
    return saida.join('\n').trim();
}

function extrairNomeEstrategia(texto) {
    const linha = textoSeguro(texto).split('\n').find(item => /^📊\s*Estratégia:/i.test(item.trim()));
    return linha ? linha.replace(/^📊\s*Estratégia:\s*/i, '').trim() : '';
}

function extrairNomeRobo(texto) {
    const linha = textoSeguro(texto).split('\n').find(item => /^🤖\s*Robô:/i.test(item.trim()));
    return linha ? linha.replace(/^🤖\s*Robô:\s*/i, '').trim() : '';
}

function extrairEntrada(texto) {
    const linha = textoSeguro(texto).split('\n').find(item => /^💰\s*Entrada:/i.test(item.trim()));
    const t = String(linha || '').toUpperCase();
    if (t.includes('PLAYER')) return 'Player';
    if (t.includes('BANKER')) return 'Banker';
    if (t.includes('TIE') || t.includes('EMPATE')) return 'Tie';
    return '';
}

function extrairPadrao(texto) {
    const linha = textoSeguro(texto).split('\n').find(item => /^🧩\s*Padrão:/i.test(item.trim()));
    if (!linha) return [];
    return linha
        .replace(/^🧩\s*Padrão:\s*/i, '')
        .split('→')
        .map(parte => {
            const p = parte.toUpperCase();
            if (/\bP\b/.test(p)) return 'Player';
            if (/\bB\b/.test(p)) return 'Banker';
            if (/\bT\b/.test(p)) return 'Tie';
            return '';
        })
        .filter(Boolean);
}

function mesmoPadrao(a, b) {
    const x = Array.isArray(a) ? a.map(String) : [];
    const y = Array.isArray(b) ? b.map(String) : [];
    return x.length === y.length && x.every((valor, indice) => valor === y[indice]);
}

async function resolverPolitica(texto) {
    const nome = extrairNomeEstrategia(texto);
    const entrada = extrairEntrada(texto);
    const padrao = extrairPadrao(texto);
    if (!nome) {
        return { conhecida: false, entrada, gales: 0, protegerEmpate: null, estrategiaId: null };
    }

    try {
        const db = dbPool();
        const params = [nome];
        let whereEntrada = '';
        if (entrada) {
            whereEntrada = ' AND entrada=?';
            params.push(entrada);
        }
        const [linhas] = await db.query(
            `SELECT id, nome, entrada, gales, proteger_empate, padrao
             FROM estrategias
             WHERE ativo=true AND nome=?${whereEntrada}
             ORDER BY is_dinamico DESC, criado_em DESC, id DESC`,
            params
        );

        if (!Array.isArray(linhas) || linhas.length === 0) {
            return { conhecida: false, entrada, gales: 0, protegerEmpate: null, estrategiaId: null };
        }

        const candidatos = linhas.map(row => {
            let padraoDb = [];
            try { padraoDb = JSON.parse(row.padrao || '[]'); } catch (_) {}
            return {
                row,
                padrao: Array.isArray(padraoDb) ? padraoDb.map(String) : []
            };
        });

        let escolhido = null;
        if (padrao.length > 0) {
            escolhido = candidatos.find(item => mesmoPadrao(item.padrao, padrao)) || null;
        }
        if (!escolhido && candidatos.length === 1) escolhido = candidatos[0];

        if (!escolhido) {
            const assinaturas = new Set(candidatos.map(item => [
                Number(item.row.gales) || 0,
                item.row.proteger_empate === true || item.row.proteger_empate === 1 ? 1 : 0,
                String(item.row.entrada || '')
            ].join('|')));
            if (assinaturas.size === 1) escolhido = candidatos[0];
        }

        if (!escolhido) {
            console.warn(`⚠️ Telegram: política da estratégia "${nome}" ficou ambígua; proteção não será inferida.`);
            return { conhecida: false, entrada, gales: 0, protegerEmpate: null, estrategiaId: null };
        }

        const row = escolhido.row;
        return {
            conhecida: true,
            entrada: String(row.entrada || entrada || ''),
            gales: Math.max(0, Math.min(2, Math.trunc(Number(row.gales) || 0))),
            protegerEmpate: row.proteger_empate === true || row.proteger_empate === 1,
            estrategiaId: String(row.id || '')
        };
    } catch (erro) {
        console.error('⚠️ Telegram: falha ao consultar política do sinal; mensagem será enviada sem inferência:', erro.message);
        return { conhecida: false, entrada, gales: 0, protegerEmpate: null, estrategiaId: null };
    }
}

function linhaEntradaEhGerenciada(linha) {
    return /^💰\s*Entrada:/i.test(linha.trim());
}

function linhaProtecaoEhGerenciada(linha) {
    // Somente o aviso operacional é gerenciado aqui. `🏁 Resultado:` deve sobreviver
    // ao pipeline para registrar DIRETO/GALE mesmo quando o GREEN veio do empate.
    return /^🛡️\s*Proteção\s+(?:de|do|no)?\s*empate/i.test(String(linha || '').trim());
}

function formatarTextoSinal(texto, politica) {
    let linhas = removerTarjas(texto).split('\n');
    linhas = linhas.filter(linha => !linhaEntradaEhGerenciada(linha) && !linhaProtecaoEhGerenciada(linha));

    if (politica?.conhecida && politica.protegerEmpate === true) {
        const indiceEspera = linhas.findIndex(linha => /Aguardando resultado/i.test(linha));
        const aviso = '🛡️ Proteção de empate: ATIVA';
        if (indiceEspera >= 0) linhas.splice(indiceEspera, 0, aviso);
        else linhas.push(aviso);
    }

    return removerTarjas(linhas.join('\n')).slice(0, 4096);
}

function botoesSinal(politica) {
    const entrada = String(politica?.entrada || '').toUpperCase();
    const entradaTexto = entrada === 'PLAYER'
        ? '🔵 ENTRADA PLAYER'
        : entrada === 'BANKER'
            ? '🔴 ENTRADA BANKER'
            : entrada === 'TIE'
                ? '🟡 ENTRADA TIE'
                : '🎯 ENTRADA';

    let protecaoTexto = '⚠️ PROTEÇÃO: VERIFICAR';
    if (politica?.conhecida) {
        protecaoTexto = politica.protegerEmpate
            ? '🟡 PROTEÇÃO EMPATE'
            : '⚪ SEM PROTEÇÃO EMPATE';
    }

    const url = urlBotao();
    return {
        inline_keyboard: [[
            { text: entradaTexto, url },
            { text: protecaoTexto, url }
        ]]
    };
}

function normalizarNomeRobo(nome) {
    return textoSeguro(nome).toLowerCase().replace(/\s+/g, ' ');
}

function chaveBaseCiclo(token, chatId) {
    return `${token}\n${String(chatId)}`;
}

function chaveCiclo(token, chatId, nomeRobo = '') {
    return `${chaveBaseCiclo(token, chatId)}\n${normalizarNomeRobo(nomeRobo)}`;
}

function encontrarCiclo(token, chatId, texto) {
    const nomeRobo = extrairNomeRobo(texto);
    if (nomeRobo) {
        const chaveExata = chaveCiclo(token, chatId, nomeRobo);
        const exato = ciclos.get(chaveExata);
        if (exato) return { chave: chaveExata, ciclo: exato };
    }

    const prefixo = `${chaveBaseCiclo(token, chatId)}\n`;
    const candidatos = [...ciclos.entries()].filter(([chave]) => chave.startsWith(prefixo));
    if (candidatos.length === 1) {
        return { chave: candidatos[0][0], ciclo: candidatos[0][1] };
    }
    if (candidatos.length > 1) {
        console.warn(
            `⚠️ Telegram: correlação ambígua de ciclo para ${mascararChat(chatId)}; `
            + `${candidatos.length} robôs compartilham o mesmo destino.`
        );
    }
    return null;
}

function mascararChat(chatId) {
    const valor = String(chatId || '').trim();
    if (!valor) return '(vazio)';
    const final = valor.slice(-4);
    return `${'*'.repeat(Math.max(3, valor.length - final.length))}${final}`;
}

function esperar(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function telegramApi(token, metodo, payload, signal = null) {
    const controller = signal ? null : new AbortController();
    const timeoutId = controller ? setTimeout(() => controller.abort(), AUX_TIMEOUT_MS) : null;
    try {
        const resposta = await fetchNativo(`https://${TELEGRAM_HOST}/bot${token}/${metodo}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: signal || controller.signal
        });
        let corpo = null;
        try { corpo = await resposta.json(); } catch (_) {}
        return {
            ok: resposta.ok && corpo?.ok === true,
            status: Number(resposta.status) || 0,
            corpo: corpo || { ok: false, description: `HTTP ${resposta.status || 0}` }
        };
    } catch (erro) {
        return {
            ok: false,
            status: 0,
            corpo: { ok: false, description: erro?.name === 'AbortError' ? 'timeout' : String(erro?.message || erro) }
        };
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

function respostaTelegram(resultado) {
    return new Response(JSON.stringify(resultado.corpo), {
        status: resultado.status || (resultado.ok ? 200 : 500),
        headers: { 'Content-Type': 'application/json' }
    });
}

// MC9: mensagens temporárias de Gale são deliberadamente enxutas.
function mensagemGale(nivel, estrategiaNome = '') {
    const linhas = [
        `🔁 GALE ${nivel}`
    ];

    const estrategia = textoSeguro(
        estrategiaNome
    );

    if (estrategia) {
        linhas.push('');
        linhas.push(
            `📊 Estratégia: ${estrategia}`
        );
    }

    linhas.push(
        '⌛ Aguardando resultado da mesa...'
    );

    return linhas.join('\n');
}

function registrarMensagemGaleParaLimpeza(ciclo, messageId) {
    const id = Number(messageId);

    if (!Number.isFinite(id) || id <= 0) {
        return 0;
    }

    if (!(ciclo.galeCleanupMessageIds instanceof Set)) {
        ciclo.galeCleanupMessageIds = new Set();
    }

    ciclo.galeCleanupMessageIds.add(id);

    return id;
}

async function criarMensagensGale(ciclo) {
    for (let nivel = 1; nivel <= ciclo.politica.gales; nivel++) {
        const resultado = await telegramApi(ciclo.token, 'sendMessage', {
            chat_id: ciclo.chatId,
            text: mensagemGale(nivel, ciclo.estrategiaNome),
            reply_markup: botoesSinal(ciclo.politica)
        });
        if (resultado.ok && Number(resultado.corpo?.result?.message_id) > 0) {
            // Persiste imediatamente no objeto do ciclo.
            // O ID também entra no ledger de limpeza do ciclo e
            // nunca é esquecido caso posteriormente exista fallback.
            const messageId = registrarMensagemGaleParaLimpeza(
                ciclo,
                resultado.corpo.result.message_id
            );

            ciclo.galeMessageIds[nivel - 1] = messageId;
        } else {
            console.warn(
                `⚠️ Telegram: não foi possível criar placeholder do Gale ${nivel} `
                + `para ${mascararChat(ciclo.chatId)} — HTTP ${resultado.status || 0}, `
                + `código ${Number(resultado.corpo?.error_code) || 'n/a'}: `
                + `${String(resultado.corpo?.description || 'sem descrição').slice(0, 180)}.`
            );
        }
    }
    return [...ciclo.galeMessageIds];
}

function edicaoTelegramJaEfetivada(resultado) {
    const descricao = String(
        resultado?.corpo?.description || ''
    ).toLowerCase();

    return Number(resultado?.status) === 400
        && descricao.includes('message is not modified');
}

async function editarMensagem(ciclo, messageId, texto) {
    if (!Number.isFinite(Number(messageId)) || Number(messageId) <= 0) {
        return false;
    }

    const resultado = await telegramApi(
        ciclo.token,
        'editMessageText',
        {
            chat_id: ciclo.chatId,
            message_id: Number(messageId),
            text: formatarTextoSinal(
                texto,
                ciclo.politica
            ),
            reply_markup: botoesSinal(
                ciclo.politica
            )
        }
    );

    // 200 OK: edição aplicada.
    // 400 "message is not modified": conteúdo já estava correto,
    // portanto também é sucesso idempotente.
    return resultado.ok
        || edicaoTelegramJaEfetivada(resultado);
}

function exclusaoJaEfetivada(resultado) {
    const descricao = String(resultado?.corpo?.description || '').toLowerCase();
    return Number(resultado?.status) === 400
        && (descricao.includes('message to delete not found') || descricao.includes('message not found'));
}

function falhaExclusaoTransitoria(resultado) {
    const status = Number(resultado?.status) || 0;
    return status === 0 || status === 429 || status >= 500;
}

async function excluirMensagem(ciclo, messageId) {
    const id = Number(messageId);
    if (!Number.isFinite(id) || id <= 0) return { ok: true, message_id: id || 0, tentativas: 0 };

    let ultimo = null;
    for (let tentativa = 1; tentativa <= DELETE_MAX_ATTEMPTS; tentativa++) {
        const resultado = await telegramApi(ciclo.token, 'deleteMessage', {
            chat_id: ciclo.chatId,
            message_id: id
        });
        ultimo = resultado;

        if (resultado.ok || exclusaoJaEfetivada(resultado)) {
            return { ok: true, message_id: id, tentativas: tentativa, resultado };
        }

        const transitoria = falhaExclusaoTransitoria(resultado);
        const codigo = Number(resultado.corpo?.error_code) || null;
        const descricao = String(resultado.corpo?.description || 'sem descrição').slice(0, 220);
        if (!transitoria || tentativa >= DELETE_MAX_ATTEMPTS) {
            console.error(
                `❌ Telegram deleteMessage falhou | chat=${mascararChat(ciclo.chatId)} | `
                + `message_id=${id} | tentativa=${tentativa}/${DELETE_MAX_ATTEMPTS} | `
                + `HTTP=${resultado.status || 0} | code=${codigo || 'n/a'} | ${descricao}`
            );
            break;
        }

        const retryAfter = Math.max(0, Number(resultado.corpo?.parameters?.retry_after) || 0) * 1000;
        const atraso = retryAfter > 0
            ? retryAfter
            : Math.min(10000, DELETE_BACKOFF_MS * (2 ** (tentativa - 1)));
        console.warn(
            `⚠️ Telegram deleteMessage transitório | chat=${mascararChat(ciclo.chatId)} | `
            + `message_id=${id} | HTTP=${resultado.status || 0} | nova tentativa em ${atraso}ms.`
        );
        await esperar(atraso);
    }

    return { ok: false, message_id: id, tentativas: DELETE_MAX_ATTEMPTS, resultado: ultimo };
}

async function limparGales(ciclo) {
    try {
        await ciclo.placeholdersPromise;
    } catch (erro) {
        console.warn(
            `⚠️ Telegram: placeholders de Gale terminaram com erro antes da limpeza: ${erro.message}`
        );
    }

    const idsAtuais = Array.isArray(ciclo.galeMessageIds)
        ? ciclo.galeMessageIds
        : [];

    const idsRastreados =
        ciclo.galeCleanupMessageIds instanceof Set
            ? [...ciclo.galeCleanupMessageIds]
            : [];

    // Nunca dependemos apenas do "ID atual" do Gale.
    // Qualquer mensagem criada por este ciclo permanece
    // responsabilizada até ser efetivamente excluída.
    const ids = [
        ...new Set(
            [...idsAtuais, ...idsRastreados]
                .map(Number)
                .filter(id =>
                    Number.isFinite(id)
                    && id > 0
                )
        )
    ];

    if (ids.length === 0) {
        ciclo.galeMessageIds = [];
        ciclo.galeCleanupMessageIds = new Set();

        return {
            ok: true,
            removidos: 0,
            pendentes: []
        };
    }

    const resultados = await Promise.all(
        ids.map(id =>
            excluirMensagem(ciclo, id)
        )
    );

    const pendentes = [];

    resultados.forEach(
        (resultado, indice) => {
            if (resultado.ok) {
                return;
            }

            pendentes.push(
                ids[indice]
            );
        }
    );

    // Após uma rodada de limpeza, somente mensagens cuja
    // exclusão ainda não foi confirmada permanecem no ledger.
    ciclo.galeMessageIds = [];
    ciclo.galeCleanupMessageIds =
        new Set(pendentes);

    return {
        ok: pendentes.length === 0,
        removidos:
            ids.length - pendentes.length,
        pendentes
    };
}

function chaveLimpezaPendente(ciclo) {
    return `${chaveCiclo(ciclo.token, ciclo.chatId, ciclo.nomeRobo)}\n${Number(ciclo.entradaMessageId) || 0}`;
}

function agendarLimpezaPendente(ciclo, rodada = 1) {
    const chave = chaveLimpezaPendente(ciclo);
    limpezasPendentes.set(chave, ciclo);
    const atraso = Math.min(30000, 1000 * (2 ** Math.max(0, rodada - 1)));
    const timer = setTimeout(() => {
        void (async () => {
            const resultado = await limparGales(ciclo);
            if (resultado.ok) {
                limpezasPendentes.delete(chave);
                console.log(
                    `🧹 Telegram: limpeza pendente concluída | chat=${mascararChat(ciclo.chatId)} | `
                    + `robô=${ciclo.nomeRobo || 'n/a'}.`
                );
                return;
            }
            if (rodada < CLEANUP_MAX_ROUNDS) {
                agendarLimpezaPendente(ciclo, rodada + 1);
                return;
            }
            console.error(
                `🚨 Telegram: limpeza de Gale permaneceu pendente após ${CLEANUP_MAX_ROUNDS} rodada(s) | `
                + `chat=${mascararChat(ciclo.chatId)} | robô=${ciclo.nomeRobo || 'n/a'} | `
                + `message_ids=${resultado.pendentes.join(',')}. IDs preservados em memória para diagnóstico.`
            );
        })().catch(erro => {
            console.error(`🚨 Telegram: erro inesperado na limpeza pendente: ${erro.message}`);
            if (rodada < CLEANUP_MAX_ROUNDS) agendarLimpezaPendente(ciclo, rodada + 1);
        });
    }, atraso);
    timer.unref?.();
}

function resultadoSintetico(messageId) {
    return {
        ok: true,
        status: 200,
        corpo: {
            ok: true,
            result: { message_id: Number(messageId) || 0 }
        }
    };
}

async function tratarEntrada(token, payload, init) {
    const nomeRobo = extrairNomeRobo(payload.text);
    const chave = chaveCiclo(token, payload.chat_id, nomeRobo);
    const existente = ciclos.get(chave);
    if (existente) {
        console.warn(
            `🔒 Telegram: NOVA ENTRADA duplicada suprimida para robô ${nomeRobo || 'n/a'} `
            + `em ${mascararChat(payload.chat_id)}; ciclo anterior ainda está ativo.`
        );
        return respostaTelegram(resultadoSintetico(existente.entradaMessageId));
    }

    const politica = await resolverPolitica(payload.text);
    const principal = await telegramApi(token, 'sendMessage', {
        ...payload,
        text: formatarTextoSinal(payload.text, politica),
        reply_markup: botoesSinal(politica)
    }, init?.signal || null);

    if (!principal.ok) return respostaTelegram(principal);

    const messageId = Number(principal.corpo?.result?.message_id) || 0;
    const ciclo = {
        token,
        chatId: payload.chat_id,
        nomeRobo,
        estrategiaNome: extrairNomeEstrategia(payload.text),
        entradaMessageId: messageId,
        galeMessageIds: [],
        galeCleanupMessageIds: new Set(),
        politica,
        placeholdersPromise: Promise.resolve([])
    };
    ciclos.set(chave, ciclo);

    if (politica.conhecida && politica.gales > 0) {
        ciclo.placeholdersPromise = criarMensagensGale(ciclo).catch(erro => {
            console.warn(`⚠️ Telegram: criação de mensagens de Gale falhou: ${erro.message}`);
            return [...ciclo.galeMessageIds];
        });
    }

    return respostaTelegram(principal);
}

async function tratarGale(token, payload) {
    const localizado = encontrarCiclo(token, payload.chat_id, payload.text);
    if (!localizado) return null;
    const { ciclo } = localizado;

    try { await ciclo.placeholdersPromise; } catch (_) {}
    const nivel = nivelGale(payload.text);
    const messageId = ciclo.galeMessageIds[nivel - 1];

    if (messageId && await editarMensagem(ciclo, messageId, payload.text)) {
        return respostaTelegram(resultadoSintetico(messageId));
    }

    const fallback = await telegramApi(token, 'sendMessage', {
        ...payload,
        text: formatarTextoSinal(payload.text, ciclo.politica),
        reply_markup: botoesSinal(ciclo.politica)
    });
    if (fallback.ok && Number(fallback.corpo?.result?.message_id) > 0) {
        const fallbackId =
            registrarMensagemGaleParaLimpeza(
                ciclo,
                fallback.corpo.result.message_id
            );

        ciclo.galeMessageIds[
            nivel - 1
        ] = fallbackId;
    }
    return respostaTelegram(fallback);
}

async function tratarFinal(token, payload) {
    const localizado = encontrarCiclo(token, payload.chat_id, payload.text);
    if (!localizado) return null;
    const { chave, ciclo } = localizado;

    let finalId = ciclo.entradaMessageId;
    const editado = await editarMensagem(ciclo, ciclo.entradaMessageId, payload.text);

    if (!editado) {
        const fallback = await telegramApi(token, 'sendMessage', {
            ...payload,
            text: formatarTextoSinal(payload.text, ciclo.politica),
            reply_markup: botoesSinal(ciclo.politica)
        });
        if (fallback.ok) {
            finalId = Number(fallback.corpo?.result?.message_id) || finalId;
            const exclusaoPrincipal = await excluirMensagem(ciclo, ciclo.entradaMessageId);
            if (!exclusaoPrincipal.ok) {
                console.error(
                    `⚠️ Telegram: mensagem principal antiga não pôde ser removida após fallback | `
                    + `chat=${mascararChat(ciclo.chatId)} | message_id=${ciclo.entradaMessageId}.`
                );
            }
        } else {
            const limpezaFalhaFinal = await limparGales(ciclo);
            ciclos.delete(chave);
            if (!limpezaFalhaFinal.ok) agendarLimpezaPendente(ciclo);
            return respostaTelegram(fallback);
        }
    }

    const limpeza = await limparGales(ciclo);
    ciclos.delete(chave);
    if (!limpeza.ok) agendarLimpezaPendente(ciclo);
    return respostaTelegram(resultadoSintetico(finalId));
}

async function fetchTelegramLifecycle(input, init = {}) {
    const alvo = urlTelegram(input);
    const metodoHttp = String(init?.method || input?.method || 'GET').toUpperCase();
    if (!alvo || metodoHttp !== 'POST') return fetchNativo(input, init);

    const payload = corpoJson(init);
    if (!payload || !payload.chat_id || typeof payload.text !== 'string') {
        return fetchNativo(input, init);
    }

    const tipo = tipoMensagem(payload.text);
    if (!tipo) return fetchNativo(input, init);

    if (tipo === 'ENTRADA') return tratarEntrada(alvo.token, payload, init);

    if (tipo === 'GALE') {
        const resposta = await tratarGale(alvo.token, payload);
        if (resposta) return resposta;
    }

    if (tipo === 'GREEN' || tipo === 'RED') {
        const resposta = await tratarFinal(alvo.token, payload);
        if (resposta) return resposta;
    }

    // Fallback preserva entrega mesmo se não houver ciclo local (ex.: restart durante sinal).
    const politica = await resolverPolitica(payload.text);
    return respostaTelegram(await telegramApi(alvo.token, 'sendMessage', {
        ...payload,
        text: formatarTextoSinal(payload.text, politica),
        reply_markup: botoesSinal(politica)
    }, init?.signal || null));
}

function instalarTelegramSignalLifecycle() {
    if (instalado) return true;
    if (typeof globalThis.fetch !== 'function' || typeof globalThis.Response !== 'function') {
        throw new Error('Runtime Node sem fetch/Response nativos para Telegram');
    }

    fetchNativo = globalThis.fetch.bind(globalThis);
    globalThis.fetch = fetchTelegramLifecycle;
    instalado = true;
    console.log('📨 Telegram: ciclo compacto de sinais ativo | Entrada -> Gale(s) -> edição final.');
    return true;
}

module.exports = { instalarTelegramSignalLifecycle };
