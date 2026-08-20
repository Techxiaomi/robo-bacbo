from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ROBO = ROOT / 'robo-sync-pilot' / 'robo.py'
NODE = ROOT / 'robo-bacbo' / 'bot2_coletor.js'

# ---------------- Python executor ----------------
text = ROBO.read_text(encoding='utf-8')
original = text
text = text.replace(
    'NOME_ATUALIZACAO = "BUG-049 Composto Estavel em 8.5s"',
    'NOME_ATUALIZACAO = "BUG-050 Alvo Seguro + Ciclo Exclusivo"',
    1,
)

old_click = '''def clicar_alvo_financeiro_playwright(page, elemento):\n    """Executa o clique financeiro imediato, sem actionability estrita do Playwright."""\n    try:\n        elemento.click(force=True, timeout=2000)\n        page.wait_for_timeout(120)\n        return {"acionada": True, "relacao": "CLIQUE_PLAYWRIGHT_FORCE"}\n    except Exception as erro:\n        return {\n            "acionada": False,\n            "relacao": type(erro).__name__,\n            "motivo": f"falha no clique forcado do alvo ({type(erro).__name__})",\n        }\n'''
new_click = '''def resolver_ponto_seguro_alvo(elemento):\n    """Encontra um ponto interno cujo hit-test pertence ao alvo financeiro real."""\n    try:\n        return elemento.evaluate(\n            """el => {\n                const r = el.getBoundingClientRect();\n                if (!r || r.width <= 2 || r.height <= 2) {\n                    return {ok:false, motivo:'BOUNDING_BOX_INVALIDO'};\n                }\n                const pontos = [\n                    [0.50,0.50], [0.50,0.35], [0.50,0.65],\n                    [0.35,0.50], [0.65,0.50],\n                    [0.30,0.30], [0.70,0.30], [0.30,0.70], [0.70,0.70],\n                    [0.50,0.22], [0.50,0.78], [0.22,0.50], [0.78,0.50]\n                ];\n                const resumo = hit => ({\n                    tag: hit ? String(hit.tagName || '') : '',\n                    role: hit ? String(hit.getAttribute('data-role') || '') : '',\n                    cls: hit ? String(hit.className || '').slice(0,120) : ''\n                });\n                for (const [fx, fy] of pontos) {\n                    const vx = r.left + (r.width * fx);\n                    const vy = r.top + (r.height * fy);\n                    const hit = document.elementFromPoint(vx, vy);\n                    if (hit && (hit === el || el.contains(hit))) {\n                        return {\n                            ok:true,\n                            x:r.width * fx,\n                            y:r.height * fy,\n                            fx, fy,\n                            alvo_role:String(el.getAttribute('data-role') || ''),\n                            hit:resumo(hit)\n                        };\n                    }\n                }\n                const centro = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);\n                return {\n                    ok:false,\n                    motivo:'ALVO_COBERTO_NO_HIT_TEST',\n                    alvo_role:String(el.getAttribute('data-role') || ''),\n                    hit_centro:resumo(centro)\n                };\n            }"""\n        )\n    except Exception as erro:\n        return {"ok": False, "motivo": f"HIT_TEST_{type(erro).__name__}"}\n\n\ndef clicar_alvo_financeiro_playwright(page, elemento):\n    """Clica somente em ponto comprovadamente pertencente ao alvo financeiro."""\n    ponto = resolver_ponto_seguro_alvo(elemento)\n    if not isinstance(ponto, dict) or ponto.get("ok") is not True:\n        return {\n            "acionada": False,\n            "relacao": "PONTO_SEGURO_INDISPONIVEL",\n            "motivo": str((ponto or {}).get("motivo") or "hit-test nao confirmou o alvo"),\n            "diagnostico": ponto if isinstance(ponto, dict) else {},\n        }\n    try:\n        # Sem force=True: o ponto ja foi validado por elementFromPoint como pertencente\n        # ao alvo. Assim Playwright nao pode transformar um Tie em segundo Player/Banker.\n        elemento.click(\n            position={"x": float(ponto["x"]), "y": float(ponto["y"])},\n            timeout=1200\n        )\n        page.wait_for_timeout(120)\n        return {\n            "acionada": True,\n            "relacao": "CLIQUE_PLAYWRIGHT_ALVO_SEGURO",\n            "diagnostico": ponto,\n        }\n    except Exception as erro:\n        return {\n            "acionada": False,\n            "relacao": type(erro).__name__,\n            "motivo": f"ponto seguro confirmado, mas clique falhou ({type(erro).__name__})",\n            "diagnostico": ponto,\n        }\n'''
if old_click not in text:
    raise SystemExit('funcao clicar_alvo atual nao encontrada')
