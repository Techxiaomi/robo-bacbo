# Estado Atual do Projeto

Atualizado em 2026-08-17 após os patches BUG-001…BUG-014C, BUG-001R, SEC-002/003A/003B/004, OBS-001A…H e OBS-003A…H.

Este arquivo descreve o estado atual do `main`, não o snapshot inicial.

## Arquitetura em operação

O projeto continua dividido em dois processos principais:

- `robo-bacbo`: Node.js / Express / MySQL / Socket.IO, responsável pelo painel, estratégias, robôs/canais, estado, histórico e motor do Auto-Trader;
- `robo-sync-pilot`: Python / Flask / Playwright, responsável pela sessão do site, captura das rodadas, leitura de saldo e execução das ordens na interface da mesa.

O Python envia resultados autenticados para `POST /receber-sinal`. O Node envia ordens autenticadas para `POST /apostar`.

## Implementado e conectado

### Segurança e transporte

- credenciais e segredos reais ficam em `.env`, fora do Git;
- `INTERNAL_API_TOKEN` autentica os dois canais internos Node ↔ Python;
- executor Flask usa loopback por padrão;
- Node usa `NODE_HOST=127.0.0.1` por padrão e valida `Host`/`Origin` no HTTP e Socket.IO;
- painel e APIs administrativas suportam login por sessão opaca em memória, cookie `HttpOnly` + `SameSite=Strict` e TTL;
- fora do loopback, credenciais administrativas são obrigatórias e o backend falha fechado se estiverem incompletas;
- `/receber-sinal` permanece separado da sessão administrativa e continua protegido pelo token interno;
- token Telegram não é devolvido pelo `GET /api/robos`.

### Banco e inicialização

- criação inicial das tabelas necessárias ocorre pelo próprio backend;
- migrations incrementais tratam somente coluna já existente como condição idempotente esperada;
- limpeza de padrões IA órfãos ocorre no startup;
- inicialização é fail-closed: APIs e Socket.IO não são liberados até banco/schema/memória estarem prontos;
- falha crítica de preparação encerra o processo em vez de manter backend parcialmente inicializado;
- o bootstrap a partir de MySQL vazio é validado automaticamente no CI contra MySQL 8.4.

### Estratégias, padrões e histórico

- CRUD de estratégias e origens;
- detecção sequencial de padrões;
- entrada DIRETO e Gales;
- separação lógica de sessões após pausa, restart do coletor, salto de sequência ou buraco confirmado Python→Node;
- resultados finalizados persistidos em `historico_resultados`;
- histórico de distribuição de Robôs/Canais persistido quando houve participação efetiva;
- cards de padrões recalculam estatísticas pelo histórico bruto de `giros_recentes`, respeitando `id_sessao`;
- períodos 24H, Hoje, Semana, Mês e Geral disponíveis nos cards;
- exclusão de Robô/Canal remove de forma transacional os padrões IA filhos e históricos relacionados.

### Robôs / canais

- CRUD visual de Robôs/Canais e destinatários;
- canal Web integrado ao ciclo real do sinal;
- Telegram com confirmação de entrega e união multicanal sem duplicar histórico;
- filtros por origem, avulsos, exceções, proprietário de padrão dinâmico e assertividade mínima;
- Drawdown Control conservador/dinâmico com `standby_ate` persistido;
- Stop Reds consecutivos como hard stop independente do Auto-Trader.

### Auto-Trader

