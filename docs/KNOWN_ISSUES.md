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

Status: **mitigado pelos patches BUG-001 e BUG-001B**.

O BUG-001 faz o Node aguardar a resposta do executor e só contabilizar a entrada direta ou criar a nova ordem `PENDENTE` de Gale depois do aceite HTTP.

O BUG-001B adiciona um UUID `order_id` compartilhado entre Node e Python. Em timeout, falha de transporte, resposta inválida ou HTTP 5xx, o Node pode repetir uma vez a mesma ordem com o mesmo ID. O executor registra o ID antes de enfileirar: repetição com o mesmo payload retorna sucesso idempotente sem nova entrada na fila; reutilização do mesmo ID com payload diferente retorna HTTP 409. O UUID confirmado também é gravado em `auditoria_ordens.executor_order_id`.

Isso elimina a duplicidade causada pela perda normal da resposta HTTP enquanto o mesmo processo do executor permanece ativo. Risco residual: a memória de IDs não sobrevive a restart do executor; exatamente-once através de restart exigiria fila/estado de execução durável, o que é uma mudança arquitetural separada.

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

Status: **mitigado nos patches BUG-006A, BUG-006B, BUG-006C e BUG-006D**.

A janela `hora_inicio`/`hora_fim` passa a ser aplicada antes de abrir novas sequências do Auto-Trader. Janelas normais e janelas que atravessam a meia-noite são suportadas; horários ausentes usam `00:00`–`23:59`, e configuração de horário inválida bloqueia a nova entrada. Gales de uma sequência já iniciada continuam até o desfecho para não deixar ordens pendentes/auditoria em estado incoerente.

O BUG-006B aplica `stop_win` e `stop_loss` sobre a variação entre `saldo_inicial` e o saldo global real/fresco do backend antes de cada nova sequência. Saldo ausente ou além da janela de freshness bloqueia a nova entrada sem inferir valor. Ao atingir Stop Win ou Stop Loss, o Auto-Trader é desligado com status explícito e exige reativação manual; a reativação já existente captura um novo baseline fresco e inicia outro ciclo em `STANDBY`.

O BUG-006C adiciona um Stop Reds exclusivo do Auto-Trader. A contagem só muda quando existe uma ordem `PENDENTE` daquele trader sendo efetivamente finalizada: GREEN/TIE zera o streak e um RED final, mesmo após DIRETO + Gales, acrescenta apenas 1 RED. Sinais apenas observados pelo sistema não contam.

Ao atingir o limite configurado, o motor pode entrar em `STOP_REDS_PAUSA` por N minutos, permanecendo ativo porém impedido de abrir novas sequências até o rearmamento automático, ou pode entrar em `STOP_REDS` com `ativo=false`, exigindo reativação manual. A reativação manual reutiliza o fluxo existente de novo baseline e também zera o estado de Stop Reds. O estado é persistido para sobreviver a restart do Node.

O BUG-006D implementa o Trailing Stop com uma distância de recuo explícita em reais (`trailing_recuo`). O backend registra em `trailing_pico_lucro` o maior lucro real observado nos checkpoints que antecedem nova exposição financeira. Quando o lucro atual recua até `pico - trailing_recuo`, o Auto-Trader entra em `TRAILING_STOP`, fica `ativo=false` e exige reativação manual.

O pico é persistido para sobreviver a restart do Node. Reativação manual, desligamento seguido de reativação e mudança de `trailing_stop`/`trailing_recuo` iniciam um novo pico. Para compatibilidade, configurações antigas com `trailing_stop=true` mas sem `trailing_recuo>0` permanecem desarmadas até que o usuário informe um recuo.

Sequências já iniciadas, inclusive Gales, continuam até o desfecho para preservar a auditoria; Stop Win e Stop Loss mantêm prioridade quando seus próprios limites também forem atingidos. O Stop Reds de Robôs/Canais permanece um mecanismo separado de geração/distribuição de sinais e não é usado pelo BUG-006C/BUG-006D.

### BUG-007 — Telegram e filtros de robôs parecem incompletos

