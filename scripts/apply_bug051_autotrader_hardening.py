from pathlib import Path

BOT = Path('robo-bacbo/bot2_coletor.js')
UI = Path('robo-bacbo/public/index.html')
TEST = Path('robo-bacbo/test/bug051-contract.test.js')

bot = BOT.read_text(encoding='utf-8')
ui = UI.read_text(encoding='utf-8')


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: esperado 1, encontrado {count}')
    return text.replace(old, new, 1)


def replace_count(text, old, new, expected, label):
    count = text.count(old)
    if count != expected:
        raise RuntimeError(f'{label}: esperado {expected}, encontrado {count}')
    return text.replace(old, new)

# ---------------------------------------------------------------------
# 1) Banco: ciclo financeiro explícito, contador diário e saldo real
# pós-liquidação comprovado por sincronização posterior ao resultado.
# ---------------------------------------------------------------------
bot = replace_once(
    bot,
    "                entradas_feitas INT DEFAULT 0,\n                pulos_restantes INT DEFAULT 0,",
    "                entradas_feitas INT DEFAULT 0,\n                entradas_data VARCHAR(10) DEFAULT NULL,\n                pulos_restantes INT DEFAULT 0,",
    'auto_traders entradas_data create'
)

bot = replace_once(
    bot,
    "                trader_id INT,\n                estrategia_nome VARCHAR(100),",
    "                trader_id INT,\n                ciclo_id VARCHAR(64) DEFAULT NULL,\n                estrategia_id VARCHAR(100) DEFAULT NULL,\n                estrategia_nome VARCHAR(100),",
    'auditoria ciclo create'
)

bot = replace_once(
    bot,
    "                lucro_prejuizo DECIMAL(12,2) DEFAULT 0,\n                saldo_pos DECIMAL(12,2) DEFAULT 0,\n                data_hora DATETIME DEFAULT CURRENT_TIMESTAMP,",
    "                lucro_prejuizo DECIMAL(12,2) DEFAULT 0,\n                saldo_pos DECIMAL(12,2) DEFAULT NULL,\n                resultado_confirmado_em BIGINT DEFAULT NULL,\n                saldo_pos_confirmado_em BIGINT DEFAULT NULL,\n                ciclo_finalizado BOOLEAN DEFAULT false,\n                data_hora DATETIME DEFAULT CURRENT_TIMESTAMP,",
    'auditoria saldo pos create'
)

anchor_migrations = "        await adicionarColuna(\"ALTER TABLE auditoria_ordens ADD COLUMN execucao_confirmada_em BIGINT DEFAULT NULL\");\n        await adicionarColuna(\"ALTER TABLE auto_traders ADD COLUMN reds_consecutivos INT DEFAULT 0\");"
replacement_migrations = "        await adicionarColuna(\"ALTER TABLE auditoria_ordens ADD COLUMN execucao_confirmada_em BIGINT DEFAULT NULL\");\n        await adicionarColuna(\"ALTER TABLE auditoria_ordens ADD COLUMN ciclo_id VARCHAR(64) DEFAULT NULL\");\n        await adicionarColuna(\"ALTER TABLE auditoria_ordens ADD COLUMN estrategia_id VARCHAR(100) DEFAULT NULL\");\n        await adicionarColuna(\"ALTER TABLE auditoria_ordens ADD COLUMN resultado_confirmado_em BIGINT DEFAULT NULL\");\n        await adicionarColuna(\"ALTER TABLE auditoria_ordens ADD COLUMN saldo_pos_confirmado_em BIGINT DEFAULT NULL\");\n        await adicionarColuna(\"ALTER TABLE auditoria_ordens ADD COLUMN ciclo_finalizado BOOLEAN DEFAULT false\");\n        await adicionarColuna(\"ALTER TABLE auto_traders ADD COLUMN entradas_data VARCHAR(10) DEFAULT NULL\");\n        await adicionarColuna(\"ALTER TABLE auto_traders ADD COLUMN reds_consecutivos INT DEFAULT 0\");"
bot = replace_once(bot, anchor_migrations, replacement_migrations, 'migrations BUG051')

# ---------------------------------------------------------------------
# 2) Saldo: mantém heartbeat geral de 90s para UI, mas autorização financeira
# exige amostra muito recente (default 5s).
# ---------------------------------------------------------------------
old_balance_const = "const BALANCE_SYNC_MAX_AGE_MS = (\n    Number.isFinite(balanceSyncMaxAgeSecondsConfig) && balanceSyncMaxAgeSecondsConfig >= 5\n        ? balanceSyncMaxAgeSecondsConfig\n        : 90\n) * 1000;"
new_balance_const = old_balance_const + "\nconst entryBalanceMaxAgeSecondsConfig = Number(process.env.AUTO_TRADER_BALANCE_MAX_AGE_SECONDS || 5);\nconst AUTO_TRADER_BALANCE_MAX_AGE_MS = (\n    Number.isFinite(entryBalanceMaxAgeSecondsConfig)\n    && entryBalanceMaxAgeSecondsConfig >= 2\n    && entryBalanceMaxAgeSecondsConfig <= 15\n        ? entryBalanceMaxAgeSecondsConfig\n        : 5\n) * 1000;\nconst OPERATION_TIME_ZONE = String(process.env.OPERATION_TIME_ZONE || 'America/Sao_Paulo').trim() || 'America/Sao_Paulo';"
bot = replace_once(bot, old_balance_const, new_balance_const, 'strict balance age')