- `STANDBY` → `OPERANDO` ao primeiro resultado válido da mesa;
- desligamento manual persiste `DESLIGADO` sem apagar status explícitos de stop;
- baseline financeiro capturado pelo backend a partir de saldo global fresco;
- edição/toggle não reseta `saldo_inicial`/`saldo_atual`;
- janela de horário normal, full-day e overnight;
- Stop Win e Stop Loss usando saldo real/fresco;
- Stop Reds com pausa automática ou desligamento manualmente reversível;
- Trailing Stop por recuo explícito a partir do pico de lucro persistido;
- sequências já iniciadas, inclusive Gales, seguem até o desfecho para preservar auditoria;
- ordens Node→Python usam `order_id` UUID; o executor persiste os últimos IDs aceitos em journal atômico e mantém a deduplicação através de restart;
- antes de qualquer POST financeiro ao executor, o Node persiste uma intenção `PREPARANDO` em `auditoria_ordens` com o mesmo `order_id`; DIRETO só incrementa `entradas_feitas` quando o ACK transforma essa intenção em `PENDENTE`;
- no GALE, o `LOSS` da ordem anterior e a intenção `PREPARANDO` da próxima exposição são gravados na mesma transação antes do POST externo;
- o Flask só aceita um `order_id` novo quando o Playwright está efetivamente conectado/pronto; duplicatas já persistidas continuam idempotentes mesmo durante indisponibilidade;
- cada nova ordem aceita recebe timestamp local e TTL (`EXECUTOR_ORDER_TTL_SECONDS`, padrão 8 s); se envelhecer antes da interação DOM, não é clicada e o executor reporta `EXPIRADA`;
- `/apostar` continua sendo o ACK de fila, mas o Node agora mantém um waiter por `order_id` e só considera `enviarOrdemAoExecutor()` concluído após callback autenticado em `/executor-status`; o callback pode chegar antes do ACK HTTP sem se perder;
- `executar_aposta_na_tela()` retorna `EXECUTADA` somente quando todos os cliques DOM planejados terminam sem erro local, `FALHOU` quando nenhum clique de alvo ocorreu e `AMBIGUA` quando houve clique(s) de alvo antes de uma falha; isso confirma a tentativa local no DOM, não aceite transacional pela plataforma externa;
- `FALHOU` marca `FALHA_EXECUCAO`, `EXPIRADA` marca `ORDEM_EXPIRADA`, callback `AMBIGUA`/timeout permanece `ENVIO_AMBIGUO`, e recusa explícita sem aceite permanece `FALHA_ENVIO`;
- journal ilegível/corrompido bloqueia o startup do executor e falha de persistência impede a ordem de entrar na fila;
- auditoria financeira usa estados explícitos, inclusive `DADOS_INCOMPLETOS` quando há buraco confirmado de coleta;
- resultados autenticados mantêm ACK HTTP rápido, mas reservam `coletor_sessao/coletor_seq` sincronamente antes de qualquer I/O e executam todo o trabalho pós-ACK em uma fila FIFO única; uma rodada não pode ultrapassar outra enquanto a anterior aguarda MySQL ou callback do executor.

### Saldo da corretora

- leitura do saldo real por seletor CSS explícito no Playwright;
- sincronização autenticada Python→Node por mudança e heartbeat;
- snapshot de saldo possui freshness configurável;
- após restart do Node o saldo volta a desconhecido até nova sincronização.

### Observabilidade

- falhas críticas de migration, CRUD, persistência, rollback e processamento pós-ACK são registradas;
- `uncaughtException` e `unhandledRejection` encerram o Node após log;
- promises Telegram em background possuem `catch` contextual;
- executor Python registra falhas HTTP, WebSocket, Auto-Login, Playwright e restart externo;
- logging estruturado JSONL no Node com rotação por tamanho e retenção configurável;
- redaction de chaves sensíveis e segredos conhecidos do `.env`;
- falha do sink de arquivo não derruba o backend e o console original continua disponível;
- snapshot runtime local em `logs/backend.metrics.json` por padrão, gravado de forma atômica e configurável por ambiente;
- métricas runtime incluem uptime, RSS/heap/external/array buffers, event-loop delay p50/p95/p99/max/média, contagem de logs por nível, último warn/error e falhas dos sinks;
- snapshot operacional separado em `logs/backend.operations.json` por padrão, também atômico, configurável e com timer `unref()`;
- métricas HTTP inbound agregam contagem, classes 2xx/3xx/4xx/5xx, requisições em andamento e latência média/p50/p95/p99/max por rota normalizada, sem query string ou IDs variáveis;
- chamadas HTTP outbound são agregadas apenas por categoria `executor`, `telegram` e `other`, com sucesso/falha, classes de status e latência, sem persistir URL, token ou payload;
- freshness operacional registra apenas instante/idade do último resultado e do último saldo aceitos por `/receber-sinal`, sem persistir valores financeiros ou conteúdo do sinal;
- amostras e quantidade de rotas são limitadas em memória para evitar cardinalidade/crescimento ilimitado;
- timers de métricas usam `unref()`, portanto não mantêm o processo Node aberto; falha dos sinks de métricas não derruba o backend.

