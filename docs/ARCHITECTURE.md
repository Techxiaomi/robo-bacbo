# Arquitetura Atual

## Visão geral

```text
Navegador / Painel
    |
    | HTTP REST + Socket.IO
    v
robo-bacbo/bot2_coletor.js (Node.js / Express, porta 3000)
    |                     |
    | MySQL               | POST /apostar
    v                     v
Banco remoto       robo-sync-pilot/robo.py
                   (Flask + Playwright, porta 5000)
                            |
                            | browser automation + WebSocket do jogo
                            v
                       Mesa Bac Bo
                            |
                            | resultado resolvido
                            v
                   POST /receber-sinal
                            |
                            v
                         Node.js
```

## Backend Node.js

Arquivo principal: `robo-bacbo/bot2_coletor.js`.

Responsabilidades observadas:

- conexão MySQL;
- criação/migração parcial de tabelas;
- CRUD de estratégias, origens, robôs/canais e auto-traders;
- painel via arquivos estáticos em `public/`;
- Socket.IO para atualização de interface;
- recepção de resultados em `POST /receber-sinal`;
- memória das estratégias ativas;
- detecção de padrões sequenciais;
- gerenciamento de gale;
- geração de ordens para o executor Python;
- auditoria parcial de ordens;
- simulador de banca.

### Endpoints observados

- `GET /api/saldo-global`
- `GET /api/estrategias`
- `GET /api/dashboard-stats`
- `GET /api/historico-giros`
- `POST /api/simular-banca`
- `POST /api/novo-padrao`
- `PUT /api/estrategia/:id`
- `DELETE /api/estrategia/:id`
- `GET /api/origens`
- `POST /api/nova-origem`
- `PUT /api/origem/:id`
- `DELETE /api/origem/:id`
- `GET /api/robos`
- `POST /api/robo`
- `PUT /api/robo/:id`
- `DELETE /api/robo/:id`
- `GET /api/auto-traders`
- `POST /api/auto-trader`
- `PUT /api/auto-trader/:id`
- `DELETE /api/auto-trader/:id`
- `GET /api/auditoria-ordens/:trader_id`
- `POST /receber-sinal`

### Tabelas criadas pelo snapshot

- `historico_resultados`
- `giros_recentes`
- `robos_canais`
- `destinatarios_robo`
- `historico_disparos_robos`
- `auto_traders`
- `auditoria_ordens`

O código também depende de `estrategias` e `origens`, mas o snapshot fornecido não contém a criação dessas duas tabelas. Portanto, o banco existente faz parte da baseline operacional e deve ser documentado/exportado posteriormente.

## Executor Python

Arquivo principal: `robo-sync-pilot/robo.py`.

Responsabilidades observadas:

- servidor Flask local para receber ordens;
- fila interna de apostas;
- Playwright Chromium em modo headless;
- reaproveitamento de sessão autenticada;
- auto-login quando a sessão falha;
- captura de WebSocket da mesa;
- extração do resultado e dados;
- POST dos resultados para o Node;
- execução dos cliques de fichas/alvos na mesa.

Endpoint observado:

- `POST /apostar`

## Gerador de sessão

`robo-sync-pilot/gerar_sessao.py` abre um navegador visível para login manual e salva um `storage_state` do Playwright. Esse arquivo contém cookies/localStorage e deve ser tratado como credencial.

## Contrato Node ↔ Python

### Python → Node (`POST /receber-sinal`)

Campos observados:

- `vencedor`
- `resultado_bruto`
- `pontos_jogador`
- `pontos_banca`
- `dados_jogador`
- `dados_banca`
- `interrupcao_fluxo`
- `timestamp_coleta`

### Node → Python (`POST /apostar`)

Campos observados:

- `alvo`: `PlayerWon`, `BankerWon` ou `Tie`
- `valor`: valor monetário calculado/arredondado

Esse contrato deve ser tratado como API interna e versionado com cuidado.
