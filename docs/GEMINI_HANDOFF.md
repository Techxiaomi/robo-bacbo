# Contexto Técnico para Continuidade com Outra IA

Use este arquivo como contexto inicial ao solicitar alterações a Gemini, ChatGPT, Copilot ou outro agente.

## Sistema

O projeto é um sistema único composto por:

- Node.js/Express/MySQL/Socket.IO (`robo-bacbo`): painel, estratégias, estado e motor de decisão;
- Python/Flask/Playwright (`robo-sync-pilot`): sessão, captura de resultados e execução das ordens na interface do site.

O Python envia resultados para `POST /receber-sinal` no Node. O Node envia ordens para `POST /apostar` no Python.

## Regra principal

**Não reescreva o projeto nem altere arquitetura por conveniência.** Primeiro leia `PROJECT_RULES.md`, `docs/ARCHITECTURE.md`, `docs/CURRENT_STATE.md` e `docs/KNOWN_ISSUES.md`.

## Estado da migração

- credenciais já foram externalizadas para `.env`;
- sessão autenticada está fora do Git;
- dependências geradas (`node_modules` e `venv`) estão fora do Git;
- lógica funcional foi intencionalmente preservada nesta baseline;
- bugs conhecidos ainda não foram corrigidos.

## Ao receber uma tarefa

A resposta deve informar, antes do patch:

1. causa provável;
2. arquivos/funções afetados;
3. alteração mínima proposta;
4. risco de regressão;
5. como testar.

Não misture correções não solicitadas no mesmo patch.