### Testes e CI

- suíte Node com `node:test` para lógica pura;
- testes de contrato HTTP para login/logout e middleware administrativo;
- testes do logger estruturado/rotativo, métricas runtime e métricas operacionais/persistência atômica;
- métricas operacionais possuem teste real com `http.createServer + fetch`, cobrindo transparência da resposta, hook HTTP/fetch, normalização de rota, freshness e ausência de query sensível no snapshot;
- suíte Python `unittest` sobre parsing, payloads, transporte interno e persistência de `order_id`;
- GitHub Actions executa sintaxe + Node + Python em PRs e pushes para `main`;
- job separado sobe MySQL 8.4 descartável e inicia o `bot2_coletor.js` real com Express/MySQL2/Socket.IO;
- smoke HTTP real valida Origin, login/logout, sessão administrativa, painel/API e autenticação de `/receber-sinal`;
- o mesmo smoke valida o handshake Socket.IO real: sem sessão é rejeitado, com cookie administrativo válido conecta e o cookie invalidado no logout deixa de conectar;
- integração confirma as nove tabelas esperadas em banco vazio e garante que o próprio smoke de infraestrutura não cria giro nem ordem financeira;
- job Playwright separado instala Chromium e executa DOM controlado local, validando parsing/saldo, `EXECUTADA` no fluxo completo, `FALHOU` sem clique e `AMBIGUA` quando a falha ocorre após o primeiro clique de alvo;
- job E2E controlado usa a função real `processar_resultado` do Python, o backend Node real, MySQL 8.4 e executor HTTP fake autenticado; além de comprovar `PREPARANDO`/callback antecipado, o fake atrasa deliberadamente a execução enquanto a rodada seguinte já é enviada, validando que o FIFO pós-ACK preserva a ordem causal e ainda fecha a auditoria em `WIN`;
- job `Executor restart idempotency integration` recria o runtime Flask com o mesmo journal e valida duplicata após restart, conflito de payload, nova ordem e falha fechada com journal corrompido.

## Riscos e trabalhos ainda pendentes

- rotacionar operacionalmente credenciais que tenham sido compartilhadas antes da externalização para `.env`;
- readiness, TTL e callback de resultado DOM já fecham a janela de ordem velha/não pronta e impedem promoção para `PENDENTE` sem `EXECUTADA`; ainda assim, `EXECUTADA` significa apenas que os cliques locais terminaram sem erro observável, não que a plataforma externa confirmou atomicamente a aposta;
- deduplicação do `order_id` já sobrevive a restart, mas um crash exatamente durante o clique Playwright pode continuar deixando o efeito externo ambíguo; IDs persistidos não são reenfileirados automaticamente, priorizando evitar aposta duplicada;
- métricas runtime e HTTP operacionais locais já existem, porém ainda não há agregador externo, histórico central de longo prazo nem alertas automáticos;
- latência de consultas MySQL e tempos internos de operações de negócio pós-ACK ainda não são instrumentados separadamente; isso deve ser adicionado somente se houver necessidade operacional clara, para não envolver o pool/banco de forma invasiva;
- mudanças no DOM/WebSocket, sessão e comportamento da plataforma de destino continuam sendo dependência externa operacional e podem divergir dos ambientes controlados validados no CI;
- arquivos grandes e multifuncionais ainda merecem modularização gradual, porém somente com cobertura suficiente e patches pequenos.

## Dependências externas

- MySQL configurado e acessível;
- credenciais válidas do site de destino;
- Chromium/Playwright disponível no ambiente do executor;
- estrutura DOM/WebSocket compatível com os seletores e eventos esperados;
- `CASINO_BALANCE_SELECTOR` correto para sincronização de saldo;
- `.env` local com tokens, credenciais e URLs necessários.

## Regra de manutenção

Não reescrever o projeto por conveniência. Manter patches pequenos, isolados e testáveis. Antes de alterar código de produção, registrar causa, arquivos/funções afetados, mudança mínima, risco de regressão e forma de validação.