old_obter = "function obterSaldoGlobalFresco(agora = Date.now()) {\n    const snapshot = snapshotSaldoGlobal(agora);\n    return snapshot.fresco ? snapshot.saldo_atual : null;\n}"
new_obter = "function obterSaldoGlobalFresco(agora = Date.now()) {\n    const snapshot = snapshotSaldoGlobal(agora);\n    const idadeMs = Number(snapshot.idade_ms);\n    return snapshot.fresco\n        && Number.isFinite(idadeMs)\n        && idadeMs <= AUTO_TRADER_BALANCE_MAX_AGE_MS\n        ? snapshot.saldo_atual\n        : null;\n}"
bot = replace_once(bot, old_obter, new_obter, 'strict activation balance')

# ---------------------------------------------------------------------
# 3) Intenção financeira ganha ciclo_id + estrategia_id.
# ---------------------------------------------------------------------
old_intencao = "        `INSERT INTO auditoria_ordens\n            (trader_id, estrategia_nome, fonte_sinal, alvo, nivel, risco_total,\n             valor_entrada, valor_empate, executor_order_id, status_ordem)\n         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PREPARANDO')`,\n        [\n            dados.trader_id,\n            dados.estrategia_nome,"
new_intencao = "        `INSERT INTO auditoria_ordens\n            (trader_id, ciclo_id, estrategia_id, estrategia_nome, fonte_sinal, alvo, nivel, risco_total,\n             valor_entrada, valor_empate, executor_order_id, status_ordem)\n         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PREPARANDO')`,\n        [\n            dados.trader_id,\n            String(dados.ciclo_id || ''),\n            String(dados.estrategia_id || ''),\n            dados.estrategia_nome,"
bot = replace_once(bot, old_intencao, new_intencao, 'criarIntencao ciclo')

# ---------------------------------------------------------------------
# 4) Horário operacional, validação forte de configuração e reset diário.
# ---------------------------------------------------------------------
insert_before_horario = r'''function partesDataOperacional(agora = new Date()) {
    const data = agora instanceof Date ? agora : new Date(agora);
    const referencia = Number.isNaN(data.getTime()) ? new Date() : data;
    const partes = new Intl.DateTimeFormat('en-CA', {
        timeZone: OPERATION_TIME_ZONE,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(referencia);
    const mapa = Object.fromEntries(partes.map(item => [item.type, item.value]));
    return {
        data: `${mapa.year}-${mapa.month}-${mapa.day}`,
        hora: Number(mapa.hour),
        minuto: Number(mapa.minute)
    };
}

function chaveDataOperacional(agora = new Date()) {
    return partesDataOperacional(agora).data;
}

function horaOperacionalTexto(agora = new Date()) {
    const partes = partesDataOperacional(agora);
    return `${String(partes.hora).padStart(2, '0')}:${String(partes.minuto).padStart(2, '0')}`;
}

function validarConfigAutoTrader(config) {
    const cf = config && typeof config === 'object' ? config : {};
    const politicaEmpate = validarPoliticaProtecao(cf);
    if (!politicaEmpate.ok) return { ok: false, motivo: politicaEmpate.motivo };

    const numero = (nome, valor, minimo, maximo, inteiro = false) => {
        const n = Number(valor);
        if (!Number.isFinite(n) || n < minimo || n > maximo || (inteiro && !Number.isInteger(n))) {
            return `${nome} inválido`;
        }
        return null;
    };

    const erros = [
        numero('stake_inicial', cf.stake_inicial ?? 10, 0.01, 1000000),
        numero('gale_1_mult', cf.gale_1_mult ?? 2, 1, 100),
        numero('gale_2_mult', cf.gale_2_mult ?? 4, 1, 100),
        numero('limite_entradas', cf.limite_entradas ?? 15, 1, 100000, true),
        numero('stop_win', cf.stop_win ?? 100, 0, 100000000),
        numero('stop_loss', cf.stop_loss ?? 250, 0, 100000000),
        numero('trailing_recuo', cf.trailing_recuo ?? 0, 0, 100000000),
        numero('stop_reds_seguidos', cf.stop_reds_seguidos ?? 0, 0, 1000, true),
        numero('stop_reds_pausa_min', cf.stop_reds_pausa_min ?? 60, 1, 10080, true)
    ].filter(Boolean);

    const modo = String(cf.modo_camuflagem || 'TODAS').toUpperCase();
    if (!['TODAS', 'PULOS'].includes(modo)) erros.push('modo_camuflagem inválido');
    if (modo === 'PULOS') {
        const min = Number(cf.camuflagem_pulos_min ?? 1);
        const max = Number(cf.camuflagem_pulos_max ?? 3);
        if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min || max > 1000) {
            erros.push('intervalo de pulos inválido');
        }
    }

    if (horarioParaMinutos(cf.hora_inicio, '00:00') === null || horarioParaMinutos(cf.hora_fim, '23:59') === null) {
        erros.push('horário operacional inválido');
    }
    if (cf.fontes_sinal !== undefined && !Array.isArray(cf.fontes_sinal)) {
        erros.push('fontes_sinal deve ser uma lista');
    }

    return erros.length > 0 ? { ok: false, motivo: erros.join('; ') } : { ok: true, motivo: null };
}

async function rearmarContadoresDiariosAutoTraders(agora = new Date()) {
    const dataHoje = chaveDataOperacional(agora);
    const candidatos = AUTO_TRADERS_MEMORIA.filter(trader => trader.ativo && String(trader.entradas_data || '') !== dataHoje);
    if (candidatos.length === 0) return 0;

    for (const trader of candidatos) {
        const novoStatus = trader.status_operacao === 'META_ATINGIDA' ? 'STANDBY' : trader.status_operacao;
        await dbPool.query(
            `UPDATE auto_traders
             SET entradas_feitas=0, pulos_restantes=0, entradas_data=?, status_operacao=?
             WHERE id=? AND ativo=true`,
            [dataHoje, novoStatus, trader.id]
        );
        trader.entradas_feitas = 0;
        trader.pulos_restantes = 0;
        trader.entradas_data = dataHoje;
        trader.status_operacao = novoStatus;
        console.log(`📅 Auto-Trader ${trader.id}: novo dia operacional ${dataHoje}; contador de ciclos reiniciado.`);
    }
    ioServer.emit('atualizar_interface');
    return candidatos.length;
}

'''
bot = replace_once(bot, "function traderDentroHorarioExecucao(config, agora = new Date()) {", insert_before_horario + "function traderDentroHorarioExecucao(config, agora = new Date()) {", 'insert operational helpers')

