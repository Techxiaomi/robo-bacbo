# Problemas e Riscos Conhecidos

Prioridades iniciais sugeridas. Nenhum desses itens foi corrigido nesta baseline, salvo a retirada de credenciais do código versionável.

## Críticos / altos

### SEC-001 — Credenciais hardcoded no snapshot original

Status nesta baseline: **mitigado para versionamento**.

As credenciais SQL e de login foram substituídas por variáveis de ambiente. O arquivo real de sessão foi excluído da baseline e consta no `.gitignore`.

Ação operacional ainda necessária: após validar a migração, rotacionar credenciais que já tenham sido compartilhadas em outros serviços/conversas.

### SEC-002 — Comunicação interna Node ↔ Python sem autenticação

Status proposto: **mitigado no patch SEC-002**.

As duas rotas internas (`/apostar` e `/receber-sinal`) passam a exigir `INTERNAL_API_TOKEN`; o executor Flask usa `127.0.0.1` por padrão e valida minimamente o payload antes de enfileirar uma ordem. O segredo real permanece somente no `.env`.

### SEC-003 — APIs Node sem autenticação e CORS amplo

Status: **parcialmente mitigado no patch SEC-003A**.

O Node passa a escutar em `127.0.0.1` por padrão via `NODE_HOST`, em vez de depender do bind implícito de `app.listen()`. O CORS aberto é removido e requisições HTTP com header `Origin` diferente do `Host` são rejeitadas. O handshake Socket.IO usa a mesma regra de mesma origem. Clientes internos sem `Origin`, como o executor Python autenticado, continuam permitidos.

É possível optar deliberadamente por outro `NODE_HOST` para acesso em rede, mas o backend emite aviso porque as rotas administrativas ainda não possuem autenticação de usuário. Portanto, **não considerar o painel seguro para Internet ou rede não confiável** até uma etapa separada de autenticação/autorização administrativa (SEC-003B).

### SEC-004 — Token Telegram pode ser devolvido pelo `GET /api/robos`

Status: **mitigado no patch SEC-004**.

`GET /api/robos` deixa de devolver `telegram_token` e expõe apenas `telegram_configurado: true/false`. O formulário de edição mantém o campo de token vazio e informa que deixar em branco preserva a credencial já existente.

No `PUT /api/robo/:id`, token vazio ou ausente preserva o valor armazenado; um token novo só substitui o anterior quando é explicitamente informado. Isso também permite que o toggle rápido continue funcionando sem transportar o segredo pelo navegador.

### BUG-001 — Ordem pode ser registrada sem confirmação do executor

Status: **mitigado no patch BUG-001**.

O Node passa a aguardar a resposta do executor, rejeitar timeout/erro HTTP/confirmação divergente e só então contabilizar a entrada direta ou criar a nova ordem `PENDENTE` de Gale. A ordem anterior de um Gale continua sendo encerrada pelo resultado já observado da mesa.

Risco residual: uma falha de rede exatamente após o executor enfileirar a ordem e antes da resposta chegar ao Node ainda pode gerar uma confirmação ambígua. Eliminar completamente esse caso exige um identificador idempotente de ordem compartilhado entre Node e Python.

### BUG-002 — `STANDBY` pode impedir novas entradas indefinidamente

Status: **mitigado no patch BUG-002**.

Auto-Traders ativos permanecem em `STANDBY` enquanto aguardam evidência de conexão com a mesa. Ao receber o primeiro resultado de rodada válido e autenticado em `/receber-sinal`, o Node persiste `status_operacao = 'OPERANDO'` e atualiza o estado em memória. Traders desligados ou em estados como `META_ATINGIDA` não são promovidos.

### BUG-003 — Edição/toggle do auto-trader reseta `saldo_atual`

Status: **mitigado no patch BUG-003**.

O endpoint `PUT /api/auto-trader/:id` passa a atualizar somente nome, estado ativo e configuração. `saldo_inicial` e `saldo_atual` são preservados em edições e no toggle rápido. Uma futura recalibração de banca deve usar uma ação explícita e separada, em vez de ocorrer como efeito colateral de editar o motor.

## Médios

