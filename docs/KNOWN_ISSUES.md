# Problemas e Riscos Conhecidos

Atualizado em 2026-08-17. Este arquivo descreve o estado atual do `main` e separa riscos ainda abertos de itens já mitigados.

## Pendências reais

### SEC-001 — Rotação operacional de credenciais antigas

Status: **mitigado no versionamento; ação operacional ainda pendente**.

Credenciais SQL, login e segredos foram externalizados para `.env`, arquivos de sessão ficaram fora do Git e o `.gitignore` cobre os artefatos sensíveis conhecidos.

Risco residual: qualquer credencial que tenha sido compartilhada antes dessa externalização deve ser rotacionada no serviço correspondente. Isso depende do ambiente/contas reais e não deve ser automatizado pelo repositório.

### BUG-014 — Lifecycle da ordem entre intenção, aceite e execução

Status: **mitigado pelos patches BUG-014A/014B/014C, sujeito à ambiguidade externa residual descrita abaixo**.

O BUG-014A passou a persistir `PREPARANDO` antes de qualquer POST externo. O BUG-014B acrescenta um lifecycle explícito entre Node e executor: ordem nova só é aceita quando o Playwright está pronto; cada aceite recebe timestamp e TTL; e o Python devolve o resultado da tentativa por callback autenticado em `/executor-status`.

O Node cria o waiter do `order_id` antes do POST, portanto um callback antecipado não se perde. `enviarOrdemAoExecutor()` só resolve com `EXECUTADA`. Uma tentativa sem clique de alvo retorna `FALHOU` e vira `FALHA_EXECUCAO`; ordem que vence na fila retorna `EXPIRADA` e vira `ORDEM_EXPIRADA`; falha após algum clique de alvo retorna `AMBIGUA`; ausência de callback continua `ENVIO_AMBIGUO`. Recusa `503` com `aceita=false` significa que o executor não persistiu/enfileirou um ID novo e é tratada como `FALHA_ENVIO` definitiva.

`EXECUTADA` não é uma garantia de exactly-once ou de aceite financeiro pela plataforma: significa somente que a automação local conseguiu completar todos os cliques planejados sem erro observável. Se o processo morrer exatamente durante a interação, a ambiguidade externa continua possível sem uma API transacional/idempotente do destino.

O BUG-014C mantém o ACK rápido de `/receber-sinal`, mas separa admissão de sequência e processamento: `coletor_sessao/coletor_seq` são reservados sincronamente antes do primeiro `await`, e toda mutação pós-ACK entra em uma fila FIFO. Assim uma rodada recebida durante MySQL/callback da anterior aguarda sua vez e não pode fechar/criar sinais sobre estado intermediário.

### BUG-015 — Frames `Resolved` repetidos podiam virar rodadas distintas

Status: **mitigado**.

O callback WebSocket chamava `processar_resultado()` para todo `bacbo.playerState` em estágio `Resolved`; não havia identidade/fingerprint local antes de incrementar `coletor_seq`. Uma repetição imediata do mesmo estado poderia, portanto, ser enviada ao Node como se fosse outra rodada válida.

O coletor agora deduplica antes de consumir sequência. Quando o payload traz `roundId`, `round_id`, `roundID`, `roundUid` ou `round_uid`, a identidade explícita prevalece. Sem identificador, usa resultado + dados normalizados apenas dentro de `RESULT_DEDUP_WINDOW_SECONDS` (3 s por padrão), permitindo que uma rodada futura legitimamente igual seja processada após a janela. Falha de POST continua consumindo a sequência da primeira observação, preservando a detecção de buraco do BUG-011.

### BUG-001R — Restart do executor e exactly-once do efeito externo

Status: **deduplicação entre restarts mitigada; ambiguidade do efeito externo ainda residual**.

O fluxo Node → Python usa `order_id` UUID. O executor agora mantém um journal JSON local dos últimos IDs aceitos, grava o estado de forma atômica antes de enfileirar uma nova ordem e restaura esse registro no startup. Reenvio do mesmo `order_id` após restart continua sendo tratado como duplicata; reutilização com payload diferente continua retornando conflito.

Journal ilegível/corrompido faz o executor falhar fechado no startup. Falha ao persistir uma nova ordem faz `/apostar` retornar 503 sem colocá-la na fila. O CI possui um gate específico que recria o runtime Flask com o mesmo journal e comprova que a ordem persistida não é reenfileirada.

Risco residual: o journal protege contra replay duplicado, mas não consegue provar o estado do efeito externo se o processo morrer exatamente durante a interação Playwright com a mesa. Um restart após o aceite não reenfileira automaticamente um ID já persistido, priorizando evitar aposta duplicada. Garantia de exactly-once absoluto do clique exigiria confirmação/idempotência transacional oferecida pela própria plataforma externa, que não está disponível ao executor.