Status: **mitigado pelos patches BUG-007A, BUG-007B, BUG-007C, BUG-007D e BUG-007E**.

O BUG-007A restaura o CRUD visual de Robôs. O BUG-007B conecta o canal web ao ciclo real do sinal, com precedência `exceção > avulso > origem`, propriedade por `robo_dono_id` em padrões dinâmicos e filtro de `min_assertividade`. O BUG-007C implementa entrega Telegram confirmada e união multicanal sem duplicar histórico.

O BUG-007D aplica o Drawdown Control conforme a semântica explícita do painel: `CONSERVADOR` pausa no primeiro RED; `DINAMICO` pausa após X REDs dentro de Y minutos; ambos usam `pausa_min`. Robôs em `standby_ate` ficam fora da seleção Web/Telegram até a expiração. O estado de proteção e a janela recente de REDs são persistidos para sobreviver a restart do Node. GREEN/TIE incrementa `greens_consecutivos`, RED zera o streak, e o aviso opcional de proteção no Telegram é enviado depois da mensagem de RED somente a destinos cuja ENTRADA foi confirmada.

O BUG-007E aplica `stop_reds_seguidos` como hard stop exclusivo do Robô/Canal. A contagem usa somente sinais nos quais o robô aparece em `robosInscritos`: GREEN/TIE zera o streak e RED final acrescenta uma unidade. Ao atingir o limite, `ativo=false` é persistido, a proteção temporária é limpa e o robô deixa de participar de novos sinais até reativação manual.

Quando o mesmo RED também acionaria o Drawdown Control, o Stop Reds definitivo tem precedência e não inicia uma pausa temporária redundante. O Drawdown Control continua sendo o mecanismo de cooldown; o Stop Reds permanece um desligamento manualmente reversível. Esse estado é independente do Stop Reds do Auto-Trader e não altera execução financeira, fichas, Gales ou ordens.

### BUG-008 — Sincronização de saldo da corretora estava incompleta

Status: **mitigado nos patches BUG-008A e BUG-008B, com validação operacional do seletor e heartbeat em 2026-08-17**.

O executor pode ler o saldo real diretamente da página usando o seletor CSS explícito `CASINO_BALANCE_SELECTOR` e enviar mensagens autenticadas de saldo ao Node por mudança/heartbeat. Sem seletor configurado ou sem valor válido, nenhum saldo é inferido.

O BUG-008B torna o backend dono do baseline financeiro. O navegador deixa de fornecer `saldo_inicial`; criação ativa e transição inativo→ativo exigem um saldo global recente, capturam esse valor como `saldo_inicial`/`saldo_atual` e iniciam um novo ciclo em `STANDBY`, zerando `entradas_feitas` e `pulos_restantes`. Edições de um trader já ativo preservam baseline, saldo e contadores. Criação inativa continua permitida e será recalibrada na ativação.

O Node registra quando o último saldo foi aceito e considera o valor fresco por `BALANCE_SYNC_MAX_AGE_SECONDS` (90 s por padrão, acima do heartbeat padrão de 60 s). Após restart, o saldo volta a desconhecido até uma nova sincronização, evitando reutilizar snapshot antigo.

A validação operacional confirmou o seletor CSS real no Chromium headless, a leitura monetária, o envio autenticado Python→Node e a renovação do snapshot por heartbeat mantendo `fresco=true`. Com isso, o BUG-006B pode usar o saldo real como fonte de enforcement financeiro. A semântica de trailing permanece separada.

### BUG-010 — Auto-Trader desligado pode conservar `status_operacao=OPERANDO`

Status: **mitigado no patch BUG-010**.

O `PUT /api/auto-trader/:id` atualizava `ativo=false` no desligamento manual, mas preservava o `status_operacao` anterior. Assim, um motor que estava `OPERANDO` podia ficar persistido como `ativo=false` + `OPERANDO`, mesmo sem executar novas entradas porque os gates financeiros também verificam `ativo`.