text = text.replace(old_click, new_click, 1)

old_select = '''                    precisa_selecionar = ficha_contexto.get("modo") != "JA_SELECIONADA"\n                    if precisa_selecionar:\n                        selecao = selecionar_ficha_com_confirmacao(page, ficha_contexto, ficha)\n'''
new_select = '''                    # A mesma denominacao continua selecionada entre Player/Banker e Tie.\n                    # Nao reclica a ficha R$5 entre pernas iguais: o reclick era ruido\n                    # desnecessario no intervalo financeiro composto.\n                    precisa_selecionar = ficha_corrente != int(ficha)\n                    if precisa_selecionar:\n                        selecao = selecionar_ficha_com_confirmacao(page, ficha_contexto, ficha)\n'''
if old_select not in text:
    raise SystemExit('selecao composta BUG-049 nao encontrada')
text = text.replace(old_select, new_select, 1)

old_print = '''                        print(\n                            f"⚡ COMPOSTO: clique {cliques_alvo} enviado para "\n                            f"R$ {int(ficha)} {plano['alvo']} via {alvo_real.get('relacao', 'n/a')}."\n                        )\n'''
new_print = '''                        diag_alvo = alvo_real.get("diagnostico") if isinstance(alvo_real, dict) else {}\n                        hit_alvo = diag_alvo.get("hit", {}) if isinstance(diag_alvo, dict) else {}\n                        print(\n                            f"⚡ COMPOSTO: clique {cliques_alvo} enviado para "\n                            f"R$ {int(ficha)} {plano['alvo']} via {alvo_real.get('relacao', 'n/a')}; "\n                            f"role={diag_alvo.get('alvo_role', 'n/a')}, hit_role={hit_alvo.get('role', '') or 'descendente'}."\n                        )\n'''
if old_print not in text:
    raise SystemExit('log composto atual nao encontrado')
text = text.replace(old_print, new_print, 1)

if 'elemento.click(force=True, timeout=2000)' in text[text.index('def clicar_alvo_financeiro_playwright'):text.index('def confirmar_aceite_financeiro_aposta')]:
    raise SystemExit('force=True permaneceu no clique financeiro do alvo')
if 'page.wait_for_timeout(2500)' not in text[text.index('def confirmar_aceite_financeiro_aposta'):text.index('def executar_aposta_na_tela')]:
    raise SystemExit('espera financeira de 2500ms desapareceu')
ROBO.write_text(text, encoding='utf-8')

# ---------------- Node backend ----------------
node = NODE.read_text(encoding='utf-8')
node_original = node

old_exec_head = '''async function enviarOrdemAoExecutor(alvo, valor, orderId = crypto.randomUUID(), apostas = null) {\n    const esperaExecucao = criarEsperaResultadoExecutor(orderId);\n    let ultimoErro = null;\n    let confirmacaoAceite = null;\n\n    try {\n'''
new_exec_head = '''async function enviarOrdemAoExecutor(alvo, valor, orderId = crypto.randomUUID(), apostas = null) {\n    const esperaExecucao = criarEsperaResultadoExecutor(orderId);\n    let ultimoErro = null;\n    let confirmacaoAceite = null;\n    const planoLog = Array.isArray(apostas) && apostas.length > 0\n        ? apostas.map(perna => `${perna.alvo}=R$${Number(perna.valor || 0).toFixed(2)}`).join(' + ')\n        : `${alvo}=R$${Number(valor || 0).toFixed(2)}`;\n    const exposicaoLog = Array.isArray(apostas) && apostas.length > 0\n        ? apostas.reduce((total, perna) => total + (Number(perna.valor) || 0), 0)\n        : Number(valor || 0);\n    console.log(\n        `📤 EXECUTOR | order_id=${orderId} | plano=${planoLog} | `\n        + `exposição=R$${Number(exposicaoLog || 0).toFixed(2)}`\n    );\n\n    try {\n'''
if old_exec_head not in node:
    raise SystemExit('cabecalho enviarOrdemAoExecutor nao encontrado')
node = node.replace(old_exec_head, new_exec_head, 1)