old_minute = "    const minutoAtual = (agora.getHours() * 60) + agora.getMinutes();"
new_minute = "    const minutoAtual = agora && typeof agora.getHours === 'function' && !(agora instanceof Date)\n        ? (agora.getHours() * 60) + agora.getMinutes()\n        : (() => { const p = partesDataOperacional(agora); return (p.hora * 60) + p.minuto; })();"
bot = replace_once(bot, old_minute, new_minute, 'operational timezone in schedule')

# Configuração é validada sempre, não apenas ao ativar.
old_policy = "        if (novoAtivo) {\n            const politicaEmpate = validarPoliticaProtecao(config || {});\n            if (!politicaEmpate.ok) {\n                return res.status(400).json({ sucesso: false, erro: 'protecao_empate_invalida', mensagem: politicaEmpate.motivo });\n            }\n        }"
new_policy = "        const validacaoConfig = validarConfigAutoTrader(config || {});\n        if (!validacaoConfig.ok) {\n            return res.status(400).json({\n                sucesso: false,\n                erro: 'config_auto_trader_invalida',\n                mensagem: validacaoConfig.motivo\n            });\n        }"
bot = replace_count(bot, old_policy, new_policy, 2, 'validacao config POST PUT')

# Create + reactivate passam a marcar a data operacional.
old_insert_at = "            `INSERT INTO auto_traders (nome, ativo, config_json, saldo_inicial, saldo_atual, status_operacao, entradas_feitas, pulos_restantes)\n             VALUES (?, ?, ?, ?, ?, ?, 0, 0)`,\n            [nome, novoAtivo ? 1 : 0, configJson, saldoBaseline, saldoBaseline, statusInicial]"
new_insert_at = "            `INSERT INTO auto_traders (nome, ativo, config_json, saldo_inicial, saldo_atual, status_operacao, entradas_feitas, entradas_data, pulos_restantes)\n             VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0)`,\n            [nome, novoAtivo ? 1 : 0, configJson, saldoBaseline, saldoBaseline, statusInicial, chaveDataOperacional()]"
bot = replace_once(bot, old_insert_at, new_insert_at, 'insert trader data daily')

old_reactivate = "                     status_operacao='STANDBY', entradas_feitas=0, pulos_restantes=0,\n                     reds_consecutivos=0, stop_reds_pausado_ate=0, trailing_pico_lucro=0\n                 WHERE id=?`,\n                [nome, configJson, saldoFresco, saldoFresco, id]"
new_reactivate = "                     status_operacao='STANDBY', entradas_feitas=0, entradas_data=?, pulos_restantes=0,\n                     reds_consecutivos=0, stop_reds_pausado_ate=0, trailing_pico_lucro=0\n                 WHERE id=?`,\n                [nome, configJson, saldoFresco, saldoFresco, chaveDataOperacional(), id]"
bot = replace_once(bot, old_reactivate, new_reactivate, 'reactivate trader data daily')

