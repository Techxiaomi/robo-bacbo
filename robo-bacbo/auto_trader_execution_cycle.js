'use strict';

const TIPOS_AMOSTRAGEM = new Set(['NENHUMA', 'PULOS_RANDOMICOS', 'PROBABILIDADE']);
const LIMITE_CONTADOR = 1_000_000;
const LIMITE_PULOS = 1000;

function objetoSeguro(valor) {
    return valor && typeof valor === 'object' && !Array.isArray(valor) ? valor : {};
}

function inteiroNoIntervalo(valor, minimo, maximo) {
    return typeof valor === 'number'
        && Number.isFinite(valor)
        && Number.isInteger(valor)
        && valor >= minimo
        && valor <= maximo;
}

function inteiroOuPadrao(valor, padrao, minimo = 0, maximo = LIMITE_CONTADOR) {
    return inteiroNoIntervalo(valor, minimo, maximo) ? valor : padrao;
}

function normalizarConfigEstrategiaExecucao(config) {
    const origem = objetoSeguro(config);
    const base = { ...origem };
    const tipoLegado = String(origem.modo_camuflagem || '').toUpperCase() === 'PULOS'
        ? 'PULOS_RANDOMICOS'
        : 'NENHUMA';
    const tipoRecebido = String(origem.tipo_amostragem || '').trim().toUpperCase();
    const tipo = TIPOS_AMOSTRAGEM.has(tipoRecebido) ? tipoRecebido : tipoLegado;

    const puloMinLegado = inteiroOuPadrao(origem.camuflagem_pulos_min, 1, 1, LIMITE_PULOS);
    const puloMaxLegado = inteiroOuPadrao(origem.camuflagem_pulos_max, Math.max(3, puloMinLegado), 1, LIMITE_PULOS);
    const puloMin = inteiroOuPadrao(origem.pulo_min, puloMinLegado, 1, LIMITE_PULOS);
    const puloMaxBruto = inteiroOuPadrao(origem.pulo_max, puloMaxLegado, 1, LIMITE_PULOS);
    const puloMax = Math.max(puloMin, puloMaxBruto);

    base.gatilho_falhas_monitor = inteiroOuPadrao(origem.gatilho_falhas_monitor, 0);
    base.tamanho_lote_processamento = inteiroOuPadrao(origem.tamanho_lote_processamento, 0);
    base.tipo_amostragem = tipo;
    base.chance_execucao_pct = tipo === 'PROBABILIDADE'
        ? inteiroOuPadrao(origem.chance_execucao_pct, 100, 1, 100)
        : 100;
    base.limite_ciclos_sessao = inteiroOuPadrao(origem.limite_ciclos_sessao, 0);
    base.pulo_min = puloMin;
    base.pulo_max = puloMax;

    delete base.modo_camuflagem;
    delete base.camuflagem_pulos_min;
    delete base.camuflagem_pulos_max;

    return {
        config: base,
        alterado: JSON.stringify(base) !== JSON.stringify(origem)
    };
}

