# Baseline validada — 2026-08-17

## Referência congelada

- `main` validada: `c86c44502f325e077db6a60ea69bf87b8f0133f1`
- snapshot imutável: `stable/2026-08-17-validated-baseline`
- escopo: Node.js (`robo-bacbo`) + executor Python (`robo-sync-pilot`) + integração MySQL/Socket.IO/Playwright já existente.

## Smoke test integrado sem apostas

Validação operacional executada com o Auto-Trader `teste` desligado e sem fontes financeiras vinculadas.

Condições observadas:

- `/api/saldo-global`: `saldo_atual=15`, `fresco=true`;
- Auto-Trader: `ativo=false`, `status_operacao=DESLIGADO`, `fontes_sinal=[]`;
- auditoria de ordens antes do teste: `0` registros;
- auditoria de ordens depois de três rodadas reais da mesa: `0` registros;
- Python continuou coletando resultados da Evolution;
- Node continuou processando rodadas e sinais;
- Robôs/Canais puderam entregar Telegram normalmente;
- nenhum log de `/apostar`, ordem recebida/executada, ficha, alvo PLAYER/BANKER ou `executor_order_id` foi observado.

Conclusão: a coleta de resultados e a geração/distribuição de sinais permanecem independentes da execução financeira. Com o Auto-Trader desligado, nenhuma nova ordem foi criada durante o smoke test.

## Itens funcionais encerrados nesta baseline

- BUG-001/001B — confirmação do executor e idempotência enquanto o processo do executor permanece vivo;
- BUG-002 — `STANDBY` promovido para `OPERANDO` ao sincronizar com rodada válida;
- BUG-003 — edição/toggle preserva saldo;
- BUG-004 — interrupção de fluxo rotaciona sessão;
- BUG-005 — considerado **mitigado**: `historico_resultados` é persistido no fechamento de cada sinal e `historico_disparos_robos` é persistido para robôs que efetivamente participaram por canal implementado; BUG-007B/007C completam a cobertura Web/Telegram sem duplicação multicanal;
- BUG-006A/B/C/D — horário, Stop Win, Stop Loss, Stop Reds do Auto-Trader e Trailing Stop;
- BUG-007A/B/C/D/E — CRUD/filtros Web/Telegram, Drawdown Control e Stop Reds independente dos Robôs/Canais;
- BUG-008A/B — leitura de saldo real, heartbeat/freshness e baseline financeiro;
- BUG-009 — bootstrap de schema;
- BUG-010 — coerência `ativo=false` + `status_operacao=DESLIGADO`.

## Riscos residuais não bloqueadores

### SEC-001

Credenciais antigas que tenham sido compartilhadas fora do repositório devem ser rotacionadas operacionalmente. O repositório atual mantém `.env`, sessão, cookies e chaves fora do versionamento.

### SEC-003B

O painel deve continuar em loopback/rede confiável enquanto não existir autenticação/autorização administrativa própria. Não considerar a interface adequada para exposição direta à Internet.

### BUG-001B — durabilidade de idempotência

A memória de `order_id` do executor não sobrevive a restart do processo. Garantia exatamente-uma-vez através de restart exigiria estado/fila durável e é mudança arquitetural separada.

### OBS-001

Ainda não existem logging estruturado, arquivo rotativo e métricas centralizadas. Os erros críticos atualmente tratados já são visíveis e o backend usa comportamento fail-closed nos pontos definidos.

### OBS-003

Existem suítes de regressão Node/Python e GitHub Actions. Ainda faltam testes de integração reais de MySQL/rotas e Playwright/DOM, que devem ser adicionados somente quando houver benefício claro para uma mudança futura.

## Política para próximos patches

Esta baseline não deve receber novas alterações funcionais sem uma necessidade concreta, reprodução de bug ou requisito explícito. Novas mudanças devem continuar usando branch isolada, um objetivo lógico por commit, PR revisado, CI verde e validação operacional proporcional ao risco.
