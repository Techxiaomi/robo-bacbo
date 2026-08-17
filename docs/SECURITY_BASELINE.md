# Baseline de Segurança Atual

Atualizado em 2026-08-17. Este documento resume as regras de segurança do `main` atual; `.env.example` é a referência para as variáveis configuráveis disponíveis.

## Segredos e configuração local

Credenciais e segredos reais devem existir somente no ambiente local/operacional. Entre os valores sensíveis estão:

- credenciais MySQL (`DB_USER`, `DB_PASSWORD` e dados de conexão);
- `CASINO_USER` e `CASINO_PASSWORD`;
- `INTERNAL_API_TOKEN`;
- `ADMIN_USERNAME` e `ADMIN_PASSWORD`;
- tokens Telegram armazenados no banco;
- cookies/storage state da sessão Playwright.

Nenhum valor real deve ser gravado diretamente no código, documentação, testes ou exemplos versionados.

## Arquivos que não devem ser versionados

- `.env`;
- `robo-sync-pilot/sessao_salva.json` e outros storage states/cookies;
- conteúdo de `robo-sync-pilot/runtime/`;
- logs e snapshots runtime locais;
- certificados/chaves privadas;
- dumps de banco contendo credenciais, sessões ou tokens;
- `node_modules/`;
- `venv/` e ambientes virtuais equivalentes.

O `.gitignore` deve continuar cobrindo os artefatos operacionais conhecidos.

## Comunicação interna Node ↔ Python

As rotas internas usam o mesmo segredo compartilhado no header `X-Internal-Token`:

- Node `POST /receber-sinal`: resultados e sincronização de saldo enviados pelo Python;
- Python `POST /apostar`: ordens enviadas pelo Node;
- Node `POST /executor-status`: callback do resultado local da tentativa DOM.

`INTERNAL_API_TOKEN` vazio faz os processos falharem fechado na inicialização.

O Flask usa `EXECUTOR_HOST=127.0.0.1` por padrão. O Node usa `NODE_HOST=127.0.0.1` por padrão e valida `Host`/`Origin` no HTTP e no handshake Socket.IO.

## Autenticação administrativa

O painel e as APIs administrativas suportam sessão opaca em memória:

- cookie `HttpOnly`;
- `SameSite=Strict`;
- TTL configurável;
- `Secure` automático fora de loopback, salvo configuração explícita;
- comparação de credenciais com operação timing-safe;
- logout invalida a sessão;
- restart do Node invalida as sessões em memória.

Em loopback, deixar `ADMIN_USERNAME` e `ADMIN_PASSWORD` vazios mantém o modo local sem login. Fora de loopback, os dois campos são obrigatórios; configuração incompleta impede o backend de iniciar.

`/receber-sinal` e `/executor-status` não dependem da sessão administrativa: usam somente `INTERNAL_API_TOKEN`. O executor Flask `/apostar` usa o mesmo token interno.

## Sessão Playwright

O `storage_state` pode conter cookies e localStorage capazes de representar uma sessão autenticada. Deve ser tratado como senha/token.

`robo-sync-pilot/gerar_sessao.py` grava o estado somente para uso local. O repositório contém apenas o exemplo vazio `sessao_salva.example.json`.

## Idempotência e journal do executor

O executor persiste localmente uma janela dos `order_id` já aceitos antes de colocá-los na fila. O journal contém somente os dados mínimos da ordem (`order_id`, alvo e valor), sem credenciais.

- gravação usa arquivo temporário + `fsync` + substituição atômica;
- journal ilegível/corrompido bloqueia o startup;
- falha de persistência impede uma nova ordem de ser aceita;
- IDs persistidos não são reenfileirados automaticamente após restart, priorizando prevenção de duplicidade.

O journal melhora a idempotência local, mas não fornece garantia transacional sobre o efeito financeiro externo.

## Auditoria antes do efeito externo

O Node grava uma intenção `PREPARANDO` em `auditoria_ordens` com `order_id` antes de enviar uma nova exposição ao executor. Se a intenção não puder ser persistida, o POST financeiro não é feito.

O lifecycle posterior distingue falha de envio, falha de execução local, expiração e estado ambíguo. Essas informações não devem ser interpretadas como prova de exactly-once da plataforma externa.

## Logging e métricas

O logger estruturado do Node aplica redaction a chaves sensíveis e aos segredos conhecidos carregados do ambiente. Falha do sink de arquivo não derruba o backend.

As métricas locais não devem persistir payloads, URLs com tokens ou valores financeiros do sinal; as métricas operacionais usam rotas normalizadas e categorias agregadas de saída.

Arquivos em `logs/` são artefatos operacionais locais e não devem ser commitados.

## Token Telegram

O backend não devolve `telegram_token` no `GET /api/robos`. Edição/toggle preserva o segredo armazenado quando o campo chega vazio/ausente, evitando retransmitir o token ao navegador.

## Histórico Git e rotação operacional

Remover um segredo de um commit posterior não o remove do histórico anterior. Qualquer credencial real que tenha sido compartilhada antes da externalização para `.env` deve ser rotacionada no serviço correspondente.

Essa rotação depende das contas/serviços reais e não deve ser automatizada pelo repositório.

## Checklist antes de publicar

1. Executar `python scripts/check_secrets.py`.
2. Confirmar que `.env` e `sessao_salva.json` não aparecem em `git status`.
3. Confirmar que `runtime/`, logs ou dumps locais não estão staged.
4. Revisar `git diff --cached` antes do commit.
5. Não usar `git add -f` em arquivo ignorado sem motivo documentado.
6. Não publicar tokens, senhas, cookies ou URLs autenticadas em issues, PRs, logs ou respostas de suporte.

## Regra de manutenção

Mudança de protocolo entre Node e Python deve ser feita nos dois lados no mesmo patch e validada por testes. Alterações de segurança, arquitetura e lógica financeira não devem ser misturadas sem necessidade.