# GET + memória incluem a chave diária.
bot = replace_once(
    bot,
    "                entradas_feitas: at.entradas_feitas,\n                pulos_restantes: at.pulos_restantes,",
    "                entradas_feitas: at.entradas_feitas,\n                entradas_data: at.entradas_data || null,\n                pulos_restantes: at.pulos_restantes,",
    'GET trader entradas_data'
)
bot = replace_once(
    bot,
    "                status_operacao: at.status_operacao, entradas_feitas: at.entradas_feitas, pulos_restantes: at.pulos_restantes,",
    "                status_operacao: at.status_operacao, entradas_feitas: at.entradas_feitas, entradas_data: at.entradas_data || null, pulos_restantes: at.pulos_restantes,",
    'memory trader entradas_data'
)

# ---------------------------------------------------------------------
# 5) Saldo pós-liquidação: só heartbeat sem vencedor pode carimbar saldo final.
# Nova entrada é bloqueada enquanto o ciclo anterior não tiver esse saldo.
# ---------------------------------------------------------------------
insert_before_trailing = r'''async function traderPossuiLiquidacaoPendente(traderId) {
    const [linhas] = await dbPool.query(
        `SELECT id, ciclo_id
         FROM auditoria_ordens
         WHERE trader_id=?
           AND ciclo_finalizado=true
           AND status_ordem IN ('WIN','LOSS','TIE')
           AND resultado_confirmado_em IS NOT NULL
           AND saldo_pos_confirmado_em IS NULL
         ORDER BY id DESC LIMIT 1`,
        [traderId]
    );
    return linhas.length > 0 ? linhas[0] : null;
}

async function confirmarSaldosPosLiquidacao(saldo, sincronizadoEm = Date.now()) {
    const saldoNumero = Number(saldo);
    const syncMs = Number(sincronizadoEm);
    if (!Number.isFinite(saldoNumero) || saldoNumero < 0 || !Number.isFinite(syncMs) || syncMs <= 0) return 0;

    const [linhas] = await dbPool.query(
        `SELECT id, trader_id, ciclo_id
         FROM auditoria_ordens
         WHERE ciclo_finalizado=true
           AND status_ordem IN ('WIN','LOSS','TIE')
           AND resultado_confirmado_em IS NOT NULL
           AND resultado_confirmado_em < ?
           AND saldo_pos_confirmado_em IS NULL
         ORDER BY id ASC`,
        [syncMs]
    );
    if (linhas.length === 0) return 0;

    const ids = linhas.map(row => Number(row.id)).filter(Number.isInteger);
    const placeholders = ids.map(() => '?').join(',');
    await dbPool.query(
        `UPDATE auditoria_ordens
         SET saldo_pos=?, saldo_pos_confirmado_em=?
         WHERE id IN (${placeholders}) AND saldo_pos_confirmado_em IS NULL`,
        [saldoNumero, Math.trunc(syncMs), ...ids]
    );

    const traderIds = [...new Set(linhas.map(row => Number(row.trader_id)).filter(Number.isFinite))];
    console.log(
        `🏦 SALDO PÓS-LIQUIDAÇÃO | R$${saldoNumero.toFixed(2)} confirmado para `
        + `${linhas.length} ciclo(s) finalizado(s) | traders=${traderIds.join(',') || 'n/a'}`
    );

    for (const traderId of traderIds) {
        const trader = AUTO_TRADERS_MEMORIA.find(item => Number(item.id) === traderId);
        if (!trader) continue;
        trader.saldo_atual = saldoNumero;
        if (trader.ativo) {
            await autorizarNovaEntradaFinanceiraTrader(trader, {
                ignorarBarreiraLiquidacao: true,
                contexto: 'POS_LIQUIDACAO'
            });
        }
    }

    ioServer.emit('atualizar_interface');
    return linhas.length;
}

'''
bot = replace_once(bot, "function avaliarTrailingStopTrader(trader, variacao) {", insert_before_trailing + "function avaliarTrailingStopTrader(trader, variacao) {", 'saldo post liquidation helpers')

old_limit_fresh = "        snapshot.fresco !== true\n        || !Number.isFinite(saldoInicial)"
new_limit_fresh = "        snapshot.fresco !== true\n        || (snapshot.idade_ms !== undefined && snapshot.idade_ms !== null\n            && (!Number.isFinite(Number(snapshot.idade_ms)) || Number(snapshot.idade_ms) > AUTO_TRADER_BALANCE_MAX_AGE_MS))\n        || !Number.isFinite(saldoInicial)"
bot = replace_once(bot, old_limit_fresh, new_limit_fresh, 'strict entry balance check')

old_auth_sig = "async function autorizarNovaEntradaFinanceiraTrader(trader) {\n    const avaliacao = avaliarLimitesFinanceirosTrader(trader, snapshotSaldoGlobal());"
new_auth_sig = "async function autorizarNovaEntradaFinanceiraTrader(trader, opcoes = {}) {\n    if (opcoes.ignorarBarreiraLiquidacao !== true) {\n        const liquidacaoPendente = await traderPossuiLiquidacaoPendente(trader.id);\n        if (liquidacaoPendente) {\n            console.warn(\n                `⏳ Trader ${trader.id}: nova entrada bloqueada até saldo pós-liquidação do ciclo `\n                + `${liquidacaoPendente.ciclo_id || 'n/a'} ser sincronizado.`\n            );\n            return false;\n        }\n    }\n\n    const avaliacao = avaliarLimitesFinanceirosTrader(trader, snapshotSaldoGlobal());"
bot = replace_once(bot, old_auth_sig, new_auth_sig, 'liquidation barrier auth')

