from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ENGINE = ROOT / 'robo-bacbo' / 'auto_pilot_ia.js'
BACKEND = ROOT / 'robo-bacbo' / 'bot2_coletor.js'
DOCS = ROOT / 'docs' / 'AUTO_PILOT_IA.md'


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: esperado exatamente 1 marcador, encontrado {count}')
    return text.replace(old, new, 1)


engine = ENGINE.read_text(encoding='utf-8')

engine = replace_once(
    engine,
    "    const contadores = new Map();\n    let execucaoEmAndamento = Promise.resolve();\n",
    "    const contadores = new Map();\n    const pendenciasForcadas = new Map();\n    let execucaoEmAndamento = Promise.resolve();\n",
    'mapa de pendências forçadas',
)

engine = replace_once(
    engine,
    "        const liveMap = await historicoLive([...existentesMap.keys()]);\n",
    "        const idsLive = [...new Set([...existentesMap.keys(), ...candidatos.map(c => String(c.id))])];\n        const liveMap = await historicoLive(idsLive);\n",
    'histórico live de candidatos arquivados',
)

engine = replace_once(
    engine,
    """                if (expirado) {
                    await conexao.query('DELETE FROM historico_resultados WHERE estrategia_id=?', [id]);
                    await conexao.query('DELETE FROM historico_disparos_robos WHERE estrategia_id=?', [id]);
                    await conexao.query('DELETE FROM estrategias WHERE id=? AND is_dinamico=true AND robo_dono_id=?', [id, robo.id]);
                } else {
                    await conexao.query('UPDATE estrategias SET ativo=false WHERE id=? AND is_dinamico=true AND robo_dono_id=?', [id, robo.id]);
                }
""",
    """                if (expirado) {
                    // Remove somente a definição. O histórico live fica preservado pelo ID determinístico
                    // para que um padrão ruim não possa reaparecer futuramente com reputação zerada.
                    await conexao.query('DELETE FROM estrategias WHERE id=? AND is_dinamico=true AND robo_dono_id=?', [id, robo.id]);
                } else {
                    await conexao.query('UPDATE estrategias SET ativo=false WHERE id=? AND is_dinamico=true AND robo_dono_id=?', [id, robo.id]);
                }
""",
    'preservação da reputação live no TTL',
)

marker_exec = """    async function executarRoboInterno(roboId, { forcar = false, motivo = 'trigger' } = {}) {
        if (typeof estaOcupado === 'function' && estaOcupado()) {
            return { executado: false, adiado: true, motivo: 'SINAL_EM_ANDAMENTO' };
        }

        const robo = await carregarRobo(roboId);
        if (!robo) return { executado: false, motivo: 'ROBO_INEXISTENTE' };
        const config = normalizarConfigAutoTuning(robo.config?.auto_tuning || {});
        if (!config.ativo) return { executado: false, motivo: 'IA_DESATIVADA' };

        const atual = Math.max(0, Number(contadores.get(Number(robo.id))) || 0);
"""
replacement_exec = """    async function desativarPadroesRobo(robo, motivo) {
        const [resultado] = await dbPool.query(
            `UPDATE estrategias SET ativo=false
             WHERE is_dinamico=true AND robo_dono_id=? AND ativo=true`,
            [robo.id]
        );
        const desativados = Math.max(0, Number(resultado.affectedRows) || 0);
        contadores.set(Number(robo.id), 0);
        const resumo = { ativos: [], reservas: 0, sombra: 0, candidatos: 0, desativados };

        if (desativados > 0 && typeof recarregarMemoria === 'function') {
            await recarregarMemoria();
        }
        if (desativados > 0 && typeof notificar === 'function') {
            notificar(robo.id, resumo);
        }

        log.log(`🤖 Auto Pilot IA ${robo.id}: ${motivo}; ${desativados} padrão(ões) ativo(s) desativado(s).`);
        return { executado: true, desativado: true, motivo, ...resumo };
    }

    async function executarRoboInterno(roboId, { forcar = false, motivo = 'trigger' } = {}) {
        const idNumerico = Number(roboId);
        if (typeof estaOcupado === 'function' && estaOcupado()) {
            if (forcar && Number.isFinite(idNumerico)) {
                pendenciasForcadas.set(idNumerico, String(motivo || 'forcado'));
            }
            return { executado: false, adiado: true, motivo: 'SINAL_EM_ANDAMENTO' };
        }

        if (Number.isFinite(idNumerico)) pendenciasForcadas.delete(idNumerico);
        const robo = await carregarRobo(roboId);
        if (!robo) return { executado: false, motivo: 'ROBO_INEXISTENTE' };
        const config = normalizarConfigAutoTuning(robo.config?.auto_tuning || {});
        const roboAtivo = robo.ativo === true || robo.ativo === 1;
        if (!roboAtivo) return desativarPadroesRobo(robo, 'ROBO_DESATIVADO');
        if (!config.ativo) return desativarPadroesRobo(robo, 'IA_DESATIVADA');

        const atual = Math.max(0, Number(contadores.get(Number(robo.id))) || 0);
"""
engine = replace_once(engine, marker_exec, replacement_exec, 'desativação e pendência de configuração')