old_status = '''        const resultadoExecucao = resultadoAntecipado || await esperaExecucao.promessa;\n        if (resultadoExecucao.status !== 'EXECUTADA') {\n            throw erroResultadoExecucaoExecutor(resultadoExecucao);\n        }\n\n        const exposicaoEsperadaNode = Array.isArray(apostas) && apostas.length > 0\n'''
new_status = '''        const resultadoExecucao = resultadoAntecipado || await esperaExecucao.promessa;\n        if (resultadoExecucao.status !== 'EXECUTADA') {\n            console.error(\n                `❌ EXECUTOR | order_id=${orderId} | status=${resultadoExecucao.status} | `\n                + `plano=${planoLog} | motivo=${String(resultadoExecucao.motivo || 'sem motivo')}`\n            );\n            throw erroResultadoExecucaoExecutor(resultadoExecucao);\n        }\n\n        const evidenciaLog = resultadoExecucao.confirmacao || {};\n        console.log(\n            `✅ EXECUTOR | order_id=${orderId} | plano=${planoLog} | método=${evidenciaLog.metodo || 'n/a'} | `\n            + `saldo=${Number(evidenciaLog.saldo_antes).toFixed(2)}→${Number(evidenciaLog.saldo_depois).toFixed(2)} | `\n            + `débito=R$${Number(evidenciaLog.debito_observado || 0).toFixed(2)} | `\n            + `esperado=R$${Number(evidenciaLog.exposicao_esperada || exposicaoLog || 0).toFixed(2)}`\n        );\n\n        const exposicaoEsperadaNode = Array.isArray(apostas) && apostas.length > 0\n'''
if old_status not in node:
    raise SystemExit('bloco status executor nao encontrado')
node = node.replace(old_status, new_status, 1)

old_union = '''function unirRobosInscritos(...listas) {\n    const unicos = new Map();\n\n    for (const lista of listas) {\n        for (const robo of (Array.isArray(lista) ? lista : [])) {\n            if (robo && robo.id !== undefined && robo.id !== null) {\n                unicos.set(String(robo.id), snapshotPublicoRobo(robo));\n            }\n        }\n    }\n\n    return [...unicos.values()];\n}\n\nasync function selecionarRobosParaEstrategia(est) {\n'''
new_union = '''function unirRobosInscritos(...listas) {\n    const unicos = new Map();\n\n    for (const lista of listas) {\n        for (const robo of (Array.isArray(lista) ? lista : [])) {\n            if (robo && robo.id !== undefined && robo.id !== null) {\n                unicos.set(String(robo.id), snapshotPublicoRobo(robo));\n            }\n        }\n    }\n\n    return [...unicos.values()];\n}\n\nfunction ciclosAtivosPorRobo() {\n    const ciclos = new Map();\n    for (const [estrategiaId, estado] of Object.entries(estadoApostas || {})) {\n        if (!estado || estado.aguardandoResultado !== true) continue;\n        const robosCiclo = Array.isArray(estado.robosCiclo) && estado.robosCiclo.length > 0\n            ? estado.robosCiclo\n            : (Array.isArray(estado.robosInscritos) ? estado.robosInscritos : []);\n        for (const robo of robosCiclo) {\n            if (!robo || robo.id === undefined || robo.id === null) continue;\n            ciclos.set(String(robo.id), {\n                estrategia_id: String(estrategiaId),\n                gale_atual: Math.max(0, Number(estado.galeAtual) || 0)\n            });\n        }\n    }\n    return ciclos;\n}\n\nasync function selecionarRobosParaEstrategia(est) {\n'''
if old_union not in node:
    raise SystemExit('unirRobosInscritos nao encontrado')
node = node.replace(old_union, new_union, 1)

