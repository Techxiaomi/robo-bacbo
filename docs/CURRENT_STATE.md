# Estado Atual do Projeto

Atualizado em 2026-08-17 após os patches BUG-001…BUG-013, BUG-001R, SEC-002/003A/003B/004, OBS-001A…F e OBS-003A…H.

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
- journal ilegível/corrompido bloqueia o startup do executor e falha de persistência impede a ordem de entrar na fila;
- auditoria financeira usa estados explícitos, inclusive `DADOS_INCOMPLETOS` quando há buraco confirmado de coleta.

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
- falha do sink de arquivo não derruba o backend e o console original continua disponível.

### Testes e CI

- suíte Node com `node:test` para lógica pura;
- testes de contrato HTTP para login/logout e middleware administrativo;
- testes do logger estruturado/rotativo;
- suíte Python `unittest` sobre parsing, payloads, transporte interno e persistência de `order_id`;
- GitHub Actions executa sintaxe + Node + Python em PRs e pushes para `main`;
- job separado sobe MySQL 8.4 descartável e inicia o `bot2_coletor.js` real com Express/MySQL2/Socket.IO;
- smoke HTTP real valida Origin, login/logout, sessão administrativa, painel/API e autenticação de `/receber-sinal`;
- o mesmo smoke valida o handshake Socket.IO real: sem sessão é rejeitado, com cookie administrativo válido conecta e o cookie invalidado no logout deixa de conectar;
- integração confirma as nove tabelas esperadas em banco vazio e garante que o próprio smoke de infraestrutura não cria giro nem ordem financeira;
- job Playwright separado instala Chromium e executa DOM controlado local, validando `parsear_valor_monetario`, leitura de saldo no documento/iframe e os seletores de ficha/alvo da função `executar_aposta_na_tela` sem acessar o site real;
- job E2E controlado usa a função real `processar_resultado` do Python, o backend Node real, MySQL 8.4 e executor HTTP fake autenticado para validar captura/sequência → matching de padrão → `STANDBY`→`OPERANDO` → ordem DIRETO com UUID → auditoria `PENDENTE` → segunda rodada → `WIN` + `historico_resultados=GREEN/DIRETO`;
- job `Executor restart idempotency integration` recria o runtime Flask com o mesmo journal e valida duplicata após restart, conflito de payload, nova ordem e falha fechada com journal corrompido.

## Riscos e trabalhos ainda pendentes

- rotacionar operacionalmente credenciais que tenham sido compartilhadas antes da externalização para `.env`;
- deduplicação do `order_id` já sobrevive a restart, mas um crash exatamente durante o clique Playwright deixa o efeito externo ambíguo; IDs já persistidos não são reenfileirados automaticamente, priorizando evitar aposta duplicada;
- não existem métricas centralizadas/telemetria agregada; os logs estruturados já existem, mas métricas continuam pendentes;
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
