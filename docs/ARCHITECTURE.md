# Arquitetura Atual

Atualizado em 2026-08-17 para refletir o `main` após BUG-001…BUG-015, SEC-002/003/004 e OBS-001/003.

## Visão geral

```text
Navegador / Painel
    |
    | HTTP REST + Socket.IO
    v
robo-bacbo/bot2_coletor.js
(Node.js / Express / MySQL / Socket.IO)
    |                         ^
    | MySQL                   | POST /executor-status
    v                         |
Banco                    robo-sync-pilot/robo.py
                         (Flask + Playwright)
                              ^
                              | POST /apostar
                              |
                         ordem + order_id
                              |
                              +---------------- Node

Mesa Bac Bo / Playwright
    |
    | WebSocket: resultado resolvido
    v
robo.py
    |
    | POST /receber-sinal
    v
Node
```

Os dois processos usam o mesmo `INTERNAL_API_TOKEN` nas rotas internas. Node e Flask usam loopback por padrão.

## Backend Node.js

Arquivo principal: `robo-bacbo/bot2_coletor.js`.

Responsabilidades atuais:

- bootstrap e migrations incrementais do MySQL;
- CRUD de estratégias, origens, Robôs/Canais e Auto-Traders;
- painel web e Socket.IO;
- autenticação administrativa por sessão quando configurada/obrigatória;
- recepção e validação de continuidade das rodadas;
- histórico bruto e estatísticas dos padrões;
- matching de estratégias, DIRETO/Gales e proteção de empate;
- roteamento Web/Telegram dos Robôs/Canais;
- regras financeiras do Auto-Trader;
- geração e auditoria do lifecycle das ordens;
- logging e métricas locais.

### Inicialização

O backend é fail-closed. Banco, schema, limpeza idempotente e carga das estruturas em memória precisam terminar antes de APIs dependentes e Socket.IO serem considerados prontos. Falha crítica de bootstrap encerra o processo em vez de deixá-lo parcialmente operacional.

### Processamento das rodadas

O coletor envia `coletor_sessao` e `coletor_seq`. O Node mantém dois conceitos separados:

- **admissão de continuidade**: reserva a sequência recebida sincronamente antes do primeiro I/O;
- **processamento pós-ACK**: roda em FIFO único, impedindo que uma rodada seguinte ultrapasse a anterior enquanto ela aguarda MySQL ou executor.

Duplicatas/fora de ordem são ignoradas. Restart do coletor, salto de sequência ou desaparecimento de metadados são tratados como buraco confirmado e separam a sessão lógica; pausas temporais também separam sessões sem inferir resultado financeiro.

### Tabelas conhecidas

O backend cria as nove estruturas usadas pela aplicação a partir de banco vazio:

- `origens`
- `estrategias`
- `historico_resultados`
- `giros_recentes`
- `robos_canais`
- `destinatarios_robo`
- `historico_disparos_robos`
- `auto_traders`
- `auditoria_ordens`

O bootstrap em MySQL 8.4 vazio é validado no CI.

## Executor / coletor Python

Arquivo principal: `robo-sync-pilot/robo.py`.

Responsabilidades atuais:

- servidor Flask local para receber ordens;
- journal local de `order_id` para deduplicação entre restarts;
- controle de readiness do Playwright;
- fila de ordens com TTL;
- Playwright Chromium em modo headless;
- reaproveitamento/renovação de sessão autenticada;
- captura do WebSocket da mesa;
- deduplicação defensiva de frames `Resolved` antes de consumir `coletor_seq`;
- extração dos resultados e dados;
- leitura/sincronização do saldo por seletor configurável;
- execução dos cliques de ficha/alvo;
- callback autenticado do resultado local da tentativa DOM.

### Deduplicação de resultados

Quando o payload fornece uma identidade explícita de rodada (`roundId` e variantes conhecidas), ela é usada como chave. Na ausência, o coletor usa vencedor + dados normalizados dentro de uma janela temporal curta e deslizante (`RESULT_DEDUP_WINDOW_SECONDS`). A deduplicação ocorre antes de incrementar `coletor_seq`.

### Lifecycle da ordem

O fluxo financeiro atual é:

```text
Node
  |
  | INSERT auditoria_ordens = PREPARANDO + order_id
  v
POST /apostar
  |
  | executor pronto? journal persistido? fila dentro do TTL?
  v
Playwright
  |
  | tentativa DOM
  v
POST /executor-status
  |
  +--> EXECUTADA -> Node promove PREPARANDO para PENDENTE
  +--> FALHOU    -> FALHA_EXECUCAO
  +--> EXPIRADA  -> ORDEM_EXPIRADA
  +--> AMBIGUA   -> ENVIO_AMBIGUO
```

Uma nova ordem não é aceita se o Playwright não estiver pronto. Ordem já aceita/persistida continua reconhecida idempotentemente após restart, sem reenfileirar automaticamente.

`EXECUTADA` significa somente que os cliques planejados foram concluídos localmente sem erro observável. Não é confirmação transacional da plataforma externa.

## Gerador de sessão

`robo-sync-pilot/gerar_sessao.py` abre um navegador visível para login manual e grava o `storage_state`. Esse arquivo pode conter cookies/localStorage autenticados e deve ser tratado como credencial.

## Contratos internos

### Python → Node: `POST /receber-sinal`

Payload de rodada pode conter:

- `vencedor`
- `resultado_bruto`
- `pontos_jogador`
- `pontos_banca`
- `dados_jogador`
- `dados_banca`
- `coletor_sessao`
- `coletor_seq`
- `interrupcao_fluxo`
- `timestamp_coleta`

Mensagens de sincronização de saldo usam `saldo_atual` e `timestamp_coleta` na mesma rota.

### Node → Python: `POST /apostar`

Campos:

- `order_id`: UUID da ordem;
- `alvo`: `PlayerWon`, `BankerWon` ou `Tie`;
- `valor`: valor monetário da ordem.

O ACK HTTP representa aceite idempotente na fila, não execução final.

### Python → Node: `POST /executor-status`

Campos:

- `order_id`;
- `status`: `EXECUTADA`, `FALHOU`, `EXPIRADA` ou `AMBIGUA`;
- `motivo`: contexto local limitado da tentativa.

O Node registra o waiter antes do POST para que um callback que chegue antes do próprio ACK HTTP não seja perdido.

## Interface administrativa

O painel e as rotas `/api/*` podem usar sessão opaca em memória com cookie `HttpOnly`, `SameSite=Strict` e TTL. Fora do loopback, credenciais administrativas são obrigatórias. O handshake Socket.IO exige a mesma autorização quando o modo administrativo está ativo.

As rotas internas `/receber-sinal` e `/executor-status` permanecem separadas da sessão administrativa e usam `INTERNAL_API_TOKEN`; `/apostar` usa o mesmo token no Flask.

## Observabilidade

O Node possui:

- log estruturado JSONL rotativo com redaction;
- snapshot de métricas runtime;
- snapshot de métricas HTTP/operacionais;
- encerramento em `uncaughtException` e `unhandledRejection` após log.

Os snapshots locais ficam em `logs/` por padrão e não são versionados.

## Limites externos

Continuam fora do controle transacional do projeto:

- disponibilidade e comportamento da plataforma de destino;
- mudanças de DOM/WebSocket;
- validade da sessão/credenciais;
- disponibilidade do MySQL e rede;
- confirmação idempotente do efeito financeiro externo.

Por isso, o projeto evita afirmar exactly-once absoluto do clique/aposta externa. O `order_id`, journal, estados de auditoria, readiness, TTL e callback reduzem a ambiguidade local, mas não substituem uma API transacional do destino.