O BUG-010 torna a transição manual ON→OFF explícita: grava `status_operacao='DESLIGADO'`. Criação inativa usa o mesmo status, enquanto a reativação continua capturando saldo fresco e iniciando em `STANDBY`. No startup, somente combinações legadas `ativo=false` + `OPERANDO`/`STANDBY` são normalizadas. Estados que registram a causa de um hard stop (`STOP_WIN`, `STOP_LOSS`, `STOP_REDS` e `TRAILING_STOP`) não são sobrescritos.

### BUG-011 — Buraco Python→Node pode concatenar uma sequência que não existiu na mesa

Status: **mitigado no patch BUG-011**.

A proteção anterior dependia principalmente de `interrupcao_fluxo` calculado no Python por intervalo entre resultados capturados. Se o Python capturasse uma rodada normalmente, mas o POST daquele resultado não chegasse ao Node, o Python atualizava sua própria referência temporal e a rodada seguinte podia chegar com `interrupcao_fluxo=false`. O Node então não possuía evidência independente de que faltava um giro.

O BUG-011 adiciona redundância explícita. Cada processo Python recebe um `coletor_sessao` próprio e cada evento `Resolved` consome um `coletor_seq` monotônico antes de parsing/POST. Assim, uma falha posterior deixa um salto observável. O Node mantém a última sessão/seq/timestamp aceitos e rejeita pacotes duplicados ou atrasados; salto de sequência, mudança da sessão do coletor ou desaparecimento dos metadados depois de estabelecidos são tratados como buraco confirmado.

Toda quebra aceita rotaciona `id_sessao` antes de persistir a rodada seguinte, preservando a separação já usada pelo motor online, backtest e minerador. Em buraco confirmado, sinais que aguardavam resultado são invalidados para que a rodada seguinte não seja usada como resultado de uma sequência anterior. Se existir auditoria financeira `PENDENTE`, ela passa a `DADOS_INCOMPLETOS` e somente os Auto-Traders afetados são desligados até reativação manual, sem inferir WIN/LOSS.

Intervalos superiores a 60 segundos continuam provocando apenas quebra de sessão quando a sequência do coletor permanece íntegra. Isso preserva o comportamento anterior para uma mesa lenta/pausada e evita classificar apenas demora temporal como perda financeira confirmada. A estatística visual de maiores sequências também passa a zerar streaks na fronteira de `id_sessao`.

### BUG-012 — Padrões IA sobrevivem à exclusão do Robô/Canal proprietário

Status: **mitigado no patch BUG-012**.

Os cards de padrões dinâmicos são deliberadamente bloqueados no frontend porque pertencem ao Robô/Canal indicado por `robo_dono_id`. Porém, o endpoint `DELETE /api/robo/:id` removia somente destinatários e a linha de `robos_canais`, deixando os padrões `is_dinamico=true` órfãos no banco e ainda visíveis na área de padrões.

O BUG-012 torna a exclusão do robô transacional: históricos ligados aos padrões IA filhos, os próprios padrões dinâmicos, o histórico de distribuição do robô, destinatários e o registro do Robô/Canal são removidos como uma única operação lógica. Padrões manuais não são selecionados por essa cascata.

Para corrigir bancos já afetados, `prepararBancoDeDados()` executa no startup uma limpeza idempotente de estratégias `is_dinamico=true` cujo `robo_dono_id` é nulo ou não existe mais em `robos_canais`, removendo também seus históricos associados. Uma falha nessa limpeza aborta a inicialização pelo comportamento fail-closed já existente.

### OBS-001 — Exceções críticas são frequentemente silenciadas

Status: **parcialmente mitigado nos patches OBS-001A, OBS-001B, OBS-001C, OBS-001D e OBS-001E**.

No Node, migrations incrementais deixam de silenciar erros inesperados: somente `ER_DUP_FIELDNAME`/errno 1060 continua tratado como condição normal de idempotência. Rotas CRUD críticas registram contexto técnico; `apagarEstrategiaEDados()` deixa o erro subir; e falhas em fechamento `LOSS`, `pulos_restantes`, rollback e processamento pós-ACK ficam visíveis.

