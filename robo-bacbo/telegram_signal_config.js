'use strict';

const mysql = require('mysql2/promise');

const {
    carregarMesaEstrutural
} = require('./strategy_profile_route_support');

const {
    validarEscritaRobo
} = require('./strategy_profile_write_validation');

const {
    parseConfigRobo
} = require('./strategy_profile_policy');

let pool = null;
const cachePreferencias = new Map();
const CACHE_MS = 5000;

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

function parseConfig(valor) {
    if (!valor) return {};
    if (typeof valor === 'object' && !Array.isArray(valor)) return { ...valor };
    try {
        const parsed = JSON.parse(String(valor));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
        return {};
    }
}

function tem(config, chave) {
    return Object.prototype.hasOwnProperty.call(config || {}, chave);
}

function preferenciasDoConfig(configBruto) {
    const config = parseConfig(configBruto);
    return {
        nomeRobo: tem(config, 'telegram_nome_robo')
            ? config.telegram_nome_robo !== false
            : true,
        nomeEstrategia: tem(config, 'telegram_nome_estrategia')
            ? config.telegram_nome_estrategia !== false
            : config.mostrar_nome !== false,
        padrao: tem(config, 'telegram_padrao')
            ? config.telegram_padrao !== false
            : config.mostrar_padrao !== false,
        assertividadeGeral: tem(config, 'telegram_assertividade_geral')
            ? config.telegram_assertividade_geral !== false
            : config.mostrar_assertividade !== false,
        assertividade24h: tem(config, 'telegram_assertividade_24h')
            ? config.telegram_assertividade_24h === true
            : false,
        detalharEmpates: tem(config, 'telegram_detalhar_empates')
            ? config.telegram_detalhar_empates !== false
            : config.detalhar_empates !== false
    };
}

function normalizarConfig(configBruto) {
    const config = parseConfig(configBruto);
    const prefs = preferenciasDoConfig(config);

    const normalizado = {
        ...config,
        telegram_nome_robo: prefs.nomeRobo,
        telegram_nome_estrategia: prefs.nomeEstrategia,
        telegram_padrao: prefs.padrao,
        telegram_assertividade_geral: prefs.assertividadeGeral,
        telegram_assertividade_24h: prefs.assertividade24h,
        telegram_detalhar_empates: prefs.detalharEmpates,

        // O builder interno deve sempre carregar contexto completo.
        // O presenter é o único responsável por ocultar campos visuais.
        mostrar_nome: true,
        mostrar_padrao: true,
        mostrar_assertividade: true,
        detalhar_empates: true
    };

    return {
        config: normalizado,
        preferencias: prefs,
        alterado: JSON.stringify(config) !== JSON.stringify(normalizado)
    };
}

function validarMigracaoConfigTelegram({
    row,
    estado
}) {
    const parsed =
        parseConfigRobo(
            row?.config_json
        );

    if (!parsed.ok) {
        return Object.freeze({
            ok: false,
            status: 409,

            body: Object.freeze({
                sucesso: false,
                erro:
                    'TELEGRAM_CONFIG_ESTRUTURAL_INDETERMINADA',

                robo_id:
                    Number(row?.id),

                motivo:
                    parsed.reason
            })
        });
    }

    const normalizado =
        normalizarConfig(
            parsed.config
        );

    if (!normalizado.alterado) {
        return Object.freeze({
            ok: true,
            alterado: false,
            config:
                parsed.config
        });
    }

    const validacao =
        validarEscritaRobo({
            roboId:
                Number(row?.id),

            mesaId:
                Number(row?.mesa_id),

            config:
                normalizado.config,

            origens:
                estado?.origens,

            estrategias:
                estado?.estrategias
        });

    if (!validacao.ok) {
        return Object.freeze({
            ok: false,
            status:
                validacao.status,

            body:
                validacao.body
        });
    }

    return Object.freeze({
        ok: true,
        alterado: true,
        config:
            normalizado.config
    });
}

function invalidarCache() {
    cachePreferencias.clear();
}