old_todos = """    async function executarTodosInterno(opcoes = {}) {
        if (typeof estaOcupado === 'function' && estaOcupado()) {
            return { executado: false, adiado: true, motivo: 'SINAL_EM_ANDAMENTO' };
        }
        const [robos] = await dbPool.query('SELECT id, config_json FROM robos_canais WHERE ativo=true');
        const saida = [];
        for (const row of robos) {
            let config = {};
            try { config = JSON.parse(row.config_json || '{}'); } catch (e) {}
            if (!(config.auto_tuning?.ativo === true || config.auto_tuning?.ativo === 1)) continue;
            saida.push(await executarRoboInterno(row.id, opcoes));
        }
        return { executado: true, robos: saida };
    }
"""
new_todos = """    async function executarTodosInterno(opcoes = {}) {
        if (typeof estaOcupado === 'function' && estaOcupado()) {
            if (opcoes.forcar) {
                const [todosRobos] = await dbPool.query('SELECT id FROM robos_canais');
                for (const row of todosRobos) {
                    pendenciasForcadas.set(Number(row.id), String(opcoes.motivo || 'forcado'));
                }
            }
            return { executado: false, adiado: true, motivo: 'SINAL_EM_ANDAMENTO' };
        }

        const sqlRobos = opcoes.forcar
            ? 'SELECT id, ativo, config_json FROM robos_canais'
            : 'SELECT id, ativo, config_json FROM robos_canais WHERE ativo=true';
        const [robos] = await dbPool.query(sqlRobos);
        const saida = [];
        for (const row of robos) {
            let config = {};
            try { config = JSON.parse(row.config_json || '{}'); } catch (e) {}
            if (!opcoes.forcar && !(config.auto_tuning?.ativo === true || config.auto_tuning?.ativo === 1)) continue;
            saida.push(await executarRoboInterno(row.id, opcoes));
        }
        return { executado: true, robos: saida };
    }
"""
engine = replace_once(engine, old_todos, new_todos, 'execução global incluindo limpeza no startup')