function validarConfiguracaoEstrategiaExecucao(config) {
    const origem = objetoSeguro(config);
    const possui = campo => Object.prototype.hasOwnProperty.call(origem, campo);

    if (possui('gatilho_falhas_monitor')
        && !inteiroNoIntervalo(origem.gatilho_falhas_monitor, 0, LIMITE_CONTADOR)) {
        return { ok: false, campo: 'gatilho_falhas_monitor', motivo: 'deve ser inteiro entre 0 e 1000000' };
    }
    if (possui('tamanho_lote_processamento')
        && !inteiroNoIntervalo(origem.tamanho_lote_processamento, 0, LIMITE_CONTADOR)) {
        return { ok: false, campo: 'tamanho_lote_processamento', motivo: 'deve ser inteiro entre 0 e 1000000' };
    }
    if (possui('limite_ciclos_sessao')
        && !inteiroNoIntervalo(origem.limite_ciclos_sessao, 0, LIMITE_CONTADOR)) {
        return { ok: false, campo: 'limite_ciclos_sessao', motivo: 'deve ser inteiro entre 0 e 1000000' };
    }

    if (possui('tipo_amostragem')) {
        const tipo = String(origem.tipo_amostragem || '').trim().toUpperCase();
        if (!TIPOS_AMOSTRAGEM.has(tipo)) {
            return { ok: false, campo: 'tipo_amostragem', motivo: 'deve ser NENHUMA, PULOS_RANDOMICOS ou PROBABILIDADE' };
        }
    }

    const normalizada = normalizarConfigEstrategiaExecucao(origem).config;
    if (normalizada.tipo_amostragem === 'PULOS_RANDOMICOS') {
        const puloMinRecebido = possui('pulo_min') ? origem.pulo_min : origem.camuflagem_pulos_min;
        const puloMaxRecebido = possui('pulo_max') ? origem.pulo_max : origem.camuflagem_pulos_max;
        if (!inteiroNoIntervalo(puloMinRecebido, 1, LIMITE_PULOS)) {
            return { ok: false, campo: possui('pulo_min') ? 'pulo_min' : 'camuflagem_pulos_min', motivo: 'deve ser inteiro entre 1 e 1000' };
        }
        if (!inteiroNoIntervalo(puloMaxRecebido, puloMinRecebido, LIMITE_PULOS)) {
            return { ok: false, campo: possui('pulo_max') ? 'pulo_max' : 'camuflagem_pulos_max', motivo: 'deve ser inteiro maior ou igual ao mínimo e menor ou igual a 1000' };
        }
    }

    if (normalizada.tipo_amostragem === 'PROBABILIDADE') {
        if (!inteiroNoIntervalo(origem.chance_execucao_pct, 1, 100)) {
            return { ok: false, campo: 'chance_execucao_pct', motivo: 'deve ser inteiro entre 1 e 100 quando a amostragem for PROBABILIDADE' };
        }
    }

    return { ok: true, campo: null, motivo: null };
}

function camposPersistenciaEstrategiaExecucao(config) {
    const cf = normalizarConfigEstrategiaExecucao(config).config;
    return {
        gatilho_falhas_monitor: cf.gatilho_falhas_monitor,
        tamanho_lote_processamento: cf.tamanho_lote_processamento,
        tipo_amostragem: cf.tipo_amostragem,
        chance_execucao_pct: cf.chance_execucao_pct,
        limite_ciclos_sessao: cf.limite_ciclos_sessao
    };
}

async function persistirParametrosCicloAutoTrader(dbPool, traderId, config) {
    const campos = camposPersistenciaEstrategiaExecucao(config);
    await dbPool.query(
        `UPDATE auto_traders
         SET gatilho_falhas_monitor=?, tamanho_lote_processamento=?, tipo_amostragem=?,
             chance_execucao_pct=?, limite_ciclos_sessao=?
         WHERE id=?`,
        [
            campos.gatilho_falhas_monitor,
            campos.tamanho_lote_processamento,
            campos.tipo_amostragem,
            campos.chance_execucao_pct,
            campos.limite_ciclos_sessao,
            traderId
        ]
    );
    return campos;
}

async function migrarConfiguracoesLegadasExecucao(dbPool) {
    const [linhas] = await dbPool.query('SELECT id, config_json FROM auto_traders ORDER BY id ASC');
    let migradas = 0;

    for (const linha of linhas) {
        let config = {};
        try {
            config = JSON.parse(linha.config_json || '{}');
        } catch (erro) {
            console.warn(`⚠️ Auto-Trader ${linha.id}: config_json inválido; migração de Estratégia de Execução ignorada.`);
            continue;
        }

        const normalizacao = normalizarConfigEstrategiaExecucao(config);
        const campos = camposPersistenciaEstrategiaExecucao(normalizacao.config);
        await dbPool.query(
            `UPDATE auto_traders
             SET config_json=?, gatilho_falhas_monitor=?, tamanho_lote_processamento=?, tipo_amostragem=?,
                 chance_execucao_pct=?, limite_ciclos_sessao=?
             WHERE id=?`,
            [
                JSON.stringify(normalizacao.config),
                campos.gatilho_falhas_monitor,
                campos.tamanho_lote_processamento,
                campos.tipo_amostragem,
                campos.chance_execucao_pct,
                campos.limite_ciclos_sessao,
                linha.id
            ]
        );
        if (normalizacao.alterado) migradas++;
    }

    if (migradas > 0) {
        console.log(`🔄 Estratégia de Execução: ${migradas} configuração(ões) legada(s) migrada(s).`);
    }
    return migradas;
}

