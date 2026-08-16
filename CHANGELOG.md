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
- BUG-002: Auto-Traders ativos em `STANDBY` passam para `OPERANDO` ao primeiro resultado de rodada válido e autenticado recebido da mesa.
- A transição é persistida no MySQL antes de atualizar o estado em memória; traders desligados ou em outros estados não são alterados.
- BUG-003: editar configurações ou usar o toggle rápido do Auto-Trader não sobrescreve mais `saldo_inicial` nem `saldo_atual`.
- Criação de um novo Auto-Trader continua inicializando os dois saldos; recalibração futura deverá ser uma ação explícita.
- BUG-004: `interrupcao_fluxo` agora inicia uma nova `idSessaoContinua` antes de registrar o primeiro giro após uma pausa superior a 60 segundos.
- A separação de sessão reaproveita a checagem `mesmaSessao` já existente e não altera ordens pendentes, stake, Gale ou frontend.
- BUG-005A: resultados finalizados de estratégias agora são persistidos em `historico_resultados` como `GREEN`, `TIE` ou `RED`, incluindo nível, multiplicador de empate e horário da rodada.
- `historico_disparos_robos` permanece fora deste patch até que o fluxo de robôs consiga identificar de forma confiável quais robôs efetivamente receberam cada sinal.
- BUG-006A: `hora_inicio`/`hora_fim` agora bloqueiam a abertura de novas sequências do Auto-Trader fora da janela configurada, incluindo janelas que atravessam a meia-noite.
- Gales de sequências já iniciadas continuam até o desfecho; Stop Win, Stop Loss e trailing ficam pendentes até existir saldo sincronizado e regra explícita de trailing.
- BUG-008A: o executor pode sincronizar o saldo real da página por `CASINO_BALANCE_SELECTOR`, com parsing monetário, polling controlado e mensagens autenticadas ao Node.
- O Node rejeita saldos inválidos e `saldoGlobalCorretora` passa a distinguir saldo desconhecido (`null`) de saldo real zero; nenhum saldo é inferido quando o seletor não está configurado.
- BUG-007A: restauradas as funções frontend já referenciadas pelo módulo de Robôs para CRUD, destinatários, sintonização manual, edição, toggle, cards e filtros.
- O patch preserva configurações desconhecidas no `config_json` e não envia Telegram nem altera o fluxo backend de sinais; roteamento real e histórico por robô ficam para BUG-007B.
- BUG-007B: robôs com canal web ativo passam a ser selecionados na abertura do sinal por origem/avulso/exceção (ou `robo_dono_id` em padrão dinâmico), respeitando `min_assertividade`, e ficam congelados em `robosInscritos` até o fechamento.
- `alerta_painel` passa a emitir ENTRADA/GALE/GREEN/RED para os robôs realmente inscritos e `historico_disparos_robos` recebe um registro por robô no fechamento; Telegram-only permanece fora da contagem até BUG-007C.
- BUG-007C: implementado envio Telegram real por `sendMessage`, com destinos deduplicados, timeout, validação de `HTTP ok` + `ok=true` e mensagens configuráveis por cabeçalho/rodapé/flags do robô.
- Telegram-only só entra em `robosInscritos`/histórico após confirmação da ENTRADA; Web+Telegram continua gerando um único histórico por robô, e GALE/fechamento usam somente destinos confirmados na entrada.