old_registrar = """    async function registrarNovoGiro() {
        const [robos] = await dbPool.query('SELECT id, config_json FROM robos_canais WHERE ativo=true');
        let haDevido = false;
        for (const row of robos) {
            let config = {};
            try { config = JSON.parse(row.config_json || '{}'); } catch (e) {}
            const ia = normalizarConfigAutoTuning(config.auto_tuning || {});
            if (!ia.ativo) continue;
            const proximo = (Math.max(0, Number(contadores.get(Number(row.id))) || 0) + 1);
            contadores.set(Number(row.id), proximo);
            if (proximo >= ia.trigger) haDevido = true;
        }

        if (!haDevido) return { executado: false, motivo: 'NENHUM_TRIGGER_ATINGIDO' };
        if (typeof estaOcupado === 'function' && estaOcupado()) {
            return { executado: false, adiado: true, motivo: 'SINAL_EM_ANDAMENTO' };
        }

        return executarTodos({ forcar: false, motivo: 'trigger' });
    }
"""
new_registrar = """    async function registrarNovoGiro() {
        const ocupadoAgora = typeof estaOcupado === 'function' && estaOcupado();
        if (!ocupadoAgora && pendenciasForcadas.size > 0) {
            const pendentes = [...pendenciasForcadas.entries()];
            for (const [roboId, motivo] of pendentes) {
                await executarRobo(roboId, { forcar: true, motivo: `pendente:${motivo}` });
            }
        }

        const [robos] = await dbPool.query('SELECT id, config_json FROM robos_canais WHERE ativo=true');
        let haDevido = false;
        for (const row of robos) {
            let config = {};
            try { config = JSON.parse(row.config_json || '{}'); } catch (e) {}
            const ia = normalizarConfigAutoTuning(config.auto_tuning || {});
            if (!ia.ativo) continue;
            const proximo = (Math.max(0, Number(contadores.get(Number(row.id))) || 0) + 1);
            contadores.set(Number(row.id), proximo);
            if (proximo >= ia.trigger) haDevido = true;
        }

        if (!haDevido) return { executado: false, motivo: 'NENHUM_TRIGGER_ATINGIDO' };
        if (typeof estaOcupado === 'function' && estaOcupado()) {
            return { executado: false, adiado: true, motivo: 'SINAL_EM_ANDAMENTO' };
        }

        return executarTodos({ forcar: false, motivo: 'trigger' });
    }
"""
engine = replace_once(engine, old_registrar, new_registrar, 'processamento de pendências forçadas')

marker_reset = """    function resetarContador(roboId) {
        contadores.set(Number(roboId), 0);
    }

    return { executarRobo, executarTodos, registrarNovoGiro, resetarContador };
"""
replacement_reset = """    function reavaliarDescarteEstrategia(estrategiaId) {
        return serializar(async () => {
            if (typeof estaOcupado === 'function' && estaOcupado()) {
                return { executado: false, adiado: true, motivo: 'SINAL_EM_ANDAMENTO' };
            }

            const id = String(estrategiaId || '').trim();
            if (!id) return { executado: false, motivo: 'ESTRATEGIA_INVALIDA' };
            const [linhas] = await dbPool.query(
                `SELECT e.id, e.robo_dono_id, e.ativo, r.ativo AS robo_ativo, r.config_json
                 FROM estrategias e
                 JOIN robos_canais r ON r.id=e.robo_dono_id
                 WHERE e.id=? AND e.is_dinamico=true
                 LIMIT 1`,
                [id]
            );
            if (linhas.length === 0) return { executado: false, motivo: 'ESTRATEGIA_DINAMICA_INEXISTENTE' };

            const row = linhas[0];
            let configRobo = {};
            try { configRobo = JSON.parse(row.config_json || '{}'); } catch (e) {}
            const config = normalizarConfigAutoTuning(configRobo.auto_tuning || {});
            const [mapaLive] = [await historicoLive([id])];
            const avaliacao = avaliarDescarteLive(mapaLive.get(id) || [], config);
            if (!avaliacao.descartar) {
                return { executado: true, descartado: false, avaliacao };
            }

            await dbPool.query(
                'UPDATE estrategias SET ativo=false WHERE id=? AND is_dinamico=true',
                [id]
            );
            if (typeof recarregarMemoria === 'function') await recarregarMemoria();
            log.warn(
                `🗑️ Auto Pilot IA: padrão ${id} desativado imediatamente por ${avaliacao.motivo} `
                + `(assertividade live=${avaliacao.assertividade === null ? 'n/a' : avaliacao.assertividade.toFixed(1)}%, `
                + `streak RED=${avaliacao.streak_red}).`
            );

            const promocao = await executarRoboInterno(
                Number(row.robo_dono_id),
                { forcar: true, motivo: `descarte_live:${avaliacao.motivo}` }
            );
            return { executado: true, descartado: true, avaliacao, promocao };
        });
    }

    function resetarContador(roboId) {
        contadores.set(Number(roboId), 0);
    }

    return {
        executarRobo,
        executarTodos,
        registrarNovoGiro,
        reavaliarDescarteEstrategia,
        resetarContador
    };
"""
engine = replace_once(engine, marker_reset, replacement_reset, 'descarte live imediato')