old_saldo_scope = "        const temSaldo = dados.saldo_atual !== undefined && dados.saldo_atual !== null;\n\n        if (temSaldo) {\n            const saldoRecebido = Number(dados.saldo_atual);"
new_saldo_scope = "        const temSaldo = dados.saldo_atual !== undefined && dados.saldo_atual !== null;\n        let saldoRecebidoSincronizado = null;\n\n        if (temSaldo) {\n            const saldoRecebido = Number(dados.saldo_atual);"
bot = replace_once(bot, old_saldo_scope, new_saldo_scope, 'saldo sync scope')

bot = replace_once(
    bot,
    "                    saldoGlobalCorretora = saldoRecebido;\n                    saldoGlobalAtualizadoEm = Date.now();",
    "                    saldoGlobalCorretora = saldoRecebido;\n                    saldoGlobalAtualizadoEm = Date.now();\n                    saldoRecebidoSincronizado = saldoRecebido;",
    'set synced saldo'
)

old_before_no_winner = "        if (!vencedor) return res.json({ recebido: true, saldo_atual: saldoGlobalCorretora });"
new_before_no_winner = "        if (!vencedor && Number.isFinite(saldoRecebidoSincronizado)) {\n            try {\n                await confirmarSaldosPosLiquidacao(saldoRecebidoSincronizado, saldoGlobalAtualizadoEm);\n            } catch (e) {\n                console.error('⚠️ Falha ao confirmar saldo pós-liquidação:', e.message);\n            }\n        }\n\n        if (!vencedor) return res.json({ recebido: true, saldo_atual: saldoGlobalCorretora });"
bot = replace_once(bot, old_before_no_winner, new_before_no_winner, 'post liquidation sync invocation')

# ---------------------------------------------------------------------
# 6) Lifecycle do sinal e ciclo_id.
# ---------------------------------------------------------------------
bot = replace_once(
    bot,
    "            novoEstado[est.id] = estadoApostas[est.id] || { aguardandoResultado: false, galeAtual: 0, robosCiclo: [], robosInscritos: [], mensagensEntrada: [], mensagensGale: [] };",
    "            novoEstado[est.id] = estadoApostas[est.id] || { aguardandoResultado: false, galeAtual: 0, cicloId: null, robosCiclo: [], robosInscritos: [], mensagensEntrada: [], mensagensGale: [] };",
    'default state cycleId'
)

bot = replace_once(
    bot,
    "                            aguardandoResultado: true,\n                            galeAtual: 0,\n                            robosCiclo:",
    "                            aguardandoResultado: true,\n                            galeAtual: 0,\n                            cicloId: crypto.randomUUID(),\n                            robosCiclo:",
    'new signal cycleId'
)

# Direct + Gale intentions receive stable cycle identity.
bot = replace_once(
    bot,
    "                                            trader_id: trader.id,\n                                            estrategia_nome: est.nome,\n                                            fonte_sinal: est.origem,\n                                            alvo: alvoPython,\n                                            nivel: 'DIRETO',",
    "                                            trader_id: trader.id,\n                                            ciclo_id: estadoSinal.cicloId,\n                                            estrategia_id: est.id,\n                                            estrategia_nome: est.nome,\n                                            fonte_sinal: est.origem,\n                                            alvo: alvoPython,\n                                            nivel: 'DIRETO',",
    'direct cycle identity'
)

bot = replace_once(
    bot,
    "                                                trader_id: trader.id,\n                                                estrategia_nome: est.nome,\n                                                fonte_sinal: est.origem,\n                                                alvo: alvoPython,\n                                                nivel: `GALE ${st.galeAtual}`,",
    "                                                trader_id: trader.id,\n                                                ciclo_id: st.cicloId,\n                                                estrategia_id: est.id,\n                                                estrategia_nome: est.nome,\n                                                fonte_sinal: est.origem,\n                                                alvo: alvoPython,\n                                                nivel: `GALE ${st.galeAtual}`,",
    'gale cycle identity'
)

# Todas as buscas PENDENTE deixam de usar LIMIT 1 genérico do trader.
q1 = "const [pendentes] = await dbPool.query(`SELECT id, valor_entrada, valor_empate FROM auditoria_ordens WHERE trader_id = ? AND status_ordem = 'PENDENTE' LIMIT 1`, [trader.id]);"
q1n = "const [pendentes] = await dbPool.query(`SELECT id, valor_entrada, valor_empate FROM auditoria_ordens WHERE trader_id = ? AND ciclo_id = ? AND estrategia_id = ? AND status_ordem = 'PENDENTE' ORDER BY id DESC LIMIT 1`, [trader.id, st.cicloId, est.id]);"
bot = replace_count(bot, q1, q1n, 2, 'pending simple queries cycle scoped')

