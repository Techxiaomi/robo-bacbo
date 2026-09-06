# Contexto Técnico para Continuidade com Outra IA

Atualizado em 2026-08-17. Use este arquivo como contexto inicial para ChatGPT, Gemini, Copilot ou outro agente.

## Sistema

O projeto é composto por:

- Node.js / Express / MySQL / Socket.IO em `robo-bacbo`: painel, estratégias, Robôs/Canais, histórico, segurança administrativa e motor de decisão;
- Python / Flask / Playwright em `robo-sync-pilot`: sessão, captura das rodadas, leitura de saldo e execução de ordens na interface da mesa.

Fluxo interno:

- Python → Node: `POST /receber-sinal` com `INTERNAL_API_TOKEN`;
- Node → Python: `POST /apostar` com `INTERNAL_API_TOKEN` e `order_id` UUID.

## Regra principal

**Não reescreva o projeto nem altere arquitetura por conveniência.**

Leia antes de qualquer mudança:

1. `PROJECT_RULES.md`;
2. `docs/ARCHITECTURE.md`;
3. `docs/CURRENT_STATE.md`;
4. `docs/KNOWN_ISSUES.md`.

## Estado atual

Os bugs funcionais catalogados BUG-001…BUG-013 foram tratados pelos patches já mergeados. Não presuma que as descrições do snapshot inicial ainda representam o `main` atual.

Também estão implementados:

- autenticação interna Node ↔ Python;
- hardening de Host/Origin e bind em loopback;
- autenticação administrativa por sessão;
- proteção do token Telegram;
- inicialização fail-closed;
- schema inicial criado pelo backend;
- enforcement de horário, Stop Win, Stop Loss, Stop Reds e Trailing Stop;
- sincronização de saldo real/fresco;
- continuidade do coletor com detecção de buraco Python→Node;
- persistência de históricos e estatística dos cards pelo histórico bruto;
- Robôs/Canais Web + Telegram, filtros, Drawdown Control e Stop Reds;
- logging estruturado JSONL rotativo com redaction de segredos;
- métricas runtime locais em snapshot JSON atômico, incluindo uptime, memória, event-loop delay, níveis de log e falhas dos sinks;
- métricas operacionais locais em `backend.operations.json`: HTTP inbound por rota normalizada, outbound agregado por executor/Telegram/outros e freshness do último resultado/saldo aceitos, sem payloads ou URLs sensíveis;
- testes Node, Python, contratos HTTP, logger, métricas runtime e métricas operacionais;
- integração real do backend com Express + Socket.IO + MySQL 8.4 descartável;
- handshake Socket.IO real validado com sessão administrativa antes e depois do logout;
- Playwright/Chromium real em DOM controlado local para leitura de saldo e seletores de execução;
- E2E controlado coletor Python → Node → executor fake autenticado → auditoria MySQL, incluindo ordem DIRETO e fechamento `WIN`;
- deduplicação de `order_id` persistida em journal local atômico, sobrevivendo a restart do executor e falhando fechado com journal inválido/indisponível;
- BUG-014A: toda ordem DIRETO/GALE recebe intenção durável `PREPARANDO` no MySQL antes do POST ao executor;
- BUG-014B: novas ordens só são aceitas com Playwright pronto, possuem TTL de fila e exigem callback autenticado `EXECUTADA/FALHOU/EXPIRADA/AMBIGUA`; Node só promove `PREPARANDO` após `EXECUTADA`, e callback antecipado é suportado;
- BUG-014C: `/receber-sinal` reserva continuidade antes de I/O e serializa todo o processamento pós-ACK em FIFO, impedindo que uma rodada ultrapasse outra durante MySQL/callback do executor;
- BUG-015: o coletor deduplica frames `Resolved` repetidos antes de incrementar `coletor_seq`, preferindo identidade de rodada e usando fingerprint temporal curto como fallback;
- GitHub Actions em PR/push para `main`.

Consulte `CURRENT_STATE.md` para detalhes e riscos residuais.

## Fluxo de trabalho preferido

Para alterações versionáveis, prefira trabalhar diretamente em branch privada no GitHub:

1. confirmar o SHA atual de `main`;
2. criar uma branch isolada;
3. fazer somente a alteração necessária;
4. revisar o diff remoto;
5. abrir PR;
6. usar GitHub Actions como gate;
7. corrigir falhas na própria branch;
8. mergear somente com CI verde;
9. no ambiente local, apenas sincronizar com `git pull --ff-only origin main`.

Evite gerar patchers PowerShell locais quando a alteração puder ser feita com segurança diretamente no repositório. Patchers locais ficam reservados para mudanças que dependam do ambiente, banco, `.env`, arquivos ignorados pelo Git ou validação operacional da máquina.

## Antes de qualquer patch de produção

Informar de forma objetiva:

1. causa provável;
2. arquivos/funções afetados;
3. alteração mínima proposta;
4. risco de regressão;
5. como testar.

Não misture correções independentes no mesmo patch.

## Restrições de segurança

