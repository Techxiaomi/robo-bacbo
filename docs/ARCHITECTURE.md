# Arquitetura Atual

Atualizado em 2026-09-05 para refletir a arquitetura Redis/Garnet vigente na branch de trabalho.

## Visão geral

```text
Fontes de mesa / TipMiner
        |
        v
robo-sync-pilot/tipminer_collector.py
        |
        | Redis Pub/Sub + chaves escopadas por mesa
        v
Garnet / Redis local
        |
        v
robo-bacbo/start.js
        |
        +--> identidade/schema da mesa
        +--> Redis Runtime V3
        +--> sincronização de histórico
        +--> guards / bridges / serviços
        +--> bot2_coletor.js
                |
                +--> MySQL
                +--> Express / Socket.IO / painel
                +--> estratégias, robôs, auditoria e estado

Orquestrador Node por conta/mesa
robo-bacbo/scripts/run_live_bridge.js
        |
        | spawn + configuração JSON por stdin
        v
robo-sync-pilot/live_bridge.py
        |
        v
robo-sync-pilot/robo.py + Playwright
        ^
        | Redis response channel por sessão
        |
Garnet / Redis
        ^
        | Redis command channel por sessão
        |
      Node.js
```

A fronteira Node ↔ executor Python é orientada a eventos por Redis. O executor Python atual é Redis-only e não expõe Flask.

## 1. Composition root Node.js

Entrypoint: `robo-bacbo/start.js`.

O bootstrap carrega o ambiente e instala componentes em ordem deliberada antes de carregar o backend principal. Entre os passos atuais estão:

- logging operacional;
- bridge Socket.IO do mapa/live;
- presenter/lifecycle Telegram;
- schema e identidade da mesa;
- integridade de soma dos resultados;
- contexto de transporte da mesa;
- Redis Runtime V3;
- sincronização TipMiner/history;
- snapshot do mapa;
- migração de configuração Telegram;
- barreira de drenagem de histórico;
- guards de backend, conta, regras por mesa e integridade estrutural;
- serviços de saldo e autorização multi-conta;
- barreira de histórico do Auto Pilot IA;
- carga final de `bot2_coletor.js`.

Falha crítica no bootstrap encerra o processo em vez de deixar um runtime parcialmente inicializado.

## 2. Backend Node.js

`robo-bacbo/bot2_coletor.js` continua concentrando grande parte do backend histórico e permanece um hotspot de dívida técnica.

Responsabilidades atuais incluem:

- Express e Socket.IO para painel e APIs locais;
- MySQL e persistência operacional;
- estratégias e padrões;
- Robôs/Canais;
- Auto Pilot IA;
- estado e auditoria do Auto-Trader;
- processamento de resultados por mesa;
- telemetria e logs;
- integração com os bridges de transporte atuais.

A presença de rotas HTTP no Node não significa transporte HTTP Node ↔ Python. O backend ainda possui contratos HTTP locais próprios e compatibilidade interna com código legado.

## 3. Redis Runtime e ingestão de resultados

`robo-sync-pilot/tipminer_collector.py` usa Redis e publica os dados em recursos escopados por `BACBO_MESA_CODIGO`.

Os principais recursos incluem:

- history key por mesa;
- latest round key por mesa;
- events channel por mesa;
- history ACK key por mesa.

No Node, `redis_runtime_v3.js` e os serviços associados processam o data plane Redis somente depois de a identidade da mesa estar fixada.

A arquitetura preserva isolamento entre mesas e evita que uma instância consuma eventos pertencentes a outro escopo lógico.

## 4. Executor Python

### `robo.py`

`robo-sync-pilot/robo.py` declara explicitamente configuração `REDIS-ONLY DO EXECUTOR`.

O módulo contém:

- Playwright;
- fila local de comandos;
- listener Redis;
- canais de command/response;
- controle de shutdown cooperativo;
- idempotência local;
- readiness do navegador;
- validação de janela/DOM;
- processamento dos comandos recebidos do barramento.

O executor não inicia servidor Flask e não depende de endpoint `/apostar` para receber comandos.

### `live_bridge.py`

`robo-sync-pilot/live_bridge.py` encapsula uma sessão operacional de Playwright por conta/mesa.

A configuração inicial é enviada pelo processo pai Node via stdin e contém, entre outros dados:

- identidade da conta;
- identidade da mesa;
- `session_id`;
- `redis_command_channel`;
- `redis_response_channel`;
- configuração de controle e parâmetros técnicos.

Os canais são validados antes da operação e precisam ser distintos.

### Orquestrador Node

`robo-bacbo/scripts/run_live_bridge.js` resolve conta/mesa no banco, cria canais Redis escopados por sessão, inicia `live_bridge.py` como processo filho e mantém um canal de controle por stdin para shutdown coordenado.

O stdout/stderr do filho também é usado para telemetria e diagnóstico do startup.

## 5. Bridge de compatibilidade do executor

`robo-bacbo/redis_executor_bridge.js` existe para compatibilizar partes antigas do backend com a arquitetura Redis sem exigir uma reescrita monolítica.

Ele:

- conecta publisher/subscribers Redis;
- publica comandos no barramento;
- assina respostas do executor;
- recebe eventos Bac Bo do Redis;
- traduz chamadas internas legadas destinadas ao `EXECUTOR_URL` para publicação Redis.

O ponto importante é que essa tradução acontece dentro do processo Node. A URL histórica pode ainda existir como chave de compatibilidade/configuração, mas o Python atual não hospeda o endpoint HTTP correspondente.

## 6. Persistência

MySQL continua sendo a persistência durável principal para configuração, histórico, estado operacional e auditoria.

Redis/Garnet é o barramento de comunicação e estado efêmero/operacional; não substitui o MySQL como fonte durável de toda a aplicação.

## 7. Interface administrativa

Express e Socket.IO continuam servindo o painel e APIs locais do Node.

Essas interfaces são independentes da fronteira de transporte Node ↔ executor Python.

## 8. Diagnósticos

Utilitários de diagnóstico Python ficam em:

```text
robo-sync-pilot/diagnostics/
```

Atualmente:

- `dry_run_discovery.py`;
- `evolution_chip_dom_probe.py`.

O launcher Node `scripts/run_dry_run.js` aponta para o novo caminho do discovery.

## 9. Sessão Playwright

`robo-sync-pilot/gerar_sessao.py` permanece como ferramenta operacional para criar/renovar o `storage_state` autenticado.

Arquivos de sessão, `.env`, cookies e credenciais não devem ser versionados.

## 10. Observabilidade

O Node possui logging e snapshots locais de métricas/estado operacional. Artefatos gerados em runtime ficam fora do Git.

O live bridge também expõe marcadores de startup, readiness, shutdown e erro pelo stdout/stderr para o supervisor/orquestrador.

## 11. Limites de consistência

A arquitetura melhora isolamento, correlação e recuperação local, mas continua sujeita a dependências externas:

- disponibilidade do Redis/Garnet;
- disponibilidade do MySQL;
- sessão autenticada;
- mudanças de DOM ou comportamento da plataforma;
- disponibilidade da fonte de resultados;
- crash durante efeitos externos não transacionais.

Não se deve afirmar exactly-once absoluto para um efeito externo executado via interface gráfica. As garantias locais de idempotência, identidade, ordenação e auditoria reduzem ambiguidade, mas não transformam a plataforma externa em uma API transacional.

## 12. Regra de evolução

Alterações arquiteturais devem ser pequenas, isoladas e testáveis. Compatibilidades antigas só devem ser removidas quando todos os chamadores atuais tiverem sido migrados e houver cobertura que prove a ausência de regressão.
