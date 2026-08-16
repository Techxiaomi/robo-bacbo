# Baseline de Segurança para Versionamento

## Segredos retirados do código

A baseline usa variáveis de ambiente para:

- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`
- `CASINO_USER`
- `CASINO_PASSWORD`
- `CASINO_HOME_URL`
- `CASINO_GAME_URL`
- `SESSION_STATE_FILE`
- `NODE_PORT`
- `NODE_WEBHOOK_URL`
- `EXECUTOR_URL`

Nenhum valor real dessas credenciais deve aparecer no repositório.

## Arquivos que nunca devem ser versionados

- `.env`
- `sessao_salva.json`
- arquivos de cookies/storage state;
- certificados e chaves privadas;
- dumps de banco com credenciais/tokens;
- `node_modules/`;
- `venv/`.

## Sessão Playwright

`storage_state` pode conter cookies e dados de localStorage capazes de representar uma sessão autenticada. Deve ser tratado como senha/token. A baseline contém somente `sessao_salva.example.json` vazio.

## Histórico Git

Segredo removido em commit posterior continua presente no histórico anterior. Por isso o primeiro commit do novo repositório deve ser feito somente a partir desta baseline sanitizada, nunca a partir dos ZIPs originais.

## Checklist antes de publicar

1. Executar `python scripts/check_secrets.py`.
2. Confirmar que `.env` não aparece em `git status`.
3. Confirmar que `sessao_salva.json` não aparece em `git status`.
4. Revisar `git diff --cached` antes do commit.
5. Nunca usar `git add -f` em arquivos ignorados sem motivo documentado.
