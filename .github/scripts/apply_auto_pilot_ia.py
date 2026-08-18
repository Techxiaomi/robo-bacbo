from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / 'robo-bacbo' / 'bot2_coletor.js'
FRONTEND = ROOT / 'robo-bacbo' / 'public' / 'dashboard-app.html'
ENGINE = ROOT / 'robo-bacbo' / 'auto_pilot_ia.js'


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: esperado exatamente 1 marcador, encontrado {count}')
    return text.replace(old, new, 1)


backend = BACKEND.read_text(encoding='utf-8')

backend = replace_once(
    backend,
    'const { Server } = require("socket.io");\n',
    'const { Server } = require("socket.io");\nconst { criarAutoPilotService } = require("./auto_pilot_ia");\n',
    'require Auto Pilot IA',
)

marker_server = '''const ioServer = new Server(server, {
    allowRequest: (req, callback) => {
        const host = req.headers.host;
        const hostPermitido = hostPermitidoParaNode(host, NODE_HOST, PORTA);
        const origemPermitida = origemCombinaComHost(req.headers.origin, host);
        const authAdminPermitida = !ADMIN_AUTH_REQUIRED
            || sessaoAdminValidaCookie(req.headers.cookie);
        callback(
            null,
            backendPronto && hostPermitido && origemPermitida && authAdminPermitida
        );
    }
});
'''
insert_server = marker_server + '''
const autoPilotIA = criarAutoPilotService({
    dbPool,
    estaOcupado: () => Object.values(estadoApostas).some(estado => estado && estado.aguardandoResultado),
    recarregarMemoria: carregarSistemasParaMemoria,
    notificar: (roboId, resumo) => {
        ioServer.emit('atualizar_robos');
        ioServer.emit('atualizar_interface');
        console.log(
            `🧠 Auto Pilot IA ${roboId}: ${resumo.ativos.length} ativo(s), `
            + `${resumo.reservas} reserva(s), ${resumo.sombra} sombra.`
        );
    },
    log: console
});
'''
backend = replace_once(backend, marker_server, insert_server, 'instancia Auto Pilot IA')

backend = replace_once(
    backend,
    "const [countDinamicos] = await dbPool.query('SELECT robo_dono_id, COUNT(id) as qtd FROM estrategias WHERE is_dinamico = true GROUP BY robo_dono_id');",
    "const [countDinamicos] = await dbPool.query(`SELECT robo_dono_id, COUNT(id) AS qtd_total, SUM(ativo = true) AS qtd_ativos, SUM(ativo = false AND quarentena_restante = 0) AS qtd_reserva, SUM(ativo = false AND quarentena_restante > 0) AS qtd_sombra FROM estrategias WHERE is_dinamico = true GROUP BY robo_dono_id`);",
    'contagem IA por estado',
)

backend = replace_once(
    backend,
    '                qtd_padroes_ia: contagemIA ? contagemIA.qtd : 0,\n',
    "                qtd_padroes_ia: contagemIA ? Number(contagemIA.qtd_ativos || 0) : 0,\n                qtd_padroes_ia_ativos: contagemIA ? Number(contagemIA.qtd_ativos || 0) : 0,\n                qtd_padroes_ia_reserva: contagemIA ? Number(contagemIA.qtd_reserva || 0) : 0,\n                qtd_padroes_ia_sombra: contagemIA ? Number(contagemIA.qtd_sombra || 0) : 0,\n                qtd_padroes_ia_total: contagemIA ? Number(contagemIA.qtd_total || 0) : 0,\n",
    'payload contagem IA',
)

old_post = "        await carregarSistemasParaMemoria(); ioServer.emit('atualizar_robos'); res.json({ sucesso: true });\n"
new_post = """        await carregarSistemasParaMemoria();
        autoPilotIA.resetarContador(roboId);
        try {
            await autoPilotIA.executarRobo(roboId, { forcar: true, motivo: 'config_criacao' });
        } catch (e) {
            console.error(`⚠️ Robô ${roboId}: mineração IA inicial falhou, configuração foi preservada:`, e.message);
        }
        ioServer.emit('atualizar_robos');
        res.json({ sucesso: true });
"""
backend = replace_once(backend, old_post, new_post, 'POST /api/robo')

