# Bac Bo Automation — Baseline Segura

Snapshot inicial preparado a partir dos dois projetos fornecidos, preservando a lógica existente e removendo credenciais do código versionável.

## Componentes

- `robo-bacbo/`: backend Node.js + painel web.
- `robo-sync-pilot/`: executor/capturador Python com Flask + Playwright.
- `docs/`: arquitetura, estado atual, riscos e regras de evolução.
- `scripts/check_secrets.py`: verificação preventiva antes de commits.

## Primeira configuração local

1. Copie `.env.example` para `.env` na raiz do projeto.
2. Preencha no `.env` as credenciais e URLs reais da sua instalação.
3. Gere um valor longo e aleatório para `INTERNAL_API_TOKEN` e mantenha o mesmo `.env` acessível aos processos Node.js e Python.
4. Nunca envie `.env` ou `robo-sync-pilot/sessao_salva.json` ao Git.

O backend e o executor recusam iniciar quando `INTERNAL_API_TOKEN` está vazio. As rotas internas `/receber-sinal` e `/apostar` exigem esse segredo no header `X-Internal-Token`.

### Backend Node.js

```bash
cd robo-bacbo
npm install
npm start
```

### Executor Python

No Windows:

```bat
cd robo-sync-pilot
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
playwright install chromium
python gerar_sessao.py
python robo.py
```

`gerar_sessao.py` só precisa ser usado quando for necessário criar/renovar o arquivo local `sessao_salva.json`.

## Antes de qualquer commit

```bash
python scripts/check_secrets.py
```

A baseline atual **não pretende corrigir os bugs funcionais já existentes**. Ela apenas torna o snapshot versionável com segurança e documenta o que foi encontrado. Consulte `docs/KNOWN_ISSUES.md` antes de alterar comportamento.
