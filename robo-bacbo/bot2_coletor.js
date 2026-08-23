'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const basePath = path.join(__dirname, 'bot2_coletor.phase2_base.js');
let source = fs.readFileSync(basePath, 'utf8');

function replaceOnce(label, original, replacement) {
    const index = source.indexOf(original);
    if (index < 0) {
        throw new Error(`PHASE2_EXECUTION transform não encontrou trecho obrigatório: ${label}`);
    }
    source = source.slice(0, index) + replacement + source.slice(index + original.length);
}

replaceOnce(
    'imports estratégia de execução',
    'const { criarIntegracaoContadorDiario } = require("./bug051b_integration");\n',
    `const { criarIntegracaoContadorDiario } = require("./bug051b_integration");\nconst {\n    normalizarConfigEstrategiaExecucao,\n    camposPersistenciaEstrategiaExecucao,\n    persistirParametrosCicloAutoTrader,\n    migrarConfiguracoesLegadasExecucao,\n    criarControleEstrategiaExecucao\n} = require("./auto_trader_execution_cycle");\n`
);

replaceOnce(
    'colunas create auto_traders',
    `                entradas_feitas INT DEFAULT 0,\n                pulos_restantes INT DEFAULT 0,\n                data_contador_entradas VARCHAR(10) DEFAULT NULL,\n`,
    `                entradas_feitas INT DEFAULT 0,\n                pulos_restantes INT DEFAULT 0,\n                gatilho_falhas_monitor INT DEFAULT 0,\n                tamanho_lote_processamento INT DEFAULT 0,\n                tipo_amostragem VARCHAR(30) DEFAULT 'NENHUMA',\n                chance_execucao_pct INT DEFAULT 100,\n                limite_ciclos_sessao INT DEFAULT 0,\n                data_contador_entradas VARCHAR(10) DEFAULT NULL,\n`
);

replaceOnce(
    'migrations estratégia de execução',
    `        await adicionarColuna("ALTER TABLE auto_traders ADD COLUMN data_contador_entradas VARCHAR(10) DEFAULT NULL");\n        await integracaoContadorDiario.inicializarDatasLegadas();\n`,
    `        await adicionarColuna("ALTER TABLE auto_traders ADD COLUMN data_contador_entradas VARCHAR(10) DEFAULT NULL");\n        await adicionarColuna("ALTER TABLE auto_traders ADD COLUMN gatilho_falhas_monitor INT DEFAULT 0");\n        await adicionarColuna("ALTER TABLE auto_traders ADD COLUMN tamanho_lote_processamento INT DEFAULT 0");\n        await adicionarColuna("ALTER TABLE auto_traders ADD COLUMN tipo_amostragem VARCHAR(30) DEFAULT 'NENHUMA'");\n        await adicionarColuna("ALTER TABLE auto_traders ADD COLUMN chance_execucao_pct INT DEFAULT 100");\n        await adicionarColuna("ALTER TABLE auto_traders ADD COLUMN limite_ciclos_sessao INT DEFAULT 0");\n        await migrarConfiguracoesLegadasExecucao(dbPool);\n        await integracaoContadorDiario.inicializarDatasLegadas();\n`
);

replaceOnce(
    'controle em memória por motor',
    'let AUTO_TRADERS_MEMORIA = [];\n',
    `let AUTO_TRADERS_MEMORIA = [];\nconst controleEstrategiaExecucao = criarControleEstrategiaExecucao({ dbPool });\n`
);

replaceOnce(
    'GET auto-traders canonicalização',
    `            let confObj = {}; try { confObj = JSON.parse(at.config_json); } catch(e) {}\n            return {\n`,
    `            let confObj = {}; try { confObj = JSON.parse(at.config_json); } catch(e) {}\n            confObj = normalizarConfigEstrategiaExecucao(confObj).config;\n            return {\n`
);