old_put = """        await carregarSistemasParaMemoria();
        ioServer.emit('atualizar_robos');
        res.json({
            sucesso: true,
            stop_reds_resetado: reativando || stopMudou
        });
"""
new_put = """        await carregarSistemasParaMemoria();
        autoPilotIA.resetarContador(id);
        try {
            await autoPilotIA.executarRobo(id, { forcar: true, motivo: 'config_edicao' });
        } catch (e) {
            console.error(`⚠️ Robô ${id}: remineração IA após edição falhou, configuração foi preservada:`, e.message);
        }
        ioServer.emit('atualizar_robos');
        res.json({
            sucesso: true,
            stop_reds_resetado: reativando || stopMudou
        });
"""
backend = replace_once(backend, old_put, new_put, 'PUT /api/robo/:id')

backend = replace_once(
    backend,
    "        try {\n            const timestampColetaNumero = Number(dados.timestamp_coleta);\n",
    "        let giroPersistidoParaIA = false;\n        try {\n            const timestampColetaNumero = Number(dados.timestamp_coleta);\n",
    'flag giro persistido',
)

backend = replace_once(
    backend,
    "                timestamp_ms: timestampGiroAnalitico\n            });\n        } catch(e) {\n            console.error('❌ Falha ao persistir giro recente:', e.message);\n        }\n\n        historicoRecente.push({ resultado: vencedor, placarStr: `[P:${p1+p2} B:${b1+b2}]`, id_sessao: idSessaoContinua });\n        if (historicoRecente.length > 30) historicoRecente.shift();\n        let sinalFinalizadoAgora = false;\n",
    "                timestamp_ms: timestampGiroAnalitico\n            });\n            giroPersistidoParaIA = true;\n        } catch(e) {\n            console.error('❌ Falha ao persistir giro recente:', e.message);\n        }\n\n        historicoRecente.push({ resultado: vencedor, placarStr: `[P:${p1+p2} B:${b1+b2}]`, id_sessao: idSessaoContinua });\n        if (historicoRecente.length > 30) historicoRecente.shift();\n\n        if (giroPersistidoParaIA) {\n            try {\n                await autoPilotIA.registrarNovoGiro();\n            } catch (e) {\n                console.error('⚠️ Auto Pilot IA: mineração periódica falhou sem interromper a rodada:', e.message);\n            }\n        }\n\n        let sinalFinalizadoAgora = false;\n",
    'trigger após giro',
)

old_start = """async function iniciarApp() {
    await prepararBancoDeDados();
    await carregarHistoricoGirosAnalitico();
    await carregarSistemasParaMemoria();
    backendPronto = true;
    console.log("✅ Backend inicializado e pronto para atender APIs.");
}
"""
new_start = """async function iniciarApp() {
    await prepararBancoDeDados();
    await carregarHistoricoGirosAnalitico();
    await carregarSistemasParaMemoria();
    try {
        await autoPilotIA.executarTodos({ forcar: true, motivo: 'startup' });
    } catch (e) {
        console.error('⚠️ Auto Pilot IA não conseguiu revalidar no startup; backend continuará com o estado persistido:', e.message);
    }
    backendPronto = true;
    console.log("✅ Backend inicializado e pronto para atender APIs.");
}
"""
backend = replace_once(backend, old_start, new_start, 'startup Auto Pilot IA')

BACKEND.write_text(backend, encoding='utf-8')

frontend = FRONTEND.read_text(encoding='utf-8')

