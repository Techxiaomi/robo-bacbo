# Estado Atual do Projeto

Atualizado em 2026-09-05 após os Rounds 3A e 3B de higiene estrutural.

Este documento descreve o estado corrente da arquitetura de runtime. Snapshots antigos ficam em `docs/archive/` e não devem ser usados como referência operacional atual.

## Arquitetura em operação

O projeto é composto por quatro blocos principais:

- `robo-bacbo`: Node.js / Express / MySQL / Socket.IO, responsável por bootstrap, painel, estratégias, robôs/canais, estado operacional, auditoria e integração Redis;
- `robo-sync-pilot/tipminer_collector.py`: coletor Python que publica histórico e rodadas em Redis, com escopo por mesa;
- `robo-sync-pilot/live_bridge.py` + `robo.py`: executor Python / Playwright isolado por conta/mesa, orientado a eventos;
- Garnet/Redis local: barramento assíncrono para ingestão de eventos e para command/response do executor.

O executor Python atual não utiliza Flask. Não existe servidor Python recebendo ordens em `/apostar`.

## Transporte atual

### Resultados e histórico

O coletor TipMiner usa Redis para publicar dados em recursos escopados por mesa. O Node fixa a identidade da mesa antes de ativar o data plane Redis e processa histórico/live por meio do Redis Runtime atual.

### Comandos e respostas do executor

As instâncias de live bridge usam canais Redis específicos da sessão:

```text
auto_trader_commands:<account_id>:<table_key>
auto_trader_responses:<account_id>:<table_key>
```

`run_live_bridge.js` resolve conta/mesa, prepara a configuração e inicia `live_bridge.py` como processo filho. A configuração inicial e comandos de shutdown do processo pai trafegam por stdin; ordens e respostas operacionais trafegam pelo Redis.

`robo.py` também mantém canais Redis padrão para o executor legado/compatível quando executado diretamente.

### Compatibilidade HTTP interna no Node

O backend ainda possui rotas HTTP próprias e partes históricas do código podem formular chamadas para a URL configurada do executor. `redis_executor_bridge.js` converte essas chamadas dentro do runtime Node em publicação Redis.

Portanto:

- HTTP continua existindo no backend/painel Node;
- não há transporte HTTP direto Node → Flask/Python;
- não há callback HTTP iniciado pelo Python para um servidor Flask inexistente;
- referências históricas a `EXECUTOR_URL` podem permanecer como camada de compatibilidade interna enquanto seus chamadores não forem totalmente migrados.

## Bootstrap Node

`npm start` executa `robo-bacbo/start.js`.

A ordem atual inclui:

1. carregamento de `.env`;
2. logging operacional e bridges de apresentação;
3. preparação do schema/identidade da mesa;
4. integridade dos resultados;
5. contexto de transporte;
6. instalação do Redis Runtime V3;
7. sincronização inicial TipMiner/history;
8. barreira de histórico;
9. guards por mesa, conta e configuração;
10. serviços de saldo e integridade estrutural;
11. autorização multi-conta;
12. Auto Pilot history barrier;
13. carga de `bot2_coletor.js`.

O bootstrap continua fail-closed em falha crítica.

## Multi-mesa e identidade

O runtime usa identidade explícita de mesa e escopos próprios para dados, Redis e configuração. Os launchers locais selecionam a mesa por ambiente, sem exigir cópias físicas separadas `BR/` e `INT/` do projeto.

As antigas pastas locais `BR/` e `INT/` foram classificadas como cópias locais obsoletas e removidas durante a higiene do workspace; não fazem parte do Git.

## Executor Playwright

`robo.py` mantém:

- Playwright;
- fila local de comandos;
- Redis Pub/Sub;
- shutdown cooperativo;
- readiness do navegador;
- idempotência local;
- validações de identidade e de janela/DOM;
- processamento serializado das tarefas recebidas.

`live_bridge.py` valida identidade da conta, mesa, sessão e canais Redis antes de iniciar o runtime Playwright.

## Diagnósticos

Os diagnósticos Python foram reorganizados para:

```text
robo-sync-pilot/diagnostics/
```

Conteúdo atual:

- `__init__.py`;
- `dry_run_discovery.py`;
- `evolution_chip_dom_probe.py`.

O teste `tests/test_evolution_chip_dom_probe.py` importa o módulo pelo novo pacote e o launcher Node do discovery aponta para o caminho atualizado.

Na validação local do Round 3B:

- `py_compile` passou;
- teste focado do probe passou 3/3;
- `python -m unittest discover -s tests -v` passou 58/58.

## Sessão e segredos

- `.env` permanece exclusivamente local;
- `backups/` permanece fora do versionamento;
- arquivos de sessão autenticada não devem ser commitados;
- `gerar_sessao.py` continua sendo a ferramenta operacional para criar/renovar `storage_state`.

## Higiene estrutural recente

### Round 3A

Foram removidos patchers BUG-051 one-shot e workflows temporários de migração que já não pertenciam ao fluxo atual.

### Round 3B

Ferramentas de diagnóstico foram movidas para pacote dedicado sem alterar o comportamento funcional.

### Round 3C

A documentação viva foi alinhada à arquitetura Redis/Garnet e os snapshots de 2026-08-17 foram movidos para `docs/archive/`.

## Testes e CI

A suíte Python atual usa `unittest`. A suíte Node usa `node:test` via `npm test`.

O workflow `.github/workflows/ci.yml` atual executa em pull requests para `main` e contém gates básicos de sintaxe/testes Node e Python. Testes locais adicionais continuam sendo usados proporcionalmente ao tipo de alteração.

## Riscos e dívida técnica

- `bot2_coletor.js` continua grande e multifuncional; modularização deve ser gradual e coberta por testes;
- bridges de compatibilidade ainda existem e só devem ser removidos após migração completa dos chamadores;
- Redis/Garnet é uma dependência operacional central do data plane atual;
- MySQL continua sendo dependência durável central;
- DOM, sessão e comportamento de serviços externos continuam sujeitos a mudança;
- efeitos externos via Playwright não oferecem garantia transacional exactly-once absoluta.

## Regra de manutenção

Não reescrever componentes grandes apenas para uniformizar arquitetura. Preferir migrações pequenas, verificáveis e reversíveis; remover compatibilidade somente quando evidência de uso e testes permitirem.