replaceOnce(
    'POST config canonical',
    `        const { nome, ativo, config } = req.body;\n        const configJson = JSON.stringify(config || {});\n        const novoAtivo = ativo === true || ativo === 1;\n`,
    `        const { nome, ativo, config } = req.body;\n        const configNormalizada = normalizarConfigEstrategiaExecucao(config || {}).config;\n        const configJson = JSON.stringify(configNormalizada);\n        const camposCiclo = camposPersistenciaEstrategiaExecucao(configNormalizada);\n        const novoAtivo = ativo === true || ativo === 1;\n`
);

replaceOnce(
    'POST persistência campos ciclo',
    `        await dbPool.query(\n            \`INSERT INTO auto_traders (nome, ativo, config_json, saldo_inicial, saldo_atual, status_operacao, entradas_feitas, pulos_restantes, data_contador_entradas)\n             VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)\`,\n            [nome, novoAtivo ? 1 : 0, configJson, saldoBaseline, saldoBaseline, statusInicial, dataContadorEntradas]\n        );\n`,
    `        await dbPool.query(\n            \`INSERT INTO auto_traders (\n                nome, ativo, config_json, saldo_inicial, saldo_atual, status_operacao,\n                entradas_feitas, pulos_restantes, gatilho_falhas_monitor,\n                tamanho_lote_processamento, tipo_amostragem, chance_execucao_pct,\n                limite_ciclos_sessao, data_contador_entradas\n             ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?)\`,\n            [\n                nome, novoAtivo ? 1 : 0, configJson, saldoBaseline, saldoBaseline, statusInicial,\n                camposCiclo.gatilho_falhas_monitor, camposCiclo.tamanho_lote_processamento,\n                camposCiclo.tipo_amostragem, camposCiclo.chance_execucao_pct,\n                camposCiclo.limite_ciclos_sessao, dataContadorEntradas\n            ]\n        );\n`
);

replaceOnce(
    'PUT config canonical',
    `        const { nome, ativo, config } = req.body;\n        const configJson = JSON.stringify(config || {});\n        const novoAtivo = ativo === true || ativo === 1;\n`,
    `        const { nome, ativo, config } = req.body;\n        const configNormalizada = normalizarConfigEstrategiaExecucao(config || {}).config;\n        const configJson = JSON.stringify(configNormalizada);\n        const novoAtivo = ativo === true || ativo === 1;\n`
);

replaceOnce(
    'PUT configNova canonical',
    '        const configNova = config || {};\n',
    '        const configNova = configNormalizada;\n'
);

replaceOnce(
    'PUT sincroniza colunas ciclo',
    `        }\n\n        await carregarSistemasParaMemoria();\n        res.json({ sucesso: true, baseline_recapturado: reativando });\n`,
    `        }\n\n        await persistirParametrosCicloAutoTrader(dbPool, id, configNova);\n        await carregarSistemasParaMemoria();\n        res.json({ sucesso: true, baseline_recapturado: reativando });\n`
);

replaceOnce(
    'DELETE limpa estado em memória',
    `app.delete("/api/auto-trader/:id", async (req, res) => {\n    try { await dbPool.query('DELETE FROM auto_traders WHERE id=?', [req.params.id]); await carregarSistemasParaMemoria(); res.json({ sucesso: true }); } catch (e) { console.error(\`❌ DELETE /api/auto-trader/\${req.params.id} falhou:\`, e.message); res.status(500).json({ sucesso: false }); }\n});\n`,
    `app.delete("/api/auto-trader/:id", async (req, res) => {\n    try {\n        await dbPool.query('DELETE FROM auto_traders WHERE id=?', [req.params.id]);\n        controleEstrategiaExecucao.removerTrader(req.params.id);\n        await carregarSistemasParaMemoria();\n        res.json({ sucesso: true });\n    } catch (e) {\n        console.error(\`❌ DELETE /api/auto-trader/\${req.params.id} falhou:\`, e.message);\n        res.status(500).json({ sucesso: false });\n    }\n});\n`
);

