# Regras de Desenvolvimento do Projeto

Estas regras valem para qualquer pessoa ou IA que altere este repositório.

1. Não reescrever arquivos inteiros quando uma alteração localizada for suficiente.
2. Não renomear IDs/classes HTML, endpoints, campos de payload, nomes de tabelas ou colunas sem mapear todos os consumidores.
3. Não alterar simultaneamente segurança, arquitetura e lógica de aposta no mesmo commit.
4. Toda mudança funcional deve declarar: problema, arquivos afetados, comportamento anterior, comportamento novo e risco de regressão.
5. Mudanças no protocolo Node ↔ Python devem ser implementadas e testadas nos dois lados no mesmo conjunto de alterações.
6. Não remover código aparentemente redundante antes de provar que ele não participa do fluxo atual.
7. Não introduzir dependências externas sem justificar necessidade, versão e impacto operacional.
8. Não gravar tokens, senhas, cookies, sessões, credenciais SQL ou chaves diretamente no código.
9. `.env`, `sessao_salva.json`, `node_modules` e `venv` nunca podem ser commitados.
10. Não expor `telegram_token` ou outros segredos em respostas de API ao navegador.
11. Toda ordem de aposta deve, futuramente, possuir confirmação inequívoca de aceitação/execução; não marcar uma ordem como enviada apenas porque a tentativa de HTTP foi iniciada.
12. Exceções não devem ser silenciosamente descartadas em código crítico; erros de execução e persistência precisam ser observáveis.
13. Antes de refatoração estrutural do `index.html`, criar uma baseline funcional e testes mínimos dos fluxos principais.
14. Cada correção deve ser pequena o suficiente para permitir rollback isolado.
15. A documentação em `docs/` deve ser atualizada quando o estado arquitetural mudar.

## Fluxo obrigatório para IA

Antes de gerar código, a IA deve responder internamente às seguintes perguntas:

- Qual é a causa provável?
- Qual é a menor alteração capaz de resolver o problema?
- Quais arquivos e funções são afetados?
- Há contratos implícitos entre frontend, Node, Python ou MySQL?
- Como confirmar que a correção não quebrou o restante?

Não criar funcionalidades que existam apenas na interface sem implementar e documentar o backend correspondente.
