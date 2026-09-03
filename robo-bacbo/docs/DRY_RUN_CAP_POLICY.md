# Dry-run cap policy

Os limites técnicos globais e por bridge existem como envelope de proteção para execução financeira real. Durante `financial_dry_run=true`, eles não devem impedir a homologação do fluxo de decisão e roteamento, porque o dry-run termina antes de qualquer dispatch financeiro.

Regras:

- `financial_dry_run=true`: caps são observabilidade; planos podem atravessar o pipeline até o terminal dry-run, sempre com `dispatch=0` e sem confirmação financeira.
- `financial_dry_run=false`: caps permanecem barreiras fail-closed.
- Esta política não habilita apostas reais nem altera a trava que força o dry-run no ambiente de homologação.