node = node.replace(
    '''    if (est.quarentena_restante > 0) {\n        return { web: [], telegram: [], assertividade: 0 };\n    }\n\n    const assertividade = await calcularAssertividadePersistidaEstrategia(est);\n    const elegiveis = ROBOS_MEMORIA.filter(robo => {\n''',
    '''    if (est.quarentena_restante > 0) {\n        return { todos: [], web: [], telegram: [], bloqueados: [], assertividade: 0 };\n    }\n\n    const assertividade = await calcularAssertividadePersistidaEstrategia(est);\n    const ciclosAtivos = ciclosAtivosPorRobo();\n    const bloqueados = [];\n    const elegiveis = ROBOS_MEMORIA.filter(robo => {\n''',
    1,
)
old_filter = '''        return ativo\n            && !roboEmStandby(robo)\n            && assertividade >= minAssert\n            && roboSintonizaEstrategia(robo, est);\n    });\n\n    const web = elegiveis\n'''
new_filter = '''        const sintoniza = ativo\n            && !roboEmStandby(robo)\n            && assertividade >= minAssert\n            && roboSintonizaEstrategia(robo, est);\n        if (!sintoniza) return false;\n        const ciclo = ciclosAtivos.get(String(robo.id));\n        if (ciclo) {\n            bloqueados.push({ ...snapshotPublicoRobo(robo), ...ciclo });\n            return false;\n        }\n        return true;\n    });\n\n    const todos = elegiveis.map(snapshotPublicoRobo);\n    const web = elegiveis\n'''
if old_filter not in node:
    raise SystemExit('filtro selecionarRobos nao encontrado')
node = node.replace(old_filter, new_filter, 1)
old_return = '''    return {\n        web,\n        telegram,\n        assertividade: Number(assertividade.toFixed(1))\n    };\n}\n'''
new_return = '''    return {\n        todos,\n        web,\n        telegram,\n        bloqueados,\n        assertividade: Number(assertividade.toFixed(1))\n    };\n}\n'''
if old_return not in node:
    raise SystemExit('retorno selecionarRobos nao encontrado')
node = node.replace(old_return, new_return, 1)

old_telegram_union = '''    estado.robosTelegramInscritos = inscritos;\n    estado.robosInscritos = unirRobosInscritos(estado.robosWebInscritos, inscritos);\n    return inscritos;\n'''
new_telegram_union = '''    estado.robosTelegramInscritos = inscritos;\n    estado.robosInscritos = unirRobosInscritos(estado.robosCiclo, estado.robosWebInscritos, inscritos);\n    return inscritos;\n'''
if old_telegram_union not in node:
    raise SystemExit('uniao Telegram nao encontrada')
node = node.replace(old_telegram_union, new_telegram_union, 1)

old_state = '''                        estadoApostas[est.id] = {\n                            aguardandoResultado: true,\n                            galeAtual: 0,\n                            robosWebInscritos: selecaoRobos.web,\n                            robosTelegramInscritos: [],\n                            robosInscritos: unirRobosInscritos(selecaoRobos.web),\n                            assertividadeSinal: selecaoRobos.assertividade,\n'''
new_state = '''                        if (!Array.isArray(selecaoRobos.todos) || selecaoRobos.todos.length === 0) {\n                            const bloqueios = (Array.isArray(selecaoRobos.bloqueados) ? selecaoRobos.bloqueados : [])\n                                .map(item => `${item.id}:${item.nome} em ${item.estrategia_id} (${item.gale_atual > 0 ? `GALE ${item.gale_atual}` : 'DIRETO'})`)\n                                .join(', ');\n                            console.log(\n                                `🔒 Sinal ${est.id} suprimido: nenhum robô livre para novo ciclo.`\n                                + `${bloqueios ? ` Ocupados: ${bloqueios}.` : ''}`\n                            );\n                            continue;\n                        }\n\n                        estadoApostas[est.id] = {\n                            aguardandoResultado: true,\n                            galeAtual: 0,\n                            robosCiclo: unirRobosInscritos(selecaoRobos.todos),\n                            robosWebInscritos: selecaoRobos.web,\n                            robosTelegramInscritos: [],\n                            robosInscritos: unirRobosInscritos(selecaoRobos.todos),\n                            assertividadeSinal: selecaoRobos.assertividade,\n'''
if old_state not in node:
    raise SystemExit('criacao estadoApostas nao encontrada')
node = node.replace(old_state, new_state, 1)

old_default = '''novoEstado[est.id] = estadoApostas[est.id] || { aguardandoResultado: false, galeAtual: 0, robosInscritos: [], mensagensEntrada: [], mensagensGale: [] };'''
new_default = '''novoEstado[est.id] = estadoApostas[est.id] || { aguardandoResultado: false, galeAtual: 0, robosCiclo: [], robosInscritos: [], mensagensEntrada: [], mensagensGale: [] };'''
if old_default not in node:
    raise SystemExit('default estadoApostas nao encontrado')
node = node.replace(old_default, new_default, 1)

if node == node_original:
    raise SystemExit('nenhuma alteracao Node aplicada')
NODE.write_text(node, encoding='utf-8')
print('BUG-050 aplicado em robo.py e bot2_coletor.js')