q2 = "const [pendentes] = await dbPool.query(`SELECT id, risco_total, valor_entrada, valor_empate FROM auditoria_ordens WHERE trader_id = ? AND status_ordem = 'PENDENTE' LIMIT 1`, [trader.id]);"
q2n = "const [pendentes] = await dbPool.query(`SELECT id, risco_total, valor_entrada, valor_empate FROM auditoria_ordens WHERE trader_id = ? AND ciclo_id = ? AND estrategia_id = ? AND status_ordem = 'PENDENTE' ORDER BY id DESC LIMIT 1`, [trader.id, st.cicloId, est.id]);"
bot = replace_once(bot, q2, q2n, 'pending gale query cycle scoped')

# Fechamentos não gravam mais saldo stale; aguardam heartbeat posterior.
old_win = "await dbPool.query(`UPDATE auditoria_ordens SET status_ordem = ?, lucro_prejuizo = ?, saldo_pos = ?, placar_mesa = ? WHERE id = ?`, [isTie ? 'TIE' : 'WIN', vLucro, trader.saldo_atual, `[P:${p1+p2} B:${b1+b2}]`, pendentes[0].id]);"
new_win = "await dbPool.query(`UPDATE auditoria_ordens SET status_ordem = ?, lucro_prejuizo = ?, saldo_pos = NULL, resultado_confirmado_em = ?, saldo_pos_confirmado_em = NULL, ciclo_finalizado = true, placar_mesa = ? WHERE id = ?`, [isTie ? 'TIE' : 'WIN', vLucro, Date.now(), `[P:${p1+p2} B:${b1+b2}]`, pendentes[0].id]);"
bot = replace_once(bot, old_win, new_win, 'final WIN TIE settlement')

old_intermediate_loss = "                                                `UPDATE auditoria_ordens\n                                                 SET status_ordem='LOSS', lucro_prejuizo=?, saldo_pos=?, placar_mesa=?\n                                                 WHERE id=?`,\n                                                [pnlEtapaAnterior, trader.saldo_atual, `[P:${p1+p2} B:${b1+b2}]`, pendentes[0].id]"
new_intermediate_loss = "                                                `UPDATE auditoria_ordens\n                                                 SET status_ordem='LOSS', lucro_prejuizo=?, saldo_pos=NULL, resultado_confirmado_em=?,\n                                                     saldo_pos_confirmado_em=NULL, ciclo_finalizado=false, placar_mesa=?\n                                                 WHERE id=?`,\n                                                [pnlEtapaAnterior, Date.now(), `[P:${p1+p2} B:${b1+b2}]`, pendentes[0].id]"
bot = replace_once(bot, old_intermediate_loss, new_intermediate_loss, 'intermediate loss no stale saldo')

old_final_loss = "await dbPool.query(`UPDATE auditoria_ordens SET status_ordem = 'LOSS', lucro_prejuizo = ?, saldo_pos = ?, placar_mesa = ? WHERE id = ?`, [prejuizo, trader.saldo_atual, `[P:${p1+p2} B:${b1+b2}]`, pendentes[0].id]);"
new_final_loss = "await dbPool.query(`UPDATE auditoria_ordens SET status_ordem = 'LOSS', lucro_prejuizo = ?, saldo_pos = NULL, resultado_confirmado_em = ?, saldo_pos_confirmado_em = NULL, ciclo_finalizado = true, placar_mesa = ? WHERE id = ?`, [prejuizo, Date.now(), `[P:${p1+p2} B:${b1+b2}]`, pendentes[0].id]);"
bot = replace_once(bot, old_final_loss, new_final_loss, 'final loss settlement')

# Limpa ciclo ao finalizar.
bot = replace_once(
    bot,
    "                    st.aguardandoResultado = false;\n                    st.galeAtual = 0;\n                    sinalFinalizadoAgora = true;",
    "                    st.aguardandoResultado = false;\n                    st.galeAtual = 0;\n                    st.cicloId = null;\n                    sinalFinalizadoAgora = true;",
    'clear cycle on finish'
)

# ---------------------------------------------------------------------
# 7) Reset diário antes de promover STANDBY e observabilidade operacional.
# ---------------------------------------------------------------------
old_rearm_call = "        try {\n            await ativarAutoTradersAguardandoMesa();"
new_rearm_call = "        try {\n            await rearmarContadoresDiariosAutoTraders();\n        } catch (e) {\n            console.error('⚠️ Falha ao rearmar contador diário dos Auto-Traders:', e.message);\n        }\n\n        try {\n            await ativarAutoTradersAguardandoMesa();"
bot = replace_once(bot, old_rearm_call, new_rearm_call, 'daily reset invocation')

old_schedule_log = "                                        console.log(`Trader ${trader.id} fora da janela de execucao (${cf.hora_inicio || '00:00'}-${cf.hora_fim || '23:59'}). Nova entrada ignorada.`);"
new_schedule_log = "                                        console.log(`🕒 Trader ${trader.id}: nova entrada ignorada fora da janela ${cf.hora_inicio || '00:00'}-${cf.hora_fim || '23:59'} (${OPERATION_TIME_ZONE}); agora=${horaOperacionalTexto()}.`);"
bot = replace_once(bot, old_schedule_log, new_schedule_log, 'schedule detailed log')

