# Bac Bo Automation

Projeto integrado de automação/monitoramento da mesa Bac Bo, composto por backend Node.js e executor/coletor Python com Playwright.

O `main` não representa mais apenas o snapshot inicial: ele incorpora as correções funcionais, de segurança, observabilidade e cobertura automatizada documentadas em `CHANGELOG.md`, `docs/CURRENT_STATE.md` e `docs/KNOWN_ISSUES.md`.

## Componentes

- `robo-bacbo/`: backend Node.js / Express / MySQL / Socket.IO, painel, estratégias, Robôs/Canais, Auto-Trader, auditoria e telemetria local.
- `robo-sync-pilot/`: Flask + Playwright, sessão da plataforma, captura das rodadas, sincronização de saldo e execução das ordens.
- `docs/`: arquitetura, estado atual, riscos, segurança e regras de evolução.
- `scripts/check_secrets.py`: verificação preventiva de segredos antes de commits.

## Fluxo principal

```text
Mesa / Playwright
   |  resultado + coletor_sessao/coletor_seq
   v
POST /receber-sinal
   |
   v
Node + MySQL
   |  intenção PREPARANDO + order_id
   v
POST /apostar
   |
   v
Executor Playwright
   |  callback EXECUTADA/FALHOU/EXPIRADA/AMBIGUA
   v
POST /executor-status
   |
   v
Node / auditoria
```

O processamento de rodadas no Node preserva ACK rápido para o coletor, mas serializa o trabalho pós-ACK em FIFO. O coletor também deduplica frames `Resolved` repetidos antes de consumir `coletor_seq`.

## Primeira configuração local

1. Copie `.env.example` para `.env` na raiz do projeto.
2. Preencha somente na sua máquina as credenciais, URLs e seletores reais.
3. Gere um `INTERNAL_API_TOKEN` longo e aleatório e use o mesmo valor nos dois processos.
4. Nunca versione `.env`, `robo-sync-pilot/sessao_salva.json` ou outros arquivos de sessão/credenciais.

Por padrão, Node e Flask ficam em loopback. As rotas internas `/receber-sinal`, `/apostar` e `/executor-status` exigem `INTERNAL_API_TOKEN`. Fora do loopback, o painel/API administrativa exige `ADMIN_USERNAME` e `ADMIN_PASSWORD` e o backend falha fechado se a configuração estiver incompleta.

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

`gerar_sessao.py` só precisa ser executado quando for necessário criar ou renovar o `storage_state` local.

## Validação

Antes de qualquer commit:

```bash
python scripts/check_secrets.py
```

Testes locais principais:

```bash
cd robo-bacbo
npm test
```

```bash
cd robo-sync-pilot
python tests/test_pure_logic.py
```

O GitHub Actions também executa gates de integração com MySQL descartável, autenticação HTTP/Socket.IO, restart/idempotência do executor, Chromium em DOM controlado e E2E controlado coletor → Node → executor → auditoria.

## Documentação de referência

- `docs/CURRENT_STATE.md`: fonte principal para o estado funcional atual.
- `docs/KNOWN_ISSUES.md`: riscos residuais e itens já mitigados.
- `docs/ARCHITECTURE.md`: contratos e fluxo arquitetural atual.
- `docs/SECURITY_BASELINE.md`: regras de segurança e versionamento.
- `PROJECT_RULES.md`: regras obrigatórias para novas alterações.

Mudanças devem permanecer pequenas, isoladas, testáveis e compatíveis com os contratos existentes entre frontend, Node, Python e MySQL.