### BUG-004 — `interrupcao_fluxo` é enviado, mas não aplicado no Node

Status: **mitigado no patch BUG-004**.

Quando o Python sinaliza `interrupcao_fluxo = true`, o Node rotaciona `idSessaoContinua` antes de persistir o primeiro resultado após a pausa. O novo ID usa `timestamp_coleta` quando válido (com fallback para `Date.now()`), fazendo a checagem `mesmaSessao` já existente impedir padrões formados pela concatenação de giros antes e depois da interrupção. Ordens pendentes e estado de Gale não são alterados por este patch.

### BUG-005 — Tabelas de histórico são consultadas sem persistência correspondente visível

Status: **parcialmente mitigado no patch BUG-005A**.

`historico_resultados` passa a receber um registro quando cada sinal de estratégia é finalizado como `GREEN`, `TIE` ou `RED`, com nível `DIRETO`/`GALE1`/`GALE2`, multiplicador do empate quando aplicável e horário da rodada. Não são gravados registros intermediários a cada Gale, evitando duplicar um mesmo sinal.

`historico_disparos_robos` é preenchido para robôs que participaram do sinal por pelo menos um canal efetivamente implementado. O BUG-007B cobre o canal web; o BUG-007C inclui robôs Telegram-only somente quando ao menos um destino confirma a entrega da mensagem de ENTRADA. Robôs presentes nos dois canais continuam gerando um único registro por sinal.

### BUG-006 — Stop Win / Stop Loss / Trailing / horário estão configuráveis no painel sem enforcement localizado

Status: **parcialmente mitigado no patch BUG-006A**.

A janela `hora_inicio`/`hora_fim` passa a ser aplicada antes de abrir novas sequências do Auto-Trader. Janelas normais e janelas que atravessam a meia-noite são suportadas; horários ausentes usam `00:00`–`23:59`, e configuração de horário inválida bloqueia a nova entrada. Gales de uma sequência já iniciada continuam até o desfecho para não deixar ordens pendentes/auditoria em estado incoerente.

Stop Win, Stop Loss e trailing permanecem pendentes. O BUG-008A/008B fornece sincronização de saldo e baseline financeiro controlado pelo backend, mas a leitura real da página ainda precisa de validação operacional antes de liberar enforcement financeiro. Além disso, `trailing_stop` é apenas booleano no painel e não define distância/recuo de trailing.

### BUG-007 — Telegram e filtros de robôs parecem incompletos

Status: **parcialmente mitigado pelos patches BUG-007A, BUG-007B, BUG-007C e BUG-007D**.

O BUG-007A restaura o CRUD visual de Robôs. O BUG-007B conecta o canal web ao ciclo real do sinal, com precedência `exceção > avulso > origem`, propriedade por `robo_dono_id` em padrões dinâmicos e filtro de `min_assertividade`. O BUG-007C implementa entrega Telegram confirmada e união multicanal sem duplicar histórico.

O BUG-007D aplica o Drawdown Control conforme a semântica explícita do painel: `CONSERVADOR` pausa no primeiro RED; `DINAMICO` pausa após X REDs dentro de Y minutos; ambos usam `pausa_min`. Robôs em `standby_ate` ficam fora da seleção Web/Telegram até a expiração. O estado de proteção e a janela recente de REDs são persistidos para sobreviver a restart do Node. GREEN/TIE incrementa `greens_consecutivos`, RED zera o streak, e o aviso opcional de proteção no Telegram é enviado depois da mensagem de RED somente a destinos cuja ENTRADA foi confirmada.

O campo separado `stop_reds_seguidos` permanece sem enforcement porque o painel não define a ação de recuperação: não informa se deve desligar permanentemente, pausar por um período ou como rearmar o robô. Implementar esse campo exige uma regra explícita em vez de inferência.

### BUG-008 — Sincronização de saldo da corretora estava incompleta

Status: **parcialmente mitigado nos patches BUG-008A e BUG-008B**.

O executor pode ler o saldo real diretamente da página usando o seletor CSS explícito `CASINO_BALANCE_SELECTOR` e enviar mensagens autenticadas de saldo ao Node por mudança/heartbeat. Sem seletor configurado ou sem valor válido, nenhum saldo é inferido.

