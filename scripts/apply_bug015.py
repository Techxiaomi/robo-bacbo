from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path, old, new, label):
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: esperado 1 match, encontrado {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


python = ROOT / "robo-sync-pilot" / "robo.py"
tests = ROOT / "robo-sync-pilot" / "tests" / "test_pure_logic.py"
env_example = ROOT / ".env.example"
current_state = ROOT / "docs" / "CURRENT_STATE.md"
known_issues = ROOT / "docs" / "KNOWN_ISSUES.md"
handoff = ROOT / "docs" / "GEMINI_HANDOFF.md"
changelog = ROOT / "CHANGELOG.md"

# 1) Janela conservadora de fallback quando a plataforma não fornece roundId explícito.
replace_once(
    python,
    """try:\n    EXECUTOR_ORDER_TTL_SECONDS = max(1.0, min(60.0, float(os.getenv(\"EXECUTOR_ORDER_TTL_SECONDS\", \"8\"))))\nexcept ValueError:\n    EXECUTOR_ORDER_TTL_SECONDS = 8.0\n\ntry:\n    BALANCE_SYNC_INTERVAL_SECONDS""",
    """try:\n    EXECUTOR_ORDER_TTL_SECONDS = max(1.0, min(60.0, float(os.getenv(\"EXECUTOR_ORDER_TTL_SECONDS\", \"8\"))))\nexcept ValueError:\n    EXECUTOR_ORDER_TTL_SECONDS = 8.0\n\ntry:\n    RESULT_DEDUP_WINDOW_SECONDS = max(0.5, min(10.0, float(os.getenv(\"RESULT_DEDUP_WINDOW_SECONDS\", \"3\"))))\nexcept ValueError:\n    RESULT_DEDUP_WINDOW_SECONDS = 3.0\n\ntry:\n    BALANCE_SYNC_INTERVAL_SECONDS""",
    "config dedup"
)

replace_once(
    python,
    """ultimo_tempo_rodada = 0\nCOLETOR_SESSAO = str(uuid.uuid4())\ncoletor_seq = 0\navisos_erro_limitados = {}\n""",
    """ultimo_tempo_rodada = 0\nCOLETOR_SESSAO = str(uuid.uuid4())\ncoletor_seq = 0\nultimo_resultado_chave = None\nultimo_resultado_chave_em = 0.0\navisos_erro_limitados = {}\n""",
    "estado dedup"
)

helpers = r'''def chave_resultado_resolvido(game_info):
    info = game_info if isinstance(game_info, dict) else {}

    # Prefere uma identidade explícita quando o payload disponibiliza uma.
    for campo in ("roundId", "round_id", "roundID", "roundUid", "round_uid"):
        valor = info.get(campo)
        if valor is not None and str(valor).strip():
            return ("round", campo, str(valor).strip())

    # Fallback curto: vencedor + quatro dados normalizados. A janela temporal
    # impede bloquear uma rodada futura que coincidentemente tenha o mesmo resultado.
    dados_normalizados = []
    for dado in info.get("dice", []) if isinstance(info.get("dice", []), list) else []:
        if not isinstance(dado, dict):
            continue
        identificador = dado.get("id")
        valor = dado.get("value")
        dados_normalizados.append((str(identificador), str(valor)))
    dados_normalizados.sort()

    return (
        "fingerprint",
        str(info.get("result") or ""),
        tuple(dados_normalizados)
    )


def resultado_resolvido_duplicado(game_info, agora=None):
    global ultimo_resultado_chave, ultimo_resultado_chave_em

    referencia = time.time() if agora is None else float(agora)
    chave = chave_resultado_resolvido(game_info)
    mesma_chave = chave == ultimo_resultado_chave

    if mesma_chave:
        if chave and chave[0] == "round":
            return True
        if referencia - ultimo_resultado_chave_em <= RESULT_DEDUP_WINDOW_SECONDS:
            return True

    ultimo_resultado_chave = chave
    ultimo_resultado_chave_em = referencia
    return False


'''
replace_once(
    python,
    """# ====================================================================\n# FUNÇÕES CORE DO ROBÔ (Navegação, Login e Apostas)\n# ====================================================================\ndef exibir_painel_versao():\n""",
    """# ====================================================================\n# FUNÇÕES CORE DO ROBÔ (Navegação, Login e Apostas)\n# ====================================================================\n""" + helpers + "def exibir_painel_versao():\n",
    "helpers dedup"
)

replace_once(
    python,
    """        if status_atual == \"Resolved\":\n            # Consome a sequência assim que um resultado resolvido é reconhecido.\n            # Se parsing ou POST falhar depois daqui, o próximo resultado deixará\n            # um salto observável pelo Node.\n            coletor_seq += 1\n            seq_atual = coletor_seq\n\n            resultado_bruto = game_info.get(\"result\", \"\")\n            resultado = \"Tie\" if \"Tie\" in resultado_bruto else resultado_bruto\n            \n            tempo_atual = time.time()\n""",
    """        if status_atual == \"Resolved\":\n            tempo_atual = time.time()\n            if resultado_resolvido_duplicado(game_info, tempo_atual):\n                registrar_erro_limitado(\n                    \"resultado_resolved_duplicado\",\n                    \"♻️ Frame Resolved duplicado ignorado sem consumir coletor_seq.\",\n                    10\n                )\n                return\n\n            # Consome a sequência somente depois da deduplicação da rodada resolvida.\n            # Se parsing ou POST falhar depois daqui, o próximo resultado real deixará\n            # um salto observável pelo Node.\n            coletor_seq += 1\n            seq_atual = coletor_seq\n\n            resultado_bruto = game_info.get(\"result\", \"\")\n            resultado = \"Tie\" if \"Tie\" in resultado_bruto else resultado_bruto\n            \n""",
    "dedup antes de seq"
)

# 2) Testes puros: mesmo frame não cria seq nova; roundId prevalece; fallback expira.
replace_once(
    tests,
    '        carregar_funcoes(["processar_resultado"], ns)\n',
    '        carregar_funcoes(["chave_resultado_resolvido", "resultado_resolvido_duplicado", "processar_resultado"], ns)\n',
    "extrair helpers dedup"
)
replace_once(
    tests,
    '            "coletor_seq": 0,\n            "registrar_erro_limitado": lambda chave, mensagem, intervalo_segundos=30: self.logs.append(\n',
    '            "coletor_seq": 0,\n            "ultimo_resultado_chave": None,\n            "ultimo_resultado_chave_em": 0.0,\n            "RESULT_DEDUP_WINDOW_SECONDS": 3.0,\n            "registrar_erro_limitado": lambda chave, mensagem, intervalo_segundos=30: self.logs.append(\n',
    "namespace dedup"
)
replace_once(
    tests,
    """    def test_erro_http_e_registrado_sem_propagar(self):\n""",
    """    def test_frame_resolved_identico_repetido_nao_consume_nova_seq(self):\n        dados = self.dados_resolvidos(\"PlayerWon\")\n        self.processar(dados)\n        FakeTime.atual = 101.0\n        self.processar(dados)\n\n        self.assertEqual(len(FakeRequests.chamadas), 1)\n        self.assertEqual(self.ns[\"coletor_seq\"], 1)\n        self.assertTrue(any(chave == \"resultado_resolved_duplicado\" for chave, _, _ in self.logs))\n\n    def test_fingerprint_igual_depois_da_janela_e_nova_rodada(self):\n        dados = self.dados_resolvidos(\"BankerWon\")\n        self.processar(dados)\n        FakeTime.atual = 103.001\n        self.processar(dados)\n\n        self.assertEqual(len(FakeRequests.chamadas), 2)\n        self.assertEqual(FakeRequests.chamadas[0][\"kwargs\"][\"json\"][\"coletor_seq\"], 1)\n        self.assertEqual(FakeRequests.chamadas[1][\"kwargs\"][\"json\"][\"coletor_seq\"], 2)\n\n    def test_round_id_repetido_e_ignorado_mesmo_fora_da_janela(self):\n        dados = self.dados_resolvidos(\"PlayerWon\")\n        dados[\"args\"][\"game\"][\"roundId\"] = \"round-123\"\n        self.processar(dados)\n        FakeTime.atual = 120.0\n        self.processar(dados)\n\n        self.assertEqual(len(FakeRequests.chamadas), 1)\n        self.assertEqual(self.ns[\"coletor_seq\"], 1)\n\n    def test_round_id_novo_processa_mesmo_com_mesmo_resultado_e_dados(self):\n        primeiro = self.dados_resolvidos(\"PlayerWon\")\n        primeiro[\"args\"][\"game\"][\"round_id\"] = \"r1\"\n        segundo = self.dados_resolvidos(\"PlayerWon\")\n        segundo[\"args\"][\"game\"][\"round_id\"] = \"r2\"\n        self.processar(primeiro)\n        FakeTime.atual = 100.1\n        self.processar(segundo)\n\n        self.assertEqual(len(FakeRequests.chamadas), 2)\n        self.assertEqual(self.ns[\"coletor_seq\"], 2)\n\n    def test_erro_http_e_registrado_sem_propagar(self):\n""",
    "testes dedup"
)

# O teste de falha HTTP usa PlayerWon logo após setUp, portanto continua independente.

# 3) Configuração/documentação.
replace_once(
    env_example,
    """EXECUTOR_ORDER_TTL_SECONDS=8\n# O Node aguarda este tempo total pelo callback EXECUTADA/FALHOU/EXPIRADA/AMBIGUA do executor.\n""",
    """EXECUTOR_ORDER_TTL_SECONDS=8\n# Deduplicação defensiva de frames Resolved sem roundId explícito.\nRESULT_DEDUP_WINDOW_SECONDS=3\n# O Node aguarda este tempo total pelo callback EXECUTADA/FALHOU/EXPIRADA/AMBIGUA do executor.\n""",
    "env dedup"
)
replace_once(
    current_state,
    "Atualizado em 2026-08-17 após os patches BUG-001…BUG-014C, BUG-001R, SEC-002/003A/003B/004, OBS-001A…H e OBS-003A…H.",
    "Atualizado em 2026-08-17 após os patches BUG-001…BUG-015, BUG-001R, SEC-002/003A/003B/004, OBS-001A…H e OBS-003A…H.",
    "header CURRENT_STATE"
)
replace_once(
    current_state,
    """- separação lógica de sessões após pausa, restart do coletor, salto de sequência ou buraco confirmado Python→Node;\n""",
    """- separação lógica de sessões após pausa, restart do coletor, salto de sequência ou buraco confirmado Python→Node;\n- frames `Resolved` repetidos são deduplicados no coletor antes de consumir `coletor_seq`: usa `roundId`/variantes quando disponíveis e, na ausência, vencedor+dados dentro de uma janela curta configurável;\n""",
    "CURRENT_STATE dedup"
)
replace_once(
    current_state,
    """- suíte Python `unittest` sobre parsing, payloads, transporte interno e persistência de `order_id`;\n""",
    """- suíte Python `unittest` sobre parsing, payloads, transporte interno, persistência de `order_id` e deduplicação de frames `Resolved`;\n""",
    "CURRENT_STATE tests dedup"
)

bug015 = """### BUG-015 — Frames `Resolved` repetidos podiam virar rodadas distintas\n\nStatus: **mitigado**.\n\nO callback WebSocket chamava `processar_resultado()` para todo `bacbo.playerState` em estágio `Resolved`; não havia identidade/fingerprint local antes de incrementar `coletor_seq`. Uma repetição imediata do mesmo estado poderia, portanto, ser enviada ao Node como se fosse outra rodada válida.\n\nO coletor agora deduplica antes de consumir sequência. Quando o payload traz `roundId`, `round_id`, `roundID`, `roundUid` ou `round_uid`, a identidade explícita prevalece. Sem identificador, usa resultado + dados normalizados apenas dentro de `RESULT_DEDUP_WINDOW_SECONDS` (3 s por padrão), permitindo que uma rodada futura legitimamente igual seja processada após a janela. Falha de POST continua consumindo a sequência da primeira observação, preservando a detecção de buraco do BUG-011.\n\n"""
replace_once(
    known_issues,
    "### BUG-001R — Restart do executor e exactly-once do efeito externo\n",
    bug015 + "### BUG-001R — Restart do executor e exactly-once do efeito externo\n",
    "KNOWN_ISSUES BUG015"
)

replace_once(
    handoff,
    "- BUG-014C: `/receber-sinal` reserva continuidade antes de I/O e serializa todo o processamento pós-ACK em FIFO, impedindo que uma rodada ultrapasse outra durante MySQL/callback do executor;",
    "- BUG-014C: `/receber-sinal` reserva continuidade antes de I/O e serializa todo o processamento pós-ACK em FIFO, impedindo que uma rodada ultrapasse outra durante MySQL/callback do executor;\n- BUG-015: o coletor deduplica frames `Resolved` repetidos antes de incrementar `coletor_seq`, preferindo identidade de rodada e usando fingerprint temporal curto como fallback;",
    "handoff BUG015"
)
replace_once(
    handoff,
    """- nunca apontar esse job para site, executor ou conta real.\n""",
    """- nunca apontar esse job para site, executor ou conta real;\n- ao tocar `processar_resultado`, preservar testes de frame `Resolved` duplicado, nova rodada após a janela e `roundId` distinto.\n""",
    "handoff validation BUG015"
)
replace_once(
    changelog,
    "- BUG-014C: resultados de rodada passam a reservar continuidade sincronamente antes do primeiro I/O e todo o trabalho pós-ACK de `/receber-sinal` é serializado em FIFO; a rodada seguinte pode receber ACK imediatamente, mas só altera sessão/histórico/sinais/auditoria depois da anterior liberar o turno.\n",
    "- BUG-014C: resultados de rodada passam a reservar continuidade sincronamente antes do primeiro I/O e todo o trabalho pós-ACK de `/receber-sinal` é serializado em FIFO; a rodada seguinte pode receber ACK imediatamente, mas só altera sessão/histórico/sinais/auditoria depois da anterior liberar o turno.\n- BUG-015: o coletor passa a deduplicar frames `Resolved` antes de consumir `coletor_seq`, preferindo `roundId`/variantes e usando resultado+dados numa janela curta configurável quando a plataforma não fornece identidade explícita.\n",
    "CHANGELOG BUG015"
)

print("BUG-015 patch aplicado com sucesso")