replaceOnce(
    'hidratação memória auto traders',
    `        const [linhasAT] = await dbPool.query('SELECT * FROM auto_traders');\n        AUTO_TRADERS_MEMORIA = linhasAT.map(at => {\n            let cfg = {}; try { cfg = JSON.parse(at.config_json); } catch(e){}\n            return {\n                id: at.id, nome: at.nome, ativo: at.ativo === 1, config: cfg,\n                saldo_inicial: parseFloat(at.saldo_inicial), saldo_atual: parseFloat(at.saldo_atual),\n                status_operacao: at.status_operacao, entradas_feitas: at.entradas_feitas, pulos_restantes: at.pulos_restantes,\n                data_contador_entradas: String(at.data_contador_entradas || ''),\n                reds_consecutivos: Math.max(0, Number(at.reds_consecutivos) || 0),\n                stop_reds_pausado_ate: Math.max(0, Number(at.stop_reds_pausado_ate) || 0),\n                trailing_pico_lucro: Math.max(0, Number(at.trailing_pico_lucro) || 0)\n            };\n        });\n`,
    `        const [linhasAT] = await dbPool.query('SELECT * FROM auto_traders');\n        AUTO_TRADERS_MEMORIA = linhasAT.map(at => {\n            let cfg = {}; try { cfg = JSON.parse(at.config_json); } catch(e){}\n            cfg = normalizarConfigEstrategiaExecucao(cfg).config;\n            const trader = {\n                id: at.id, nome: at.nome, ativo: at.ativo === 1, config: cfg,\n                saldo_inicial: parseFloat(at.saldo_inicial), saldo_atual: parseFloat(at.saldo_atual),\n                status_operacao: at.status_operacao, entradas_feitas: at.entradas_feitas, pulos_restantes: at.pulos_restantes,\n                data_contador_entradas: String(at.data_contador_entradas || ''),\n                reds_consecutivos: Math.max(0, Number(at.reds_consecutivos) || 0),\n                stop_reds_pausado_ate: Math.max(0, Number(at.stop_reds_pausado_ate) || 0),\n                trailing_pico_lucro: Math.max(0, Number(at.trailing_pico_lucro) || 0),\n                gatilho_falhas_monitor: Math.max(0, Number(at.gatilho_falhas_monitor) || 0),\n                tamanho_lote_processamento: Math.max(0, Number(at.tamanho_lote_processamento) || 0),\n                tipo_amostragem: String(at.tipo_amostragem || cfg.tipo_amostragem || 'NENHUMA'),\n                chance_execucao_pct: Math.max(1, Math.min(100, Number(at.chance_execucao_pct) || 100)),\n                limite_ciclos_sessao: Math.max(0, Number(at.limite_ciclos_sessao) || 0)\n            };\n            controleEstrategiaExecucao.sincronizarTrader(trader);\n            return trader;\n        });\n`
);

replaceOnce(
    'resultado final alimenta monitor',
    `                if (finalizar) {\n                    st.aguardandoResultado = false;\n`,
    `                if (finalizar) {\n                    if (est.quarentena_restante <= 0) {\n                        const tipoFinalMonitor = vencedor === est.entrada\n                            ? 'GREEN'\n                            : (vencedor === 'Tie' && est.protegerEmpate ? 'TIE' : 'RED');\n                        for (const traderMonitor of AUTO_TRADERS_MEMORIA) {\n                            const configMonitor = traderMonitor.config || {};\n                            if (\n                                traderMonitor.ativo\n                                && autoTraderAutorizaEstrategia(configMonitor, est, ROBOS_MEMORIA)\n                            ) {\n                                controleEstrategiaExecucao.registrarResultadoMonitorado(\n                                    traderMonitor,\n                                    tipoFinalMonitor\n                                );\n                            }\n                        }\n                    }\n                    st.aguardandoResultado = false;\n`
);