### OBS-001 — Observabilidade

Status: **amplamente mitigado pelos patches OBS-001A…OBS-001H; agregação externa e alertas ainda pendentes**.

Já implementado:

- migrations e CRUDs críticos deixam erros inesperados visíveis;
- persistências críticas e rollbacks registram contexto;
- startup Node é fail-closed;
- `uncaughtException` e `unhandledRejection` encerram o processo após log;
- promises Telegram em background possuem `catch` contextual;
- executor Python registra falhas de HTTP, WebSocket, Auto-Login e Playwright;
- logging Node estruturado em JSONL com rotação por tamanho;
- redaction de chaves sensíveis e segredos conhecidos do `.env`;
- falha do sink de arquivo não derruba o backend e o console original é preservado;
- snapshot local `backend.metrics.json` com uptime, memória, event-loop delay p50/p95/p99/max/média, contagem de logs, último warn/error e falhas dos sinks;
- snapshot local `backend.operations.json` com contagem/status/latência HTTP inbound por rota normalizada, chamadas outbound agregadas por `executor`/`telegram`/`other` e freshness do último resultado/saldo aceitos;
- rotas retiram query strings e normalizam IDs; outbound não persiste URLs, tokens ou payloads;
- persistência das métricas é atômica, configurável e usa timers `unref()` para não manter o processo aberto;
- amostras e rotas operacionais são limitadas em memória para evitar cardinalidade/crescimento ilimitado.

Risco residual: as métricas ainda são locais ao processo/host. Não há agregador externo, retenção histórica central nem alertas automáticos. Latência de consultas MySQL e tempos internos de operações de negócio pós-ACK também não são medidos separadamente; instrumentar esses pontos deve ser uma decisão específica caso exista necessidade operacional real, evitando envolver o pool/banco apenas por conveniência.

### OBS-003 — Cobertura automatizada

Status: **amplamente mitigado pelos patches OBS-003A…OBS-003H; o site real permanece dependência externa não determinística**.

Já implementado:

- suíte Node `node:test` de lógica pura;
- suíte Python `unittest` sem iniciar Flask/Playwright;
- GitHub Actions em PR/push para `main`;
- testes de contrato HTTP usando handlers reais de login/logout/middleware com `req`/`res`/`app` simulados;
- testes do logger estruturado/rotativo, das métricas runtime e das métricas operacionais HTTP;
- teste real `http.createServer + fetch` comprova que os hooks de telemetria não alteram a resposta e não persistem query sensível;
- integração real do `bot2_coletor.js` com Express + MySQL 8.4 descartável no CI;
- smoke HTTP real cobrindo bootstrap de banco/schema/memória, login/logout, sessão administrativa, validação de Origin, APIs e `/receber-sinal` com `INTERNAL_API_TOKEN`;
- handshake Socket.IO real cobrindo rejeição sem sessão, aceitação com cookie administrativo válido e nova rejeição do cookie invalidado após logout;
- verificação no MySQL de que as nove tabelas esperadas são criadas a partir de banco vazio e de que o smoke de infraestrutura não grava giro nem ordem financeira;
- Chromium real em DOM controlado local validando parsing/leitura de saldo no DOM principal e em iframe, além dos seletores de ficha/alvo usados por `executar_aposta_na_tela`;
- E2E controlado do ciclo coletor Python → Node → executor fake autenticado → MySQL: o executor comprova `PREPARANDO`, atrasa o callback enquanto a rodada seguinte já chega ao Node e valida que a fila FIFO impede ultrapassagem; depois a mesma auditoria fecha em `WIN` e `historico_resultados` registra `GREEN/DIRETO`;
- integração específica do executor recria o runtime Flask com o mesmo journal e valida deduplicação de `order_id` através de restart, conflito de payload e falha fechada com journal corrompido.

Risco residual externo:

- o DOM/WebSocket do site real, sessão autenticada, disponibilidade e regras da plataforma podem divergir do ambiente controlado do CI; esses fatores devem ser tratados como validação operacional, não como gate determinístico do repositório.

## Itens mitigados

### SEC-002 — Comunicação interna Node ↔ Python sem autenticação

Status: **mitigado**.

`/apostar` e `/receber-sinal` exigem `INTERNAL_API_TOKEN`; o executor Flask usa loopback por padrão e valida payload mínimo antes de enfileirar ordem.

### SEC-003 — APIs Node sem autenticação e CORS amplo

Status: **mitigado pelos patches SEC-003A e SEC-003B**.

O Node usa `127.0.0.1` por padrão, valida `Host`/`Origin`, protege Socket.IO e suporta autenticação administrativa por sessão opaca em memória com cookie `HttpOnly` + `SameSite=Strict`. Fora do loopback, credenciais administrativas são obrigatórias e o backend falha fechado se estiverem incompletas.