old_limit_block = "                                    if (cf.limite_entradas && trader.entradas_feitas >= cf.limite_entradas) {\n                                        trader.status_operacao = 'META_ATINGIDA';\n                                        try {\n                                            await dbPool.query('UPDATE auto_traders SET status_operacao=? WHERE id=?', ['META_ATINGIDA', trader.id]);\n                                        } catch(e) {\n                                            console.error(`❌ Falha ao persistir META_ATINGIDA do trader ${trader.id}:`, e.message);\n                                        }\n                                        continue;\n                                    }"
new_limit_block = "                                    if (cf.limite_entradas && trader.entradas_feitas >= cf.limite_entradas) {\n                                        trader.status_operacao = 'META_ATINGIDA';\n                                        try {\n                                            await dbPool.query('UPDATE auto_traders SET status_operacao=? WHERE id=?', ['META_ATINGIDA', trader.id]);\n                                        } catch(e) {\n                                            console.error(`❌ Falha ao persistir META_ATINGIDA do trader ${trader.id}:`, e.message);\n                                        }\n                                        console.log(`📊 Trader ${trader.id}: limite diário atingido (${trader.entradas_feitas}/${cf.limite_entradas} ciclos em ${trader.entradas_data || chaveDataOperacional()}).`);\n                                        continue;\n                                    }"
bot = replace_once(bot, old_limit_block, new_limit_block, 'limit detailed log')

old_camo_skip = "                                            trader.pulos_restantes--;\n                                            try { await dbPool.query('UPDATE auto_traders SET pulos_restantes=? WHERE id=?', [trader.pulos_restantes, trader.id]); } catch(e) { console.error(`❌ Falha ao persistir pulos_restantes do trader ${trader.id}:`, e.message); }\n                                            continue;"
new_camo_skip = "                                            trader.pulos_restantes--;\n                                            try { await dbPool.query('UPDATE auto_traders SET pulos_restantes=? WHERE id=?', [trader.pulos_restantes, trader.id]); } catch(e) { console.error(`❌ Falha ao persistir pulos_restantes do trader ${trader.id}:`, e.message); }\n                                            console.log(`👻 Trader ${trader.id}: sinal válido pulado pela camuflagem; faltam ${trader.pulos_restantes} pulo(s).`);\n                                            continue;"
bot = replace_once(bot, old_camo_skip, new_camo_skip, 'camo skip log')

old_camo_draw = "                                            trader.pulos_restantes = Math.floor(Math.random() * (pMax - pMin + 1)) + pMin;\n                                            try { await dbPool.query('UPDATE auto_traders SET pulos_restantes=? WHERE id=?', [trader.pulos_restantes, trader.id]); } catch(e) { console.error(`❌ Falha ao persistir novo ciclo de pulos do trader ${trader.id}:`, e.message); }"
new_camo_draw = "                                            trader.pulos_restantes = Math.floor(Math.random() * (pMax - pMin + 1)) + pMin;\n                                            try { await dbPool.query('UPDATE auto_traders SET pulos_restantes=? WHERE id=?', [trader.pulos_restantes, trader.id]); } catch(e) { console.error(`❌ Falha ao persistir novo ciclo de pulos do trader ${trader.id}:`, e.message); }\n                                            console.log(`👻 Trader ${trader.id}: ciclo executável liberado; próximo intervalo sorteado=${trader.pulos_restantes} sinal(is).`);"
bot = replace_once(bot, old_camo_draw, new_camo_draw, 'camo draw log')

old_increment = "                                            const novasEntradas = trader.entradas_feitas + 1;\n                                            await conexao.query('UPDATE auto_traders SET entradas_feitas=? WHERE id=?', [novasEntradas, trader.id]);"
new_increment = "                                            const novasEntradas = trader.entradas_feitas + 1;\n                                            const dataEntrada = chaveDataOperacional();\n                                            await conexao.query('UPDATE auto_traders SET entradas_feitas=?, entradas_data=? WHERE id=?', [novasEntradas, dataEntrada, trader.id]);"
bot = replace_once(bot, old_increment, new_increment, 'daily entry increment')

bot = replace_once(
    bot,
    "                                            trader.entradas_feitas = novasEntradas;",
    "                                            trader.entradas_feitas = novasEntradas;\n                                            trader.entradas_data = dataEntrada;\n                                            console.log(`📊 Trader ${trader.id}: ciclo ${estadoSinal.cicloId} iniciado e confirmado; volume diário=${novasEntradas}/${cf.limite_entradas || '∞'}.`);",
    'daily entry memory log'
)

# ---------------------------------------------------------------------
# 8) UI/PDF: terminologia correta e saldo real pós-liquidação auditável.
# ---------------------------------------------------------------------
ui = replace_once(
    ui,
    "<div class=\"form-group\"><label>Pausar motor automaticamente após X execuções concluídas:</label><input type=\"number\" id=\"at-max-entradas\" value=\"15\" min=\"1\"></div>",
    "<div class=\"form-group\"><label>Pausar motor automaticamente após X ciclos iniciados no dia:</label><input type=\"number\" id=\"at-max-entradas\" value=\"15\" min=\"1\"></div>",
    'UI daily limit label'
)