replaceOnce(
    'decisão de ciclo antes da entrada',
    `                                    if (!(await autorizarNovaEntradaFinanceiraTrader(trader))) {\n                                        continue;\n                                    }\n\n                                    if (cf.limite_entradas && trader.entradas_feitas >= cf.limite_entradas) {\n                                        trader.status_operacao = 'META_ATINGIDA';\n                                        try {\n                                            await dbPool.query('UPDATE auto_traders SET status_operacao=? WHERE id=?', ['META_ATINGIDA', trader.id]);\n                                        } catch(e) {\n                                            console.error(\`❌ Falha ao persistir META_ATINGIDA do trader \${trader.id}:\`, e.message);\n                                        }\n                                        continue;\n                                    }\n\n                                    if (cf.modo_camuflagem === 'PULOS') {\n                                        if (trader.pulos_restantes > 0) {\n                                            trader.pulos_restantes--;\n                                            try { await dbPool.query('UPDATE auto_traders SET pulos_restantes=? WHERE id=?', [trader.pulos_restantes, trader.id]); } catch(e) { console.error(\`❌ Falha ao persistir pulos_restantes do trader \${trader.id}:\`, e.message); }\n                                            continue;\n                                        } else {\n                                            let pMin = cf.camuflagem_pulos_min || 1;\n                                            let pMax = cf.camuflagem_pulos_max || 3;\n                                            trader.pulos_restantes = Math.floor(Math.random() * (pMax - pMin + 1)) + pMin;\n                                            try { await dbPool.query('UPDATE auto_traders SET pulos_restantes=? WHERE id=?', [trader.pulos_restantes, trader.id]); } catch(e) { console.error(\`❌ Falha ao persistir novo ciclo de pulos do trader \${trader.id}:\`, e.message); }\n                                        }\n                                    }\n`,
    `                                    const decisaoCiclo = controleEstrategiaExecucao.prepararEntrada(trader);\n                                    if (!decisaoCiclo.permitido) {\n                                        if (decisaoCiclo.motivo !== 'MONITORAMENTO') {\n                                            console.log(\`⏭️ Auto-Trader \${trader.id}: sinal ignorado pela Estratégia de Execução (\${decisaoCiclo.motivo}).\`);\n                                        }\n                                        continue;\n                                    }\n\n                                    if (!(await autorizarNovaEntradaFinanceiraTrader(trader))) {\n                                        continue;\n                                    }\n\n                                    if (cf.limite_entradas && trader.entradas_feitas >= cf.limite_entradas) {\n                                        trader.status_operacao = 'META_ATINGIDA';\n                                        try {\n                                            await dbPool.query('UPDATE auto_traders SET status_operacao=? WHERE id=?', ['META_ATINGIDA', trader.id]);\n                                        } catch(e) {\n                                            console.error(\`❌ Falha ao persistir META_ATINGIDA do trader \${trader.id}:\`, e.message);\n                                        }\n                                        continue;\n                                    }\n`
);

replaceOnce(
    'confirma tarefa do lote após ordem persistida',
    `                                        } finally {\n                                            conexao.release();\n                                        }\n                                    } catch(e) {\n`,
    `                                        } finally {\n                                            conexao.release();\n                                        }\n                                        try {\n                                            const resultadoCiclo = await controleEstrategiaExecucao.confirmarEntradaExecutada(\n                                                trader,\n                                                decisaoCiclo\n                                            );\n                                            if (resultadoCiclo.auto_desativado) {\n                                                ioServer.emit('atualizar_interface');\n                                            }\n                                        } catch (erroCiclo) {\n                                            console.error(\n                                                \`⚠️ Auto-Trader \${trader.id}: aposta confirmada, mas falhou atualização do ciclo de execução:\`,\n                                                erroCiclo.message\n                                            );\n                                        }\n                                    } catch(e) {\n`
);

const compiled = new Module(module.filename, module.parent);
compiled.filename = module.filename;
compiled.paths = module.paths;
compiled._compile(source, module.filename);
module.exports = compiled.exports;