`/receber-sinal` permanece separado da sessão administrativa e continua protegido pelo token interno.

### SEC-004 — Token Telegram exposto pelo backend

Status: **mitigado**.

`GET /api/robos` não devolve `telegram_token`; edição/toggle preserva o segredo quando o campo chega vazio/ausente.

### BUG-001 — Ordem contabilizada sem confirmação do executor

Status: **mitigado pelos patches BUG-001 e BUG-001B**, sujeito ao risco residual BUG-001R acima.

Node aguarda confirmação do executor antes de contabilizar entrada/criar Gale e usa `order_id` idempotente para retry ambíguo.

### BUG-002 — `STANDBY` indefinido

Status: **mitigado**.

Auto-Trader ativo passa de `STANDBY` para `OPERANDO` ao primeiro resultado válido/autenticado da mesa.

### BUG-003 — Edição/toggle resetava saldo do Auto-Trader

Status: **mitigado**.

Edição e toggle preservam `saldo_inicial`, `saldo_atual` e contadores operacionais; reativação usa novo baseline fresco quando apropriado.

### BUG-004 — `interrupcao_fluxo` não separava sessões

Status: **mitigado**.

Interrupção aceita rotaciona `id_sessao` antes de persistir o próximo giro, impedindo padrões atravessarem a fronteira lógica.

### BUG-005 — Persistência de históricos incompleta

Status: **mitigado em conjunto por BUG-005A + BUG-007B/007C**.

Resultados finalizados alimentam `historico_resultados`. Participação efetiva de Robôs/Canais alimenta `historico_disparos_robos`, incluindo canal Web e Telegram confirmado sem duplicação multicanal.

### BUG-006 — Regras financeiras/configuráveis sem enforcement

Status: **mitigado pelos patches BUG-006A…BUG-006D**.

Implementados: janela de horário, Stop Win, Stop Loss, Stop Reds do Auto-Trader e Trailing Stop. Gales já iniciados continuam até o desfecho para manter auditoria coerente.

### BUG-007 — Telegram, filtros e proteção de Robôs/Canais incompletos

Status: **mitigado pelos patches BUG-007A…BUG-007E**.

Implementados: CRUD visual, Web, Telegram confirmado, filtros, propriedade de padrão dinâmico, assertividade mínima, Drawdown Control e Stop Reds definitivo do Robô/Canal.

### BUG-008 — Sincronização de saldo incompleta

Status: **mitigado pelos patches BUG-008A/008B e validação operacional de 2026-08-17**.

Executor lê saldo por seletor CSS explícito, envia mudança/heartbeat ao Node e o backend usa freshness antes de permitir novo baseline/exposição.

### BUG-009 / OBS-002 — Schema inicial incompleto

Status: **mitigado**.

O backend cria as tabelas necessárias antes das migrations incrementais, permitindo inicialização de banco vazio sem depender de dump legado para as estruturas conhecidas. O OBS-003E passa a validar esse bootstrap automaticamente contra MySQL 8.4 vazio no CI.

### BUG-010 — Auto-Trader desligado permanecia `OPERANDO`

Status: **mitigado**.

Transição manual ON→OFF grava `DESLIGADO`; estados explícitos de hard stop são preservados.

### BUG-011 — Buraco Python→Node podia concatenar sequência inexistente

Status: **mitigado**.

Cada processo coletor usa `coletor_sessao` e `coletor_seq`. O Node detecta salto, restart, duplicata/atraso e desaparecimento de metadados; buraco confirmado rotaciona sessão e invalida pendências sem inferir WIN/LOSS.

### BUG-012 — Padrões IA órfãos após excluir Robô/Canal

Status: **mitigado**.

Exclusão é transacional e remove padrões IA filhos/históricos relacionados; startup também limpa órfãos legados de forma idempotente.

### BUG-013 — Cards usavam estatística operacional em vez de matching histórico

Status: **mitigado**.

Cards usam `giros_recentes` como fonte analítica, respeitam `id_sessao` e calculam DIRETO/G1/G2/TIE/RED nas janelas 24H, Hoje, Semana, Mês e Geral.

## Dependências externas que continuam fora do controle do código

- disponibilidade do MySQL e do site de destino;
- validade das credenciais reais;
- mudanças no DOM/WebSocket da plataforma;
- Chromium/Playwright instalado e compatível;
- seletor de saldo correto;
- estabilidade de rede entre processos/serviços locais.

## Política para novos problemas

Antes de criar um novo BUG/SEC/OBS, confirmar que o comportamento ainda existe no `main` atual e não está apenas descrito em documentação antiga. Novos patches devem ser pequenos, isolados, validados por testes e GitHub Actions, sem misturar correções independentes.