O BUG-008B torna o backend dono do baseline financeiro. O navegador deixa de fornecer `saldo_inicial`; criação ativa e transição inativo→ativo exigem um saldo global recente, capturam esse valor como `saldo_inicial`/`saldo_atual` e iniciam um novo ciclo em `STANDBY`, zerando `entradas_feitas` e `pulos_restantes`. Edições de um trader já ativo preservam baseline, saldo e contadores. Criação inativa continua permitida e será recalibrada na ativação.

O Node registra quando o último saldo foi aceito e considera o valor fresco por `BALANCE_SYNC_MAX_AGE_SECONDS` (90 s por padrão, acima do heartbeat padrão de 60 s). Após restart, o saldo volta a desconhecido até uma nova sincronização, evitando reutilizar snapshot antigo.

A validação operacional do seletor CSS real permanece pendente. Stop Win/Stop Loss continuam fora de enforcement até essa leitura ser confirmada em operação; a semântica de trailing também permanece separada.

### OBS-001 — Exceções críticas são frequentemente silenciadas

Status: **parcialmente mitigado nos patches OBS-001A e OBS-001B**.

No Node, migrations incrementais deixam de silenciar erros inesperados: somente `ER_DUP_FIELDNAME`/errno 1060 continua tratado como condição normal de idempotência. Rotas CRUD críticas registram contexto técnico; `apagarEstrategiaEDados()` deixa o erro subir; e falhas em fechamento `LOSS`, `pulos_restantes`, rollback e processamento pós-ACK ficam visíveis.

No executor Python, o envio de resultado resolvido ao Node passa a validar o status HTTP com `raise_for_status()` e registrar falhas sem alterar o ciclo da mesa. Exceções inesperadas em `processar_resultado`, frames WebSocket, Auto-Login, loop principal do Playwright e restart externo também passam a ser visíveis. Logs de alta frequência usam limitação temporal de 30 segundos.

Ruído esperado continua tolerado: frames WebSocket que não são JSON, falhas em pop-ups opcionais, fallback de stealth, varredura de frames para saldo e o botão opcional “Continuar” não viram erro fatal. O item permanece parcial porque ainda não existe logging estruturado/arquivo rotativo nem métricas centralizadas.

### OBS-002 — Schema inicial incompleto no código

Status: **mitigado no patch BUG-009**.

`prepararBancoDeDados()` passa a criar `origens` e `estrategias` com os campos efetivamente exigidos pelas rotas CRUD, contadores legados e campos dinâmicos já usados/migrados pelo backend. As criações usam `CREATE TABLE IF NOT EXISTS` e ocorrem antes das migrations `ALTER TABLE`, permitindo inicializar um banco vazio sem depender de um dump externo.

O patch não adiciona constraints, índices ou relacionamentos novos além das chaves primárias mínimas já implícitas no uso atual, preservando compatibilidade com bancos existentes.

### OBS-003 — Não há teste automatizado

Status: **parcialmente mitigado nos patches OBS-003A e OBS-003B**.

O OBS-003A substitui o placeholder de `npm test` por uma suíte `node:test` sobre lógica pura já existente em `bot2_coletor.js`, sem iniciar Express, Socket.IO, MySQL, Telegram ou executor de apostas. Ela cobre arredondamento de ficha, classificação DIRETO/GALE, TIEs legados, precedência `exceção > avulso > origem`, propriedade de estratégia dinâmica, formatação Telegram e janelas de horário normais/full-day/overnight.

O OBS-003B adiciona uma suíte Python com `unittest` que lê `robo.py` por AST e compila somente as funções sob teste, evitando executar o top-level que inicia Flask/Playwright. A cobertura inclui parsing monetário nos formatos brasileiro/internacional, rejeição de valores negativos, montagem do payload de rodada resolvida, normalização de TIE, fronteira de interrupção `> 60s`, autenticação interna no POST e tratamento de erro HTTP do resultado→Node com fakes locais.

Ainda faltam testes de integração de banco/rotas e testes reais de Playwright/DOM; por isso o item permanece parcialmente mitigado.
