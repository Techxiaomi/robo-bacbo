# Auditoria Arquitetural: Sistema de Trava e Segurança Financeira

> **Status:** Consolidado e Validado (Pós-Refatoração Clean Code)
> **Escopo:** system_config_service.js, Fluxo de Runtime Node e Camadas de Fail-Closed.

---

## 1. Os 4 Invariantes Inegociáveis

1. **INVARIANTE 1:** automatic_financial_dispatch === false
2. **INVARIANTE 2:** effective.financial_dry_run === true
3. **INVARIANTE 3:** requested.financial_dry_run = false equivale a ARMED_REVIEW, nunca a despacho autônomo.
4. **INVARIANTE 4:** Falhas de dados ou indisponibilidade de banco convergem obrigatoriamente para safe defaults com fail-closed.