old_ui_motor = '<div class="form-group" style="flex:1; min-width:90px;"><label>Tam. Máximo:</label><input type="number" id="robo-ia-tam-max" value="5" min="2" max="6"></div>'
new_ui_motor = old_ui_motor + '\n                            <div class="form-group" style="flex:1; min-width:150px;"><label>Perfil de Seleção:</label><select id="robo-ia-perfil"><option value="CONSERVADOR">Conservador</option><option value="BALANCEADO" selected>Balanceado</option><option value="AGRESSIVO">Agressivo</option></select></div>'
frontend = replace_once(frontend, old_ui_motor, new_ui_motor, 'UI perfil seleção')

frontend = replace_once(
    frontend,
    'placeholder="Ex: P,B,P,B , B,P,B,P"',
    'placeholder="Ex: P,B,P,B ; B,P,B,P"',
    'placeholder blacklist',
)

frontend = replace_once(
    frontend,
    "            preencherCampoRobo('robo-ia-tam-max', 5);\n            preencherCampoRobo('robo-ia-assert', 95);\n",
    "            preencherCampoRobo('robo-ia-tam-max', 5);\n            preencherCampoRobo('robo-ia-perfil', 'BALANCEADO');\n            preencherCampoRobo('robo-ia-assert', 95);\n",
    'default perfil UI',
)

frontend = replace_once(
    frontend,
    "            preencherCampoRobo('robo-ia-drop-reds', 1);\n",
    "            preencherCampoRobo('robo-ia-drop-reds', 2);\n",
    'default drop reds novo robô',
)

frontend = replace_once(
    frontend,
    "            preencherCampoRobo('robo-ia-tam-max', ia.tam_max ?? 5);\n            preencherCampoRobo('robo-ia-assert', ia.assert_min ?? 95);\n",
    "            preencherCampoRobo('robo-ia-tam-max', ia.tam_max ?? 5);\n            preencherCampoRobo('robo-ia-perfil', ia.perfil_selecao || 'BALANCEADO');\n            preencherCampoRobo('robo-ia-assert', ia.assert_min ?? 95);\n",
    'editar perfil UI',
)

frontend = replace_once(
    frontend,
    "            preencherCampoRobo('robo-ia-drop-reds', ia.drop_reds ?? 1);\n",
    "            preencherCampoRobo('robo-ia-drop-reds', ia.drop_reds ?? 2);\n",
    'fallback drop reds UI',
)

frontend = replace_once(
    frontend,
    "                    tam_max: parseInt(document.getElementById('robo-ia-tam-max').value) || 5,\n                    assert_min: parseFloat(document.getElementById('robo-ia-assert').value) || 95,\n",
    "                    tam_max: parseInt(document.getElementById('robo-ia-tam-max').value) || 5,\n                    perfil_selecao: document.getElementById('robo-ia-perfil').value || 'BALANCEADO',\n                    assert_min: parseFloat(document.getElementById('robo-ia-assert').value) || 95,\n",
    'payload perfil UI',
)

frontend = replace_once(
    frontend,
    "<span style=\"background:#111; padding:4px 7px; border-radius:4px;\">⚡ IA: <strong>${Number(robo.qtd_padroes_ia || 0)}</strong></span>",
    "<span style=\"background:#111; padding:4px 7px; border-radius:4px;\">⚡ IA: <strong>${Number(robo.qtd_padroes_ia_ativos ?? robo.qtd_padroes_ia ?? 0)}</strong> <small style=\"color:#888;\">(+${Number(robo.qtd_padroes_ia_reserva || 0)} reserva / ${Number(robo.qtd_padroes_ia_sombra || 0)} sombra)</small></span>",
    'card contagem IA',
)

FRONTEND.write_text(frontend, encoding='utf-8')

engine = ENGINE.read_text(encoding='utf-8')
engine = replace_once(
    engine,
    'drop_reds: inteiroLimitado(config.drop_reds, 1, 0, 100),',
    'drop_reds: inteiroLimitado(config.drop_reds, 2, 0, 100),',
    'default drop reds engine',
)
ENGINE.write_text(engine, encoding='utf-8')

print('Auto Pilot IA aplicado com sucesso.')
