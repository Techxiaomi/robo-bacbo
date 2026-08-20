from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ROBO = ROOT / "robo-sync-pilot" / "robo.py"
text = ROBO.read_text(encoding="utf-8")
original = text

text = text.replace(
    'NOME_ATUALIZACAO = "BUG-048 Burst Composto + Debito Agregado"',
    'NOME_ATUALIZACAO = "BUG-049 Composto Estavel em 8.5s"',
    1,
)

# A mesa real mostrou sucesso da perna principal em ~8.5s e falha quando o novo
# fast path antecipou para ~8.3s. Mantem a ancora Resolved+8s, mas aplica 500ms
# fixos de assentamento, sem voltar ao loop de actionability que atrasava ate 18s.
old_time = 'alvo_temporal = resolved_base + 8.0 if resolved_base > 0 else 0.0'
new_time = 'alvo_temporal = resolved_base + 8.5 if resolved_base > 0 else 0.0'
if old_time not in text:
    raise SystemExit("ancora temporal BUG-048 nao encontrada")
text = text.replace(old_time, new_time, 1)
text = text.replace('janela real alvo em +8000ms;', 'janela real alvo em +8500ms;', 1)
text = text.replace(
    'f"+8s atingido sem todos os elementos DOM visiveis; fast path nao aguardou actionability; "',
    'f"+8.5s atingido sem todos os elementos DOM visiveis; fast path nao aguardou actionability; "',
    1,
)

start_marker = '''        # BUG-048: planos compostos precisam entrar na mesma janela real. No modelo\n'''
end_marker = '''        for plano in planos:\n            alvo_elemento = contexto_dom["alvos"].get(plano["seletor_alvo"])\n'''
start = text.find(start_marker)
if start < 0:
    raise SystemExit("inicio do burst BUG-048 nao encontrado")
end = text.find(end_marker, start)
if end < 0:
    raise SystemExit("fim real do burst BUG-048 nao encontrado")

