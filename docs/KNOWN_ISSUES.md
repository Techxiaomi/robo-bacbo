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

O Python detecta pausas superiores a 60 segundos. O Node mantém `idSessaoContinua` constante no snapshot, portanto a separação de sessões pode não ocorrer.

### BUG-005 — Tabelas de histórico são consultadas sem persistência correspondente visível

`historico_resultados` e `historico_disparos_robos` são usados nas estatísticas, mas não foram localizados INSERTs de todos os eventos esperados neste snapshot.

### BUG-006 — Stop Win / Stop Loss / Trailing / horário estão configuráveis no painel sem enforcement localizado

Os valores são salvos no `config_json`, porém não foi localizada a checagem dessas regras antes de novas apostas.

### BUG-007 — Telegram e filtros de robôs parecem incompletos

Há CRUD/configuração, mas não foi localizada chamada à API Telegram nem fluxo completo de disparo no backend fornecido.

### OBS-001 — Exceções críticas são frequentemente silenciadas

Há vários `catch(e){}` e `except: pass`, inclusive em persistência, HTTP e automação. Isso dificulta distinguir falha de regra de negócio de falha técnica.

### OBS-002 — Schema inicial incompleto no código

`estrategias` e `origens` são assumidas como existentes. Precisamos obter/exportar o schema real antes de considerar o repositório autocontido.

### OBS-003 — Não há teste automatizado

O `package.json` possui apenas um teste placeholder e o Python não inclui suite de testes. Criar testes de lógica pura antes de grandes refatorações.