ui = replace_once(
    ui,
    "📊 Volume: <strong>${at.entradas_feitas} / ${cf.limite_entradas||'∞'} Execuções</strong>",
    "📊 Ciclos hoje: <strong>${at.entradas_feitas} / ${cf.limite_entradas||'∞'}</strong>",
    'UI daily volume card'
)

ui = replace_once(
    ui,
    "<div class=\"pdf-box\"><strong>Saldo sincronizado de referência:</strong><br><span id=\"pdf-saldo-final\" style=\"font-weight:bold;\">-</span></div>",
    "<div class=\"pdf-box\"><strong>Banca atual sincronizada:</strong><br><span id=\"pdf-saldo-final\" style=\"font-weight:bold;\">-</span></div>",
    'PDF current bank label'
)

ui = replace_once(
    ui,
    "<th style=\"width:13%\">Saldo do modelo</th>",
    "<th style=\"width:13%\">Saldo real pós-liquidação</th>",
    'PDF post settlement header'
)

old_saldo_model = "                const saldoModelo = confirmada && estadosFinalizados.has(String(o.status_ordem || '').toUpperCase())\n                    ? formatarMoedaPdf(o.saldo_pos)\n                    : 'Não auditável';"
new_saldo_model = "                const finalizada = estadosFinalizados.has(String(o.status_ordem || '').toUpperCase());\n                const saldoPosConfirmado = Number(o.saldo_pos_confirmado_em) > 0 && Number.isFinite(Number(o.saldo_pos));\n                const saldoModelo = confirmada && finalizada && saldoPosConfirmado\n                    ? `${formatarMoedaPdf(o.saldo_pos)}<br><span style=\"font-size:8px; color:#555;\">pós-liquidação confirmado</span>`\n                    : (confirmada && finalizada\n                        ? 'Aguardando sync pós-resultado'\n                        : 'Não auditável');"
ui = replace_once(ui, old_saldo_model, new_saldo_model, 'PDF saldo real semantics')

# Exibe ciclo estável no campo nível/estado sem criar nova coluna larga.
old_level_cell = "<td>${escaparHtmlPdf(o.nivel)}<br><span style=\"color:#666;\">${escaparHtmlPdf(o.status_ordem)}</span></td>"
new_level_cell = "<td>${escaparHtmlPdf(o.nivel)}<br><span style=\"color:#666;\">${escaparHtmlPdf(o.status_ordem)}</span>${o.ciclo_id ? `<br><span style=\"font-size:7px; color:#888;\">Ciclo ${escaparHtmlPdf(String(o.ciclo_id).slice(0,8))}</span>` : ''}</td>"
ui = replace_once(ui, old_level_cell, new_level_cell, 'PDF cycle label')

BOT.write_text(bot, encoding='utf-8')
UI.write_text(ui, encoding='utf-8')

TEST.parent.mkdir(parents=True, exist_ok=True)
TEST.write_text(r'''"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const backend = fs.readFileSync(path.join(__dirname, "..", "bot2_coletor.js"), "utf8");
const ui = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

test("BUG-051: ordens financeiras possuem identidade de ciclo e estratégia", () => {
    assert.match(backend, /ciclo_id VARCHAR\(64\)/);
    assert.match(backend, /estrategia_id VARCHAR\(100\)/);
    assert.match(backend, /cicloId: crypto\.randomUUID\(\)/);
    assert.match(backend, /ciclo_id: estadoSinal\.cicloId/);
    assert.match(backend, /ciclo_id: st\.cicloId/);
    assert.doesNotMatch(backend, /WHERE trader_id = \? AND status_ordem = 'PENDENTE' LIMIT 1/);
});

test("BUG-051: saldo final só é auditável após sincronização posterior ao resultado", () => {
    assert.match(backend, /saldo_pos_confirmado_em BIGINT DEFAULT NULL/);
    assert.match(backend, /ciclo_finalizado BOOLEAN DEFAULT false/);
    assert.match(backend, /confirmarSaldosPosLiquidacao/);
    assert.match(backend, /saldo_pos=NULL, resultado_confirmado_em/);
    assert.match(backend, /traderPossuiLiquidacaoPendente/);
    assert.match(backend, /AUTO_TRADER_BALANCE_MAX_AGE_MS/);
    assert.match(ui, /Saldo real pós-liquidação/);
    assert.match(ui, /Aguardando sync pós-resultado/);
});

test("BUG-051: limite diário, horário e camuflagem são auditáveis", () => {
    assert.match(backend, /entradas_data VARCHAR\(10\)/);
    assert.match(backend, /rearmarContadoresDiariosAutoTraders/);
    assert.match(backend, /OPERATION_TIME_ZONE/);
    assert.match(backend, /validarConfigAutoTrader/);
    assert.match(backend, /intervalo de pulos inválido/);
    assert.match(ui, /ciclos iniciados no dia/);
    assert.match(ui, /Ciclos hoje/);
});
''', encoding='utf-8')

print('BUG-051 patch aplicado com contratos locais.')