O OBS-001C torna a inicialização fail-closed. Enquanto banco/schema/memória ainda não terminaram, `/api/*` e `/receber-sinal` retornam 503 e Socket.IO rejeita handshake. Erro inesperado de migration ou carga inicial deixa de ser absorvido: a falha sobe até `iniciarApp()`, que fecha Socket.IO, HTTP e o pool MySQL e encerra o processo com código de erro, evitando um backend parcialmente inicializado.

O OBS-001D torna visíveis as três persistências críticas que ainda estavam silenciosas no ciclo principal: inserção em `giros_recentes`, fechamento `WIN/TIE` em `auditoria_ordens` e persistência de `META_ATINGIDA`. O comportamento operacional não muda; apenas a falha deixa de desaparecer sem diagnóstico.

O OBS-001E deixa de suprimir erros globais realmente não tratados: `uncaughtException` e `unhandledRejection` agora encerram o processo após registrar o erro, evitando continuar em estado potencialmente inconsistente. As três promises Telegram executadas em background recebem `catch` contextual próprio, para que falhas inesperadas de notificação sejam observadas localmente sem depender do handler global.

No executor Python, o envio de resultado resolvido ao Node valida o status HTTP com `raise_for_status()` e registra falhas sem alterar o ciclo da mesa. Exceções inesperadas em `processar_resultado`, frames WebSocket, Auto-Login, loop principal do Playwright e restart externo também ficam visíveis. Logs de alta frequência usam limitação temporal de 30 segundos.

Ruído esperado continua tolerado: frames WebSocket que não são JSON, falhas em pop-ups opcionais, fallback de stealth, varredura de frames para saldo e o botão opcional “Continuar” não viram erro fatal. O item permanece parcial porque ainda não existe logging estruturado/arquivo rotativo nem métricas centralizadas.

### OBS-002 — Schema inicial incompleto no código

Status: **mitigado no patch BUG-009**.

`prepararBancoDeDados()` passa a criar `origens` e `estrategias` com os campos efetivamente exigidos pelas rotas CRUD, contadores legados e campos dinâmicos já usados/migrados pelo backend. As criações usam `CREATE TABLE IF NOT EXISTS` e ocorrem antes das migrations `ALTER TABLE`, permitindo inicializar um banco vazio sem depender de um dump externo.

O patch não adiciona constraints, índices ou relacionamentos novos além das chaves primárias mínimas já implícitas no uso atual, preservando compatibilidade com bancos existentes.

### OBS-003 — Não há teste automatizado

Status: **parcialmente mitigado nos patches OBS-003A, OBS-003B e OBS-003C**.

O OBS-003A substitui o placeholder de `npm test` por uma suíte `node:test` sobre lógica pura já existente em `bot2_coletor.js`, sem iniciar Express, Socket.IO, MySQL, Telegram ou executor de apostas. Ela cobre arredondamento de ficha, classificação DIRETO/GALE, TIEs legados, precedência `exceção > avulso > origem`, propriedade de estratégia dinâmica, formatação Telegram e janelas de horário normais/full-day/overnight.

O OBS-003B adiciona uma suíte Python com `unittest` que lê `robo.py` por AST e compila somente as funções sob teste, evitando executar o top-level que inicia Flask/Playwright. A cobertura inclui parsing monetário nos formatos brasileiro/internacional, rejeição de valores negativos, montagem do payload de rodada resolvida, normalização de TIE, fronteira de interrupção `> 60s`, autenticação interna no POST e tratamento de erro HTTP do resultado→Node com fakes locais.

O OBS-003C adiciona GitHub Actions para executar automaticamente as duas suítes e checagens de sintaxe em cada pull request para `main` e em cada push para `main`. O workflow usa permissões somente de leitura, não recebe secrets, não instala dependências e não inicia banco, servidor, Playwright ou chamadas externas do projeto.

Ainda faltam testes de integração de banco/rotas e testes reais de Playwright/DOM; por isso o item permanece parcialmente mitigado.
