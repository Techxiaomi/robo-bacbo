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

O backend expõe operações administrativas e dados do sistema. A superfície depende da rede/firewall, mas precisa de hardening antes de exposição fora de localhost.

### SEC-004 — Token Telegram pode ser devolvido pelo `GET /api/robos`

O objeto retornado espalha os campos do registro (`...r`), o que inclui `telegram_token`. O frontend não precisa receber o segredo completo para listar robôs.

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

`historico_disparos_robos` permanece pendente: o backend atual não mantém uma associação confiável entre um sinal e os robôs que efetivamente o receberam. Essa persistência será tratada junto ao fluxo de robôs/Telegram do BUG-007, em vez de fabricar estatísticas de destinatários.

### BUG-006 — Stop Win / Stop Loss / Trailing / horário estão configuráveis no painel sem enforcement localizado

Status: **parcialmente mitigado no patch BUG-006A**.

A janela `hora_inicio`/`hora_fim` passa a ser aplicada antes de abrir novas sequências do Auto-Trader. Janelas normais e janelas que atravessam a meia-noite são suportadas; horários ausentes usam `00:00`–`23:59`, e configuração de horário inválida bloqueia a nova entrada. Gales de uma sequência já iniciada continuam até o desfecho para não deixar ordens pendentes/auditoria em estado incoerente.

Stop Win, Stop Loss e trailing permanecem pendentes. O Python atual não envia `saldo_atual`, então o backend ainda não possui uma fonte confiável para aplicar limites financeiros. Além disso, `trailing_stop` é apenas booleano no painel e não define distância/recuo de trailing. Esses controles devem ser concluídos junto à sincronização de saldo (BUG-008) e à definição explícita da regra de trailing.

### BUG-007 — Telegram e filtros de robôs parecem incompletos

Há CRUD/configuração, mas não foi localizada chamada à API Telegram nem fluxo completo de disparo no backend fornecido.

### OBS-001 — Exceções críticas são frequentemente silenciadas

Há vários `catch(e){}` e `except: pass`, inclusive em persistência, HTTP e automação. Isso dificulta distinguir falha de regra de negócio de falha técnica.

### OBS-002 — Schema inicial incompleto no código

`estrategias` e `origens` são assumidas como existentes. Precisamos obter/exportar o schema real antes de considerar o repositório autocontido.

### OBS-003 — Não há teste automatizado

O `package.json` possui apenas um teste placeholder e o Python não inclui suite de testes. Criar testes de lógica pura antes de grandes refatorações.
