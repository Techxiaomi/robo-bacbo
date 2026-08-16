# Changelog

## Baseline 0.1.0 — preparação para Git

- consolidado o snapshot dos dois componentes em um único projeto;
- removidas credenciais hardcoded do código versionável;
- adicionada configuração local via `.env` sem dependências novas;
- excluído `sessao_salva.json` da baseline;
- adicionado exemplo vazio de storage state;
- adicionados `.gitignore`, `requirements.txt` e script `npm start`;
- adicionada documentação de arquitetura, estado atual, segurança e problemas conhecidos;
- adicionada verificação preventiva de segredos.

Nenhuma correção de lógica de apostas foi aplicada nesta versão.

## Unreleased

### Security
- SEC-002: autenticação por segredo compartilhado nas rotas internas `/apostar` e `/receber-sinal`.
- Executor Flask restrito a `127.0.0.1` por padrão e configurável por ambiente.
- Validação mínima do payload antes de enfileirar uma ordem de aposta.

### Fixed
- BUG-001: o Node agora aguarda e valida a confirmação HTTP do executor antes de contabilizar uma entrada direta ou criar a nova ordem `PENDENTE` de Gale.
- Entradas diretas atualizam `entradas_feitas` e auditoria em uma transação local somente após o aceite do executor.
- Falhas de conexão, timeout, HTTP não-2xx e confirmações divergentes deixam de ser silenciosas e não são contabilizadas como novas ordens enviadas.