new_compound = '''        # BUG-049: a principal que funcionou em mesa real saiu em ~8.5s. Em plano\n        # composto, executa as duas pernas na mesma janela, mas nao cola os cliques:\n        # cada perna relocaliza/revalida o DOM e a ficha, com uma pausa curta entre\n        # elas. A confirmacao de saldo continua somente depois de todas as pernas.\n        if len(planos) > 1:\n            total_composto = float(sum(p["valor"] for p in planos))\n            tentativas_compostas = []\n            ficha_corrente = None\n\n            for indice_plano, plano in enumerate(planos):\n                if aposta.get("sincronizar_janela") is True:\n                    contexto_atual = avaliar_contexto_janela_aposta(aposta)\n                    if contexto_atual["estado"] != "ABERTA":\n                        return {\n                            "status": "AMBIGUA" if cliques_alvo > 0 else "EXPIRADA",\n                            "motivo": (\n                                "Janela estrutural fechou durante o plano composto; "\n                                f"stage={contexto_atual['stage'] or 'vazio'}, "\n                                f"seq={contexto_atual['seq_atual']}/{contexto_atual['seq_ordem']}"\n                            ),\n                            "cliques_alvo": cliques_alvo,\n                        }\n\n                alvo_elemento = primeiro_elemento_dom_visivel(\n                    frame_jogo.locator(f"[data-role='{plano['seletor_alvo']}']")\n                )\n                if alvo_elemento is None:\n                    return {\n                        "status": "AMBIGUA" if cliques_alvo > 0 else "FALHOU",\n                        "motivo": f"Alvo {plano['alvo']} ausente/oculto durante o plano composto",\n                        "cliques_alvo": cliques_alvo,\n                    }\n\n                for ficha, qtd in plano["cliques_necessarios"]:\n                    ficha_contexto, _, _ = localizar_ficha_apostavel(frame_jogo, ficha)\n                    if ficha_contexto is None:\n                        return {\n                            "status": "AMBIGUA" if cliques_alvo > 0 else "FALHOU",\n                            "motivo": f"Ficha R$ {ficha} ausente/oculta durante o plano composto",\n                            "cliques_alvo": cliques_alvo,\n                        }\n\n                    precisa_selecionar = ficha_contexto.get("modo") != "JA_SELECIONADA"\n                    if precisa_selecionar:\n                        selecao = selecionar_ficha_com_confirmacao(page, ficha_contexto, ficha)\n                        if selecao.get("confirmada") is not True:\n                            return {\n                                "status": "AMBIGUA" if cliques_alvo > 0 else "FALHOU",\n                                "motivo": f"Ficha R$ {ficha} nao confirmou selecao antes de {plano['alvo']}: {selecao.get('motivo', 'motivo desconhecido')}",\n                                "cliques_alvo": cliques_alvo,\n                            }\n                        print(\n                            f"✅ Ficha R$ {ficha} preparada para {plano['alvo']} "\n                            f"({selecao.get('via', 'n/a')})."\n                        )\n                    ficha_corrente = int(ficha)\n\n                    for _ in range(int(qtd)):\n                        if aposta.get("sincronizar_janela") is True:\n                            contexto_atual = avaliar_contexto_janela_aposta(aposta)\n                            if contexto_atual["estado"] != "ABERTA":\n                                return {\n                                    "status": "AMBIGUA" if cliques_alvo > 0 else "EXPIRADA",\n                                    "motivo": (\n                                        "Janela estrutural fechou antes de concluir o plano composto; "\n                                        f"stage={contexto_atual['stage'] or 'vazio'}"\n                                    ),\n                                    "cliques_alvo": cliques_alvo,\n                                }\n\n                        alvo_real = clicar_alvo_financeiro_playwright(page, alvo_elemento)\n                        if alvo_real.get("acionada") is not True:\n                            return {\n                                "status": "AMBIGUA" if cliques_alvo > 0 else "FALHOU",\n                                "motivo": (\n                                    f"Falha no clique composto em {plano['alvo']}: "\n                                    f"{alvo_real.get('motivo', alvo_real.get('relacao', 'motivo desconhecido'))}"\n                                ),\n                                "cliques_alvo": cliques_alvo,\n                            }\n                        cliques_alvo += 1\n                        tentativas_compostas.append({\n                            "alvo": plano["alvo"],\n                            "ficha": int(ficha),\n                            "superficie": alvo_real.get("relacao"),\n                        })\n                        print(\n                            f"⚡ COMPOSTO: clique {cliques_alvo} enviado para "\n                            f"R$ {int(ficha)} {plano['alvo']} via {alvo_real.get('relacao', 'n/a')}."\n                        )\n\n                if indice_plano < len(planos) - 1:\n                    page.wait_for_timeout(250)\n\n            confirmacao_composta = confirmar_aceite_financeiro_aposta(\n                page, saldo_antes, total_composto\n            )\n            debito_observado = float(confirmacao_composta.get("debito_observado") or 0.0)\n            if confirmacao_composta.get("confirmada") is not True:\n                tolerancia = max(0.01, float(EXECUTOR_BET_ACCEPTANCE_TOLERANCE))\n                if debito_observado > tolerancia and debito_observado < total_composto - tolerancia:\n                    motivo = (\n                        f"Debito parcial no plano composto: R$ {debito_observado:.2f} de "\n                        f"R$ {total_composto:.2f}; uma ou mais pernas nao foram aceitas"\n                    )\n                elif abs(debito_observado) <= tolerancia:\n                    motivo = f"Nenhum debito confirmado no plano composto; esperado R$ {total_composto:.2f}"\n                else:\n                    motivo = str(confirmacao_composta.get("motivo") or "Debito composto nao confirmado")\n                print(f"🚨 {motivo}.")\n                return {\n                    "status": "AMBIGUA",\n                    "motivo": motivo,\n                    "cliques_alvo": cliques_alvo,\n                    "confirmacao": {\n                        **confirmacao_composta,\n                        "confirmada": False,\n                        "metodo": "SALDO_COMPOSTO_NAO_CONFIRMADO",\n                        "pernas_tentadas": tentativas_compostas,\n                    },\n                }\n\n            print(\n                f"✅ PLANO COMPOSTO ACEITO: debito agregado R$ {total_composto:.2f} confirmado; "\n                f"saldo R$ {confirmacao_composta['saldo_antes']:.2f} -> "\n                f"R$ {confirmacao_composta['saldo_depois']:.2f}."\n            )\n            confirmacao_composta["pernas_tentadas"] = tentativas_compostas\n            return {\n                "status": "EXECUTADA",\n                "motivo": "Plano composto confirmado por debito agregado do saldo disponivel",\n                "cliques_alvo": cliques_alvo,\n                "confirmacao": confirmacao_composta,\n            }\n\n'''
text = text[:start] + new_compound + text[end:]

if 'aguardando DOM acionável' in text:
    raise SystemExit("loop antigo de actionability reapareceu")
confirm_start = text.index('def confirmar_aceite_financeiro_aposta')
confirm_end = text.index('\ndef executar_aposta_na_tela', confirm_start)
confirm_body = text[confirm_start:confirm_end]
if confirm_body.index('page.wait_for_timeout(2500)') >= confirm_body.index('saldo_atual = ler_saldo_atual(page)'):
    raise SystemExit("contrato de 2500ms antes do saldo foi quebrado")

if text == original:
    raise SystemExit("nenhuma alteracao BUG-049 aplicada")
ROBO.write_text(text, encoding="utf-8")
print("BUG-049 aplicado")