function criarControleEstrategiaExecucao({ dbPool }) {
    const estados = new Map();

    function assinaturaConfig(config) {
        const cf = normalizarConfigEstrategiaExecucao(config).config;
        return JSON.stringify({
            gatilho_falhas_monitor: cf.gatilho_falhas_monitor,
            tamanho_lote_processamento: cf.tamanho_lote_processamento,
            tipo_amostragem: cf.tipo_amostragem,
            chance_execucao_pct: cf.chance_execucao_pct,
            limite_ciclos_sessao: cf.limite_ciclos_sessao,
            pulo_min: cf.pulo_min,
            pulo_max: cf.pulo_max
        });
    }

    function criarEstado(trader) {
        const normalizacao = normalizarConfigEstrategiaExecucao(trader?.config || {});
        if (trader) trader.config = normalizacao.config;
        const gatilho = normalizacao.config.gatilho_falhas_monitor;
        return {
            ativo: Boolean(trader?.ativo),
            assinatura: assinaturaConfig(normalizacao.config),
            fase: gatilho === 0 ? 'PROCESSAMENTO' : 'MONITORAMENTO',
            falhas_monitoradas: 0,
            sinais_operados_lote: 0,
            ciclos_concluidos: 0,
            pulos_restantes: 0,
            sequencia_decisao: 0,
            ultima_decisao_confirmada: 0,
            ignorar_proximo_resultado: false
        };
    }

    function sincronizarTrader(trader) {
        if (!trader || trader.id === undefined || trader.id === null) return null;
        const id = String(trader.id);
        const normalizacao = normalizarConfigEstrategiaExecucao(trader.config || {});
        trader.config = normalizacao.config;
        const assinatura = assinaturaConfig(normalizacao.config);
        const existente = estados.get(id);

        if (!existente || existente.assinatura !== assinatura || (!existente.ativo && trader.ativo)) {
            const novo = criarEstado(trader);
            estados.set(id, novo);
            trader.pulos_restantes = 0;
            return novo;
        }

        existente.ativo = Boolean(trader.ativo);
        if (!trader.ativo) {
            existente.pulos_restantes = 0;
            trader.pulos_restantes = 0;
        } else {
            trader.pulos_restantes = existente.pulos_restantes;
        }
        return existente;
    }

    function snapshot(trader) {
        const estado = sincronizarTrader(trader);
        return estado ? {
            fase: estado.fase,
            falhas_monitoradas: estado.falhas_monitoradas,
            sinais_operados_lote: estado.sinais_operados_lote,
            ciclos_concluidos: estado.ciclos_concluidos,
            pulos_restantes: estado.pulos_restantes
        } : null;
    }

    function registrarResultadoMonitorado(trader, tipoResultado) {
        const estado = sincronizarTrader(trader);
        if (!estado || !trader.ativo) return snapshot(trader);

        if (estado.ignorar_proximo_resultado) {
            estado.ignorar_proximo_resultado = false;
            return snapshot(trader);
        }

        if (estado.fase !== 'MONITORAMENTO') return snapshot(trader);
        const cf = trader.config;
        const gatilho = cf.gatilho_falhas_monitor;
        if (gatilho === 0) {
            estado.fase = 'PROCESSAMENTO';
            estado.falhas_monitoradas = 0;
            return snapshot(trader);
        }

        const tipo = String(tipoResultado || '').trim().toUpperCase();
        if (!['RED', 'LOSS', 'FALHA'].includes(tipo)) return snapshot(trader);

        estado.falhas_monitoradas++;
        if (estado.falhas_monitoradas >= gatilho) {
            estado.fase = 'PROCESSAMENTO';
            estado.falhas_monitoradas = 0;
            estado.sinais_operados_lote = 0;
            estado.pulos_restantes = 0;
            trader.pulos_restantes = 0;
            console.log(`▶️ Auto-Trader ${trader.id}: gatilho de ${gatilho} falha(s) atingido; lote de processamento iniciado.`);
        }
        return snapshot(trader);
    }

    function sortearPulos(cf) {
        const minimo = Math.max(1, Number(cf.pulo_min) || 1);
        const maximo = Math.max(minimo, Number(cf.pulo_max) || minimo);
        return Math.floor(Math.random() * (maximo - minimo + 1)) + minimo;
    }

    function prepararEntrada(trader) {
        const estado = sincronizarTrader(trader);
        if (!estado || !trader.ativo) {
            return { permitido: false, motivo: 'INATIVO', estado: snapshot(trader) };
        }

        const cf = trader.config;
        if (estado.fase !== 'PROCESSAMENTO') {
            return { permitido: false, motivo: 'MONITORAMENTO', estado: snapshot(trader) };
        }

        if (cf.tipo_amostragem === 'PULOS_RANDOMICOS') {
            if (estado.pulos_restantes > 0) {
                estado.pulos_restantes--;
                trader.pulos_restantes = estado.pulos_restantes;
                return { permitido: false, motivo: 'PULO_RANDOMICO', estado: snapshot(trader) };
            }
            estado.pulos_restantes = sortearPulos(cf);
            trader.pulos_restantes = estado.pulos_restantes;
        } else if (cf.tipo_amostragem === 'PROBABILIDADE') {
            const chance = Math.max(1, Math.min(100, Number(cf.chance_execucao_pct) || 100));
            const sorteio = Math.floor(Math.random() * 100) + 1;
            if (sorteio > chance) {
                return { permitido: false, motivo: `PROBABILIDADE_${sorteio}>${chance}`, estado: snapshot(trader) };
            }
        }

        estado.sequencia_decisao++;
        return {
            permitido: true,
            motivo: null,
            sequencia_decisao: estado.sequencia_decisao,
            estado: snapshot(trader)
        };
    }

    async function confirmarEntradaExecutada(trader, decisao) {
        const estado = sincronizarTrader(trader);
        if (!estado || !trader.ativo || !decisao?.permitido) {
            return { ciclo_concluido: false, auto_desativado: false, estado: snapshot(trader) };
        }

        const sequencia = Number(decisao.sequencia_decisao) || 0;
        if (sequencia <= estado.ultima_decisao_confirmada) {
            return { ciclo_concluido: false, auto_desativado: false, duplicada: true, estado: snapshot(trader) };
        }
        estado.ultima_decisao_confirmada = sequencia;
        estado.sinais_operados_lote++;

        const cf = trader.config;
        const tamanhoLote = cf.tamanho_lote_processamento;
        if (tamanhoLote === 0 || estado.sinais_operados_lote < tamanhoLote) {
            return { ciclo_concluido: false, auto_desativado: false, estado: snapshot(trader) };
        }

        estado.ciclos_concluidos++;
        estado.sinais_operados_lote = 0;
        estado.falhas_monitoradas = 0;
        estado.pulos_restantes = 0;
        trader.pulos_restantes = 0;

        const limiteCiclos = cf.limite_ciclos_sessao;
        if (limiteCiclos > 0 && estado.ciclos_concluidos >= limiteCiclos) {
            await dbPool.query(
                `UPDATE auto_traders
                 SET ativo=false, status_operacao='LIMITE_CICLOS', pulos_restantes=0
                 WHERE id=?`,
                [trader.id]
            );
            trader.ativo = false;
            trader.status_operacao = 'LIMITE_CICLOS';
            estado.ativo = false;
            console.log(`🛑 Auto-Trader ${trader.id}: limite de ${limiteCiclos} ciclo(s) concluído(s); motor auto-desativado.`);
            return { ciclo_concluido: true, auto_desativado: true, estado: snapshot(trader) };
        }

        estado.fase = cf.gatilho_falhas_monitor === 0 ? 'PROCESSAMENTO' : 'MONITORAMENTO';
        estado.ignorar_proximo_resultado = true;
        console.log(`🔄 Auto-Trader ${trader.id}: ciclo ${estado.ciclos_concluidos} concluído; estado=${estado.fase}.`);
        return { ciclo_concluido: true, auto_desativado: false, estado: snapshot(trader) };
    }

    function removerTrader(traderId) {
        return estados.delete(String(traderId));
    }

    return {
        sincronizarTrader,
        snapshot,
        registrarResultadoMonitorado,
        prepararEntrada,
        confirmarEntradaExecutada,
        removerTrader
    };
}

module.exports = {
    TIPOS_AMOSTRAGEM,
    normalizarConfigEstrategiaExecucao,
    validarConfiguracaoEstrategiaExecucao,
    camposPersistenciaEstrategiaExecucao,
    persistirParametrosCicloAutoTrader,
    migrarConfiguracoesLegadasExecucao,
    criarControleEstrategiaExecucao
};
