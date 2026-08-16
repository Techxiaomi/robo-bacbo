# Estado Atual do Snapshot

Classificação baseada exclusivamente nos arquivos recebidos. “Não localizado” significa que a implementação não aparece neste snapshot, não que nunca tenha existido em versões anteriores.

## Implementado / conectado no snapshot

- painel web único em `public/index.html`;
- API Express e Socket.IO;
- conexão MySQL;
- CRUD de estratégias e origens, assumindo tabelas existentes;
- CRUD de robôs/canais e destinatários;
- CRUD de auto-traders;
- simulador de banca baseado em histórico;
- captura de resultado da mesa pelo Playwright/WebSocket;
- envio do resultado Python → Node;
- detecção sequencial de padrões;
- entrada direta e gales;
- arredondamento de valores em múltiplos de R$ 5;
- envio de ordem Node → Python;
- fila de execução no Python;
- clique de fichas/alvos na mesa;
- auditoria parcial das ordens do auto-trader;
- camuflagem por “pulos” e limite de entradas no backend.

## Parcialmente implementado ou inconsistente

- estado `STANDBY`/`OPERANDO` do auto-trader;
- Stop Win;
- Stop Loss;
- Trailing Stop;
- janela de horário do auto-trader;
- persistência completa de resultados estatísticos;
- uso de `interrupcao_fluxo` para separar sessões lógicas;
- histórico de disparos dos robôs;
- sistema de Telegram;
- auto tuning / cooldown / filtros avançados dos robôs.

## Dependências implícitas externas ao snapshot

- schema e dados existentes das tabelas `estrategias` e `origens`;
- credenciais MySQL;
- credenciais do site;
- `sessao_salva.json` local;
- disponibilidade e estrutura DOM/WebSocket do site de destino;
- navegador Chromium instalado pelo Playwright.

## Pontos de manutenção

- `public/index.html`: aproximadamente 2 mil linhas com CSS e JavaScript inline;
- `bot2_coletor.js`: aproximadamente 800 linhas e múltiplas responsabilidades;
- `robo.py`: captura, login, API e execução no mesmo processo.

A modularização é desejável, mas deve ocorrer somente após testes mínimos e correção dos problemas críticos listados em `KNOWN_ISSUES.md`.
