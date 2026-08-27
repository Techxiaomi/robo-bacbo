#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const EXPECTED_BRANCH = 'fix/mc21-auto-trader-multi-robot-arbiter';
const EXPECTED_HEAD = '7421086b26d997e33f467e57c6457f8e29b246d3';
const env = { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat', LESS: '-FRX' };

function git(args, options = {}) {
    return cp.execFileSync('git', args, {
        cwd: options.cwd || process.cwd(),
        env,
        encoding: 'utf8',
        stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
        timeout: options.timeout || 120000
    });
}

function run(program, args, cwd, timeout = 120000) {
    console.log(`\n> ${program} ${args.join(' ')}`);
    cp.execFileSync(program, args, {
        cwd,
        env,
        stdio: 'inherit',
        timeout
    });
}

function count(text, needle) {
    let n = 0;
    let at = 0;
    while (true) {
        const i = text.indexOf(needle, at);
        if (i < 0) return n;
        n++;
        at = i + needle.length;
    }
}

function once(text, oldText, newText, label) {
    const n = count(text, oldText);
    if (n !== 1) throw new Error(`${label}: esperado 1 ocorrência, encontrado ${n}`);
    return text.replace(oldText, newText);
}

function many(text, oldText, newText, expected, label) {
    const n = count(text, oldText);
    if (n !== expected) throw new Error(`${label}: esperado ${expected}, encontrado ${n}`);
    return text.split(oldText).join(newText);
}

const cwd = process.cwd();
const repoRoot = git(['rev-parse', '--show-toplevel'], { cwd }).trim();
const projectDir = path.join(repoRoot, 'robo-bacbo');
const backendPath = path.join(projectDir, 'bot2_coletor.js');
const scriptGitPath = 'scripts/mc21_apply.js';
const backendGitPath = 'robo-bacbo/bot2_coletor.js';

const branch = git(['branch', '--show-current'], { cwd: repoRoot }).trim();
const head = git(['rev-parse', 'HEAD'], { cwd: repoRoot }).trim();

if (branch !== EXPECTED_BRANCH) {
    throw new Error(`Branch inesperada: ${branch}`);
}
if (head !== EXPECTED_HEAD) {
    throw new Error(`HEAD inesperado: ${head}. Rode git pull --ff-only antes de aplicar.`);
}

const tracked = git(['status', '--porcelain=v1', '--untracked-files=no'], { cwd: repoRoot }).trim();
if (tracked) throw new Error(`Há alterações tracked antes do MC21:\n${tracked}`);

let source = git(['show', `HEAD:${backendGitPath}`], { cwd: repoRoot }).replace(/\r\n/g, '\n');
const original = source;

source = once(
    source,
    '} = require("./auto_trader");\nrequire("./env_loader").loadEnvFile(path.join(__dirname, "..", ".env"));',
    '} = require("./auto_trader");\nconst { criarArbitroFinanceiroAutoTrader } = require("./auto_trader_round_arbiter");\nrequire("./env_loader").loadEnvFile(path.join(__dirname, "..", ".env"));',
    'import do arbitro'
);

source = once(
    source,
    '                trader_id INT,\n                estrategia_nome VARCHAR(100),',
    '                trader_id INT,\n                estrategia_id VARCHAR(100) DEFAULT NULL,\n                estrategia_nome VARCHAR(100),',
    'schema estrategia_id'
);

source = once(
    source,
    '        await adicionarColuna("ALTER TABLE historico_disparos_robos ADD COLUMN estrategia_origem VARCHAR(100) DEFAULT \'\'");\n        await adicionarColuna("ALTER TABLE auditoria_ordens ADD COLUMN executor_order_id VARCHAR(64) DEFAULT NULL");',
    '        await adicionarColuna("ALTER TABLE historico_disparos_robos ADD COLUMN estrategia_origem VARCHAR(100) DEFAULT \'\'");\n        await adicionarColuna("ALTER TABLE auditoria_ordens ADD COLUMN estrategia_id VARCHAR(100) DEFAULT NULL");\n        await adicionarColuna("ALTER TABLE auditoria_ordens ADD COLUMN executor_order_id VARCHAR(64) DEFAULT NULL");',
    'migration estrategia_id'
);

source = once(
    source,
    '            (trader_id, estrategia_nome, fonte_sinal, alvo, nivel, risco_total,\n             valor_entrada, valor_empate, executor_order_id, status_ordem)',
    '            (trader_id, estrategia_id, estrategia_nome, fonte_sinal, alvo, nivel, risco_total,\n             valor_entrada, valor_empate, executor_order_id, status_ordem)',
    'insert estrategia_id'
);

source = once(
    source,
    "         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PREPARANDO')",
    "         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PREPARANDO')",
    'placeholders estrategia_id'
);

source = once(
    source,
    '            dados.trader_id,\n            dados.estrategia_nome,',
    '            dados.trader_id,\n            dados.estrategia_id ?? null,\n            dados.estrategia_nome,',
    'bind estrategia_id'
);

source = once(
    source,
    'let AUTO_TRADERS_MEMORIA = [];\nlet historicoGirosAnalitico = [];',
    'let AUTO_TRADERS_MEMORIA = [];\nlet arbitroFinanceiroAutoTrader = null;\nlet historicoGirosAnalitico = [];',
    'estado global arbitro'
);

source = once(
    source,
    `async function autorizarNovaEntradaFinanceiraTrader(trader) {\n    if (!(await integracaoContadorDiario.garantirAntesDaEntrada(trader))) {\n        return false;\n    }\n\n    if (await traderPossuiLiquidacaoPendente(trader.id)) {`,
    `async function autorizarNovaEntradaFinanceiraTrader(trader) {\n    if (!(await integracaoContadorDiario.garantirAntesDaEntrada(trader))) {\n        return false;\n    }\n\n    if (arbitroFinanceiroAutoTrader) {\n        const abertas = await arbitroFinanceiroAutoTrader.listarOrdensFinanceirasEmAbertoTrader(trader.id);\n        if (abertas.length > 0) {\n            console.warn(\`⛔ MC21 SINGLE-FLIGHT | Trader \${trader.id}: nova entrada bloqueada por ordem/intenção financeira aberta.\`);\n            return false;\n        }\n    }\n\n    if (await traderPossuiLiquidacaoPendente(trader.id)) {`,
    'single-flight persistente'
);

const instancia = `arbitroFinanceiroAutoTrader = criarArbitroFinanceiroAutoTrader({\n    dbPool,\n    crypto,\n    log: console,\n    listarTraders: () => AUTO_TRADERS_MEMORIA,\n    autoTraderParticipouDoSinal,\n    traderDentroHorarioExecucao,\n    formatarFaixasHorario,\n    prepararEntradaCicloAutoTrader,\n    autorizarNovaEntradaFinanceiraTrader,\n    calcularPlanoAposta,\n    criarIntencaoOrdem,\n    enviarOrdemAoExecutor,\n    marcarIntencaoAposFalhaEnvio,\n    bloquearTraderAposExecucaoAmbigua\n});\n\n`;

source = once(
    source,
    'async function carregarSistemasParaMemoria() {',
    instancia + 'async function carregarSistemasParaMemoria() {',
    'instancia do arbitro'
);

const oldFinal = "const [pendentes] = await dbPool.query(`SELECT id, valor_entrada, valor_empate FROM auditoria_ordens WHERE trader_id = ? AND status_ordem = 'PENDENTE' LIMIT 1`, [trader.id]);";
const newFinal = "const [pendentes] = await dbPool.query(`SELECT id, valor_entrada, valor_empate FROM auditoria_ordens WHERE trader_id = ? AND estrategia_id = ? AND status_ordem = 'PENDENTE' LIMIT 1`, [trader.id, est.id]);";
source = many(source, oldFinal, newFinal, 2, 'liquidacao por estrategia');

const oldGale = "const [pendentes] = await dbPool.query(`SELECT id, risco_total, valor_entrada, valor_empate FROM auditoria_ordens WHERE trader_id = ? AND status_ordem = 'PENDENTE' LIMIT 1`, [trader.id]);";
const newGale = "const [pendentes] = await dbPool.query(`SELECT id, risco_total, valor_entrada, valor_empate FROM auditoria_ordens WHERE trader_id = ? AND estrategia_id = ? AND status_ordem = 'PENDENTE' LIMIT 1`, [trader.id, est.id]);";
source = once(source, oldGale, newGale, 'gale por estrategia');

source = once(
    source,
    '                                            intencaoGale = await criarIntencaoOrdem(conexaoGale, {\n                                                trader_id: trader.id,\n                                                estrategia_nome: est.nome,',
    '                                            intencaoGale = await criarIntencaoOrdem(conexaoGale, {\n                                                trader_id: trader.id,\n                                                estrategia_id: est.id,\n                                                estrategia_nome: est.nome,',
    'dono financeiro do gale'
);

source = once(
    source,
    '        const historicoLiveCanonico = estadoLiveCanonico.history;\n\n        {',
    '        const historicoLiveCanonico = estadoLiveCanonico.history;\n        const oportunidadesFinanceirasAutoTraderRodada =\n            arbitroFinanceiroAutoTrader.criarMapaRodada(contadorRodadasSinal);\n\n        {',
    'mapa financeiro da rodada'
);

const telegramAnchor = '                        estadoSinal.telegramEntradaPromise = inscreverRobosTelegramEntrada(est, estadoSinal, selecaoRobos.telegram);';
const telegramIndex = source.indexOf(telegramAnchor);
if (telegramIndex < 0) throw new Error('âncora Telegram não encontrada');

const financialMarker = '                        if (est.quarentena_restante <= 0) {';
const financialStart = source.indexOf(financialMarker, telegramIndex + telegramAnchor.length);
if (financialStart < 0) throw new Error('bloco financeiro direto não encontrado');

const routeEndMarker = `\n                    }\n                }\n            }\n        }\n    } catch(erroGeral) {`;
const financialEnd = source.indexOf(routeEndMarker, financialStart);
if (financialEnd < 0) throw new Error('fim do bloco de novos sinais não encontrado');

const registration = `                        if (est.quarentena_restante <= 0) {\n                            for (const trader of AUTO_TRADERS_MEMORIA) {\n                                if (\n                                    trader.ativo\n                                    && trader.status_operacao === 'OPERANDO'\n                                    && autoTraderParticipouDoSinal(trader, est, estadoSinal)\n                                ) {\n                                    arbitroFinanceiroAutoTrader.registrarCandidato(\n                                        oportunidadesFinanceirasAutoTraderRodada,\n                                        trader,\n                                        est,\n                                        estadoSinal\n                                    );\n                                }\n                            }\n                        }`;

const routeEndNew = `                    }\n                }\n            }\n        }\n\n        // MC21: somente sinais realmente admitidos pelos locks MC1-MC8\n        // chegam à decisão financeira. Aleatoriedade é consumida uma vez\n        // por oportunidade agregada, nunca por sinal bruto concorrente.\n        await arbitroFinanceiroAutoTrader.processarRodada(\n            oportunidadesFinanceirasAutoTraderRodada\n        );\n    } catch(erroGeral) {`;

source = source.slice(0, financialStart)
    + registration
    + '\n'
    + routeEndNew
    + source.slice(financialEnd + routeEndMarker.length);

if (source === original) throw new Error('nenhuma alteração aplicada');
if (source.includes('\r\n')) throw new Error('CRLF detectado no conteúdo gerado');

fs.writeFileSync(backendPath, source, 'utf8');

try {
    run(process.execPath, ['--check', 'bot2_coletor.js'], projectDir, 30000);
    run(process.execPath, ['--check', 'auto_trader_round_arbiter.js'], projectDir, 30000);
    run('git', ['diff', '--check', '--', backendGitPath], repoRoot, 30000);
    run('git', ['--no-pager', 'diff', '--stat', '--', backendGitPath], repoRoot, 30000);
    run('git', ['--no-pager', 'diff', '--name-status', '--', backendGitPath], repoRoot, 30000);

    const after = git(['status', '--porcelain=v1', '--untracked-files=no'], { cwd: repoRoot })
        .split(/\r?\n/)
        .filter(Boolean);
    const inesperados = after.filter(line => line !== ` M ${backendGitPath}`);
    if (inesperados.length) throw new Error(`tracked inesperado após MC21:\n${inesperados.join('\n')}`);

    run('git', ['add', '--', backendGitPath], repoRoot, 30000);
    run('git', ['rm', '--', scriptGitPath], repoRoot, 30000);
    run('git', ['commit', '-m', 'Micro-Commit 21: Integra arbitro financeiro multi-robo'], repoRoot, 120000);

    console.log('\n✅ MC21 aplicado e commitado LOCALMENTE.');
    console.log('✅ Nenhum teste/CI foi executado.');
    console.log('✅ Apenas node --check + git diff --check foram executados.');
    console.log('✅ Nenhum push foi executado.');
    run('git', ['status', '-sb'], repoRoot, 30000);
    run('git', ['--no-pager', 'log', '-4', '--oneline'], repoRoot, 30000);
} catch (e) {
    try { git(['restore', '--staged', '--worktree', '--', backendGitPath], { cwd: repoRoot }); } catch (_) {}
    console.error(`\n❌ MC21 abortado: ${e.message}`);
    console.error('O backend foi restaurado; nenhum push foi executado.');
    process.exitCode = 1;
}