async function migrarConfiguracoesTelegram() {
    const db = dbPool();
    let conexao = null;

    try {
        const [linhas] =
            await db.query(
                'SELECT id, mesa_id, config_json FROM robos_canais ORDER BY id ASC'
            );

        const estadosPorMesa =
            new Map();

        const alteracoes = [];

        for (const row of linhas) {
            const mesaId =
                Number(row.mesa_id);

            if (
                !Number.isInteger(mesaId)
                || mesaId <= 0
            ) {
                const erro =
                    new Error(
                        'TELEGRAM_CONFIG_MESA_INVALIDA'
                    );

                erro.code =
                    'TELEGRAM_CONFIG_MESA_INVALIDA';

                erro.robo_id =
                    Number(row.id);

                throw erro;
            }

            if (
                !estadosPorMesa.has(mesaId)
            ) {
                const estado =
                    await carregarMesaEstrutural({
                        dbPool: db,
                        mesaId
                    });

                estadosPorMesa.set(
                    mesaId,
                    estado
                );
            }

            const validacao =
                validarMigracaoConfigTelegram({
                    row,

                    estado:
                        estadosPorMesa.get(
                            mesaId
                        )
                });

            if (!validacao.ok) {
                const erro =
                    new Error(
                        String(
                            validacao.body?.erro
                            || 'TELEGRAM_CONFIG_ESTRUTURAL_INVALIDA'
                        )
                    );

                erro.code =
                    String(
                        validacao.body?.erro
                        || 'TELEGRAM_CONFIG_ESTRUTURAL_INVALIDA'
                    );

                erro.detalhe =
                    validacao.body;

                throw erro;
            }

            if (
                !validacao.alterado
            ) {
                continue;
            }

            alteracoes.push({
                id:
                    Number(row.id),

                mesa_id:
                    mesaId,

                config:
                    validacao.config
            });
        }

        if (
            alteracoes.length === 0
        ) {
            return 0;
        }

        conexao =
            await db.getConnection();

        await conexao.beginTransaction();

        for (const item of alteracoes) {
            const [resultado] =
                await conexao.query(
                    'UPDATE robos_canais SET config_json=? WHERE id=? AND mesa_id=?',
                    [
                        JSON.stringify(
                            item.config
                        ),

                        item.id,
                        item.mesa_id
                    ]
                );

            if (
                Number(
                    resultado.affectedRows
                ) !== 1
            ) {
                throw new Error(
                    'TELEGRAM_CONFIG_ROBO_MUDOU_DURANTE_MIGRACAO'
                );
            }
        }

        await conexao.commit();

        invalidarCache();

        console.log(
            `📨 Telegram: preferências visuais normalizadas | ${alteracoes.length} robô(s).`
        );

        return alteracoes.length;
    }
    catch (erro) {
        if (conexao) {
            try {
                await conexao.rollback();
            }
            catch (_) {}
        }

        if (
            erro
            && (
                erro.code ===
                    'ER_NO_SUCH_TABLE'

                || Number(
                    erro.errno
                ) === 1146
            )
        ) {
            return 0;
        }

        throw erro;
    }
    finally {
        if (conexao) {
            conexao.release();
        }
    }
}

async function buscarLinhaRobo(nomeRobo, chatId) {
    const nome = String(nomeRobo || '').trim();
    const chat = String(chatId || '').trim();
    if (!nome) return null;

    const db = dbPool();

    if (chat) {
        const [linhas] = await db.query(
            `SELECT r.id, r.config_json
             FROM robos_canais r
             LEFT JOIN destinatarios_robo d ON d.robo_id = r.id
             WHERE r.nome=? AND (r.telegram_chat_id=? OR d.chat_id=?)
             ORDER BY CASE WHEN r.telegram_chat_id=? THEN 0 ELSE 1 END, r.id ASC
             LIMIT 1`,
            [nome, chat, chat, chat]
        );
        if (linhas.length > 0) return linhas[0];
    }

    const [fallback] = await db.query(
        'SELECT id, config_json FROM robos_canais WHERE nome=? ORDER BY id ASC LIMIT 1',
        [nome]
    );
    return fallback[0] || null;
}

async function resolverPreferencias(nomeRobo, chatId) {
    const chave = `${String(nomeRobo || '').trim()}\n${String(chatId || '').trim()}`;
    const agora = Date.now();
    const cached = cachePreferencias.get(chave);
    if (cached && agora - cached.em < CACHE_MS) return cached.valor;

    try {
        const row = await buscarLinhaRobo(nomeRobo, chatId);
        const valor = row
            ? preferenciasDoConfig(row.config_json)
            : preferenciasDoConfig({});
        cachePreferencias.set(chave, { em: agora, valor });
        return valor;
    } catch (erro) {
        console.warn(`⚠️ Telegram: não foi possível carregar preferências visuais do robô: ${erro.message}`);
        return preferenciasDoConfig({});
    }
}

module.exports = {
    validarMigracaoConfigTelegram,
    migrarConfiguracoesTelegram,
    resolverPreferencias,
    preferenciasDoConfig,
    normalizarConfig,
    invalidarCache
};