- repositório é privado;
- nunca versionar `.env`, sessão autenticada, cookies, tokens, senhas ou credenciais reais;
- não pedir ao usuário que cole segredos no chat;
- preservar `INTERNAL_API_TOKEN` como canal separado da autenticação administrativa;
- não enfraquecer fail-closed, validação de Host/Origin, freshness do saldo ou continuidade do coletor por conveniência.

## Riscos residuais prioritários

- rotação operacional de credenciais antigas compartilhadas;
- BUG-014B confirma conclusão local da tentativa DOM antes de `PENDENTE`, mas não confundir `EXECUTADA` com confirmação financeira transacional da plataforma; crash durante o clique ainda pode ser externamente ambíguo;
- deduplicação do `order_id` sobrevive a restart e IDs já persistidos não são reenfileirados automaticamente para priorizar prevenção de duplicidade;
- métricas runtime e HTTP operacionais locais existem, porém agregação externa, retenção histórica central e alertas automáticos ainda não existem;
- latência MySQL e tempos internos de operações de negócio pós-ACK ainda não são instrumentados separadamente; só envolver o pool/banco se houver necessidade operacional real;
- dependência operacional da estrutura DOM/WebSocket, sessão e comportamento do site de destino, que pode divergir dos ambientes controlados do CI;
- modularização futura deve ser gradual e coberta por testes.

## Validação mínima esperada

Quando a alteração tocar Node:

- `node --check` nos arquivos alterados;
- `npm test` em `robo-bacbo`;
- `git diff --check` ou equivalente remoto;
- GitHub Actions Node verde.

Quando tocar `logger.js`, `metrics.js`, `operations_metrics.js`, `env_loader.js` ou configuração de observabilidade:

- manter verdes os testes de logger, métricas runtime e métricas operacionais;
- preservar o console original e o fail-safe dos sinks;
- não introduzir dependência externa apenas para coletar métricas locais;
- timers de telemetria local não devem impedir encerramento normal do processo;
- métricas/snapshots não podem incluir segredos do `.env`, payloads, query strings sensíveis nem URLs com credenciais/tokens;
- manter cardinalidade e memória limitadas; IDs variáveis devem ser normalizados nas rotas.

Quando a alteração tocar hook HTTP/fetch ou classificação outbound:

- manter verde o teste real `http.createServer + fetch` em `operations_metrics.test.js`;
- manter verde o job `Backend HTTP + Socket.IO + MySQL integration` para provar transparência em login, APIs, webhook e Socket.IO;
- manter verde o `Controlled collector + Node + executor + MySQL E2E` quando a instrumentação puder observar chamadas ao executor;
- nunca registrar corpo de requisição/resposta, `INTERNAL_API_TOKEN`, token Telegram, `order_id`, valores financeiros ou URL completa do Telegram.

Quando a alteração puder afetar bootstrap, rotas HTTP, autenticação, Socket.IO ou schema MySQL:

- manter verde o job `Backend HTTP + Socket.IO + MySQL integration`;
- o job deve usar banco descartável e credenciais fictícias, nunca `.env` real ou secrets do projeto;
- preservar testes de sessão administrativa no HTTP e no handshake Socket.IO;
- não transformar o smoke de infraestrutura em execução financeira.

Quando a alteração tocar matching de padrão, transição do Auto-Trader, envio de ordem, `order_id`, auditoria financeira ou processamento de resultado Python→Node:

- manter verde o job `Controlled collector + Node + executor + MySQL E2E`;
- o E2E deve permanecer totalmente controlado, usando executor fake autenticado e MySQL descartável;
- quando tocar criação/envio de ordens, o executor fake deve comprovar `PREPARANDO`, enviar callback autenticado `EXECUTADA` e validar que o Node só então promove a auditoria; o E2E também deve manter o cenário em que a rodada 2 chega enquanto a rodada 1 ainda espera o executor, comprovando o FIFO pós-ACK;
- nunca apontar esse job para site, executor ou conta real;
- ao tocar `processar_resultado`, preservar testes de frame `Resolved` duplicado, nova rodada após a janela e `roundId` distinto.

Quando a alteração tocar recepção `/apostar`, `order_id`, journal ou idempotência do executor:

- manter verde o job `Executor restart idempotency integration`;
- validar pelo menos nova ordem, duplicata após recriação do runtime, conflito de payload e journal corrompido fail-closed;
- não afirmar exactly-once absoluto do clique externo: a garantia local é deduplicação durável do ID aceito.

Quando tocar Python:

- sintaxe Python;
- `robo-sync-pilot/tests/test_pure_logic.py`;
- GitHub Actions Python verde.

Quando tocar parsing monetário, `CASINO_BALANCE_SELECTOR`, seleção de frame, fichas ou alvos Playwright:

- manter verde o job `Playwright controlled DOM integration`;
- testar primeiro contra DOM local controlado com Chromium real e sem credenciais;
- não usar o site real como gate de CI.

Quando tocar integração operacional do site real (login, sessão, saldo, DOM/WebSocket ou `.env`), complementar o CI com teste controlado no ambiente local sem publicar segredos.