ENGINE.write_text(engine, encoding='utf-8')

backend = BACKEND.read_text(encoding='utf-8')
backend = replace_once(
    backend,
    """        // Ao excluir o Robô/Canal, seu histórico de distribuição também deixa de ter proprietário.
        await conexao.query('DELETE FROM historico_disparos_robos WHERE robo_id=?', [roboId]);
        await conexao.query('DELETE FROM destinatarios_robo WHERE robo_id=?', [roboId]);
""",
    """        // O histórico live de padrões expirados é preservado enquanto o robô existir.
        // Na exclusão definitiva do proprietário, remove também IDs IA já arquivados pelo TTL.
        await conexao.query(
            'DELETE FROM historico_resultados WHERE estrategia_id LIKE ?',
            [`ia_${roboId}_%`]
        );

        // Ao excluir o Robô/Canal, seu histórico de distribuição também deixa de ter proprietário.
        await conexao.query('DELETE FROM historico_disparos_robos WHERE robo_id=?', [roboId]);
        await conexao.query('DELETE FROM destinatarios_robo WHERE robo_id=?', [roboId]);
""",
    'limpeza de histórico IA arquivado ao excluir robô',
)

backend = replace_once(
    backend,
    "                if (finalizar) { st.aguardandoResultado = false; st.galeAtual = 0; sinalFinalizadoAgora = true; ioServer.emit('atualizar_interface'); }\n",
    """                if (finalizar) {
                    st.aguardandoResultado = false;
                    st.galeAtual = 0;
                    sinalFinalizadoAgora = true;

                    if (est.is_dinamico) {
                        try {
                            await autoPilotIA.reavaliarDescarteEstrategia(est.id);
                        } catch (e) {
                            console.error(`⚠️ Auto Pilot IA: falha ao reavaliar descarte live de ${est.id}:`, e.message);
                        }
                    }

                    ioServer.emit('atualizar_interface');
                }
""",
    'reavaliação live após finalizar padrão IA',
)

BACKEND.write_text(backend, encoding='utf-8')

docs = DOCS.read_text(encoding='utf-8')
docs = docs.replace(
    '9. **Descarte live** — o desempenho real registrado em `historico_resultados` pode desqualificar um padrão por `drop_reds` ou `drop_assert`.\n10. **TTL como revalidação** — `ttl_horas` não mata automaticamente um padrão bom. Ao vencer, ele é reavaliado; se continuar qualificado, recebe novo ciclo. Candidatos fora do pool podem ser removidos após o TTL.\n',
    '9. **Descarte live** — após cada fechamento de um padrão IA, `drop_reds` e `drop_assert` são reavaliados. Se houver descarte, o padrão é desativado imediatamente e o portfólio é reminerado para promover a melhor reserva elegível.\n10. **TTL como revalidação** — `ttl_horas` não mata automaticamente um padrão bom. Ao vencer, ele é reavaliado; se continuar qualificado, recebe novo ciclo. Quando uma definição expirada sai do pool, seu histórico live é preservado pelo ID determinístico para impedir que um padrão ruim reapareça com reputação zerada. Esse histórico é removido na exclusão definitiva do robô proprietário.\n'
)
if 'desativado imediatamente' not in docs:
    raise RuntimeError('Documentação não recebeu atualização do descarte live')
DOCS.write_text(docs, encoding='utf-8')

print('Ciclo operacional do Auto Pilot IA endurecido com sucesso.')
