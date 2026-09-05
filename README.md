# Bac Bo Automation

Projeto local de automação, monitoramento e execução controlada para mesas Bac Bo, dividido entre um backend Node.js e componentes Python orientados a eventos.

## Arquitetura atual

O runtime principal está organizado em três camadas:

- `robo-bacbo/`: backend Node.js / Express / MySQL / Socket.IO, bootstrap, painel, estratégias, Robôs/Canais, estado operacional, telemetria e integração Redis;
- `robo-sync-pilot/`: coletores e executor Python com Playwright;
- Garnet/Redis local: barramento assíncrono usado para eventos de mesa e para os canais de comando/resposta do executor.

O executor Python não expõe mais servidor Flask nem recebe ordens por HTTP. O transporte Node → executor e executor → Node usa canais Redis.

### Fluxo de alto nível

```text
TipMiner / fontes de mesa
        |
        v
coletor Python
        |
        | Redis: bacbo_events:<mesa>
        v
Node.js / Redis Runtime
        |
        | processamento, persistência e regras
        v
MySQL / painel / robôs / auditoria

Node.js / orquestrador de live bridge
        |
        | inicia live_bridge.py e fornece configuração por stdin
        v
Python + Playwright
        ^
        | Redis response channel
        |
Redis command channel
        ^
        |
      Node.js
```

Há compatibilidade interna no backend para código legado que ainda formula uma chamada ao `EXECUTOR_URL`; `redis_executor_bridge.js` intercepta essa chamada dentro do próprio processo Node e a converte em publicação Redis. Isso não cria um servidor HTTP no Python.

## Bootstrap Node.js

O entrypoint é:

```bash
cd robo-bacbo
npm install
npm start
```

`npm start` executa `start.js`, que carrega `.env`, instala os bridges de observabilidade/UI, prepara schema e identidade da mesa, instala o Redis Runtime V3, sincroniza histórico TipMiner, aplica guards de configuração e somente então carrega `bot2_coletor.js`.

O bootstrap é fail-closed: falhas críticas impedem a inicialização parcial do backend.

## Python

### Coletor TipMiner

`robo-sync-pilot/tipminer_collector.py` publica histórico e rodadas live em canais Redis escopados por mesa.

### Executor Playwright

`robo-sync-pilot/robo.py` contém o núcleo do executor e usa Redis Pub/Sub para comandos e respostas. A configuração padrão inclui:

- `REDIS_URL`;
- canal de comandos;
- canal de respostas;
- fila local de trabalho;
- proteção de encerramento cooperativo;
- idempotência local;
- Playwright.

`robo-sync-pilot/live_bridge.py` é o processo isolado de execução por conta/mesa. Ele recebe configuração inicial por stdin do orquestrador Node e opera com canais Redis específicos da sessão.

### Diagnósticos

Ferramentas auxiliares ficam em:

```text
robo-sync-pilot/diagnostics/
```

Incluindo `dry_run_discovery.py` e `evolution_chip_dom_probe.py`.

`gerar_sessao.py` permanece na raiz do projeto Python porque é uma ferramenta operacional para criação/renovação do `storage_state` local.

## Primeira configuração local

1. Copie `.env.example` para `.env` na raiz.
2. Preencha credenciais, URLs, IDs de mesa e parâmetros locais necessários.
3. Nunca versione `.env`, arquivos de sessão autenticada, cookies, tokens ou backups contendo credenciais.
4. Garanta que Garnet/Redis esteja disponível antes dos componentes que dependem do barramento.

### Executor Python no Windows

```bat
cd robo-sync-pilot
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
playwright install chromium
python gerar_sessao.py
python robo.py
```

O projeto também possui launchers/orquestradores que iniciam instâncias por conta/mesa sem exigir execução manual de `robo.py` em todos os cenários.

## Validação

Antes de commits:

```bash
python scripts/check_secrets.py
```

Node:

```bash
cd robo-bacbo
npm test
```

Python:

```bash
cd robo-sync-pilot
python -m unittest discover -s tests -v
```

## Documentação viva

- `docs/CURRENT_STATE.md`: estado funcional e operacional atual;
- `docs/ARCHITECTURE.md`: topologia, contratos e responsabilidades atuais;
- `docs/KNOWN_ISSUES.md`: riscos e pendências conhecidas;
- `docs/SECURITY_BASELINE.md`: regras de segurança e versionamento;
- `PROJECT_RULES.md`: regras obrigatórias para alterações.

Snapshots e handoffs antigos ficam em `docs/archive/` e não devem ser tratados como descrição da arquitetura corrente.
