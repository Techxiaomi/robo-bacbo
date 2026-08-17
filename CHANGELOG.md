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
- SEC-004: `GET /api/robos` deixa de expor `telegram_token`; o navegador recebe somente `telegram_configurado`.
- Edições e toggles preservam o token armazenado quando o campo chega vazio/ausente, evitando retransmitir o segredo ao frontend.
- SEC-003A: backend Node passa a usar `NODE_HOST=127.0.0.1` por padrão, remove CORS aberto e rejeita origem HTTP/Socket.IO diferente do host do próprio painel.
- Exposição deliberada fora de loopback gera aviso; autenticação administrativa permanece pendente como SEC-003B.
- OBS-001A: falhas inesperadas em migrations e CRUDs críticos deixam de ser silenciosas; erros passam a ser registrados com contexto sem expor detalhes técnicos nas respostas HTTP.
- Falhas em exclusão de estratégia, fechamento `LOSS`, persistência de camuflagem, rollback e processamento pós-ACK de `/receber-sinal` também passam a ficar visíveis nos logs.
- OBS-001B: executor Python passa a validar o HTTP do resultado enviado ao Node e registrar falhas de entrega/processamento, Auto-Login, WebSocket e loop principal; eventos repetitivos usam log limitado no tempo.
- Frames não-JSON e interações opcionais de UI continuam tolerados para evitar ruído e preservar o comportamento operacional.
- OBS-001C: inicialização do Node passa a ser fail-closed; APIs dependentes do backend retornam 503 e Socket.IO rejeita conexões até banco/schema/memória estarem prontos.
- Erros inesperados de migration/carga inicial agora sobem até `iniciarApp()`, que fecha Socket.IO, HTTP e pool MySQL em vez de manter processo parcialmente inicializado.
- OBS-001D: falhas ao persistir `giros_recentes`, fechar ordem `WIN/TIE` e gravar `META_ATINGIDA` deixam de ser silenciosas e passam a registrar contexto técnico.
- OBS-001E: `uncaughtException`/`unhandledRejection` deixam de ser suprimidos e passam a encerrar o Node após log; promises Telegram em background recebem `catch` contextual próprio.
- OBS-003A: `npm test` passa a executar testes reais com `node:test` sobre lógica pura do backend, sem MySQL, rede ou inicialização do servidor.
- A suíte inicial cobre stake rounding, níveis de Gale, TIEs legados, filtros de robô, mensagens Telegram e janelas de horário inclusive overnight.
- OBS-003B: adicionada suíte Python `unittest` que extrai funções de `robo.py` via AST sem importar/inicializar Flask ou Playwright.
- Os testes cobrem parsing de saldo e transformação de rodada resolvida em payload Node, incluindo TIE, interrupção >60s e falha HTTP simulada.
- OBS-003C: GitHub Actions passa a executar automaticamente as suítes Node/Python e checagens de sintaxe em PRs e pushes para `main`.
- O CI usa permissões `contents: read`, sem secrets, sem instalação de dependências e sem inicializar MySQL, Flask, Playwright ou rede do projeto.

### Fixed
- BUG-001: o Node agora aguarda e valida a confirmação HTTP do executor antes de contabilizar uma entrada direta ou criar a nova ordem `PENDENTE` de Gale.
- Entradas diretas atualizam `entradas_feitas` e auditoria em uma transação local somente após o aceite do executor.
- Falhas de conexão, timeout, HTTP não-2xx e confirmações divergentes deixam de ser silenciosas e não são contabilizadas como novas ordens enviadas.
- BUG-001B: cada ordem Node→Python recebe `order_id` UUID; falhas ambíguas são repetidas uma vez com o mesmo ID e o executor responde idempotentemente sem duplicar a fila.
- O executor rejeita reutilização do mesmo `order_id` com payload diferente (409), mantém uma janela em memória dos últimos 5000 IDs e a auditoria passa a registrar `executor_order_id`.
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
- BUG-006B: Stop Win/Stop Loss passam a usar `saldo_inicial` + saldo global fresco antes de novas sequências; saldo desatualizado bloqueia nova exposição e limite atingido desliga o Auto-Trader até reativação manual.
- A validação operacional do BUG-008 confirmou seletor real no Chromium headless e heartbeat de saldo; Gales já iniciados continuam até o desfecho e trailing permanece fora deste patch.
- BUG-006C: Auto-Trader ganha Stop Reds próprio, contado somente quando uma sequência realmente executada é finalizada; GREEN/TIE zera o streak e RED final incrementa uma única vez, independentemente dos Gales intermediários.
- Ao atingir o limite, o Auto-Trader pode pausar por N minutos e rearmar automaticamente ou desligar até reativação manual. O `stop_reds_seguidos` de Robôs/Canais permanece independente e inalterado.
- BUG-006D: Trailing Stop passa a usar o maior lucro real registrado no ciclo e um recuo configurável em R$; ao atingir o recuo a partir do pico, o Auto-Trader desliga antes de abrir uma nova sequência.
- O pico é persistido no MySQL, é zerado em reativação manual ou mudança da configuração de trailing e `trailing_stop=true` sem `trailing_recuo>0` permanece desarmado para compatibilidade com configurações antigas.
- BUG-008A: o executor pode sincronizar o saldo real da página por `CASINO_BALANCE_SELECTOR`, com parsing monetário, polling controlado e mensagens autenticadas ao Node.
- O Node rejeita saldos inválidos e `saldoGlobalCorretora` passa a distinguir saldo desconhecido (`null`) de saldo real zero; nenhum saldo é inferido quando o seletor não está configurado.
- BUG-007A: restauradas as funções frontend já referenciadas pelo módulo de Robôs para CRUD, destinatários, sintonização manual, edição, toggle, cards e filtros.
- O patch preserva configurações desconhecidas no `config_json` e não envia Telegram nem altera o fluxo backend de sinais; roteamento real e histórico por robô ficam para BUG-007B.
- BUG-007B: robôs com canal web ativo passam a ser selecionados na abertura do sinal por origem/avulso/exceção (ou `robo_dono_id` em padrão dinâmico), respeitando `min_assertividade`, e ficam congelados em `robosInscritos` até o fechamento.
- `alerta_painel` passa a emitir ENTRADA/GALE/GREEN/RED para os robôs realmente inscritos e `historico_disparos_robos` recebe um registro por robô no fechamento; Telegram-only permanece fora da contagem até BUG-007C.
- BUG-007C: implementado envio Telegram real por `sendMessage`, com destinos deduplicados, timeout, validação de `HTTP ok` + `ok=true` e mensagens configuráveis por cabeçalho/rodapé/flags do robô.
- Telegram-only só entra em `robosInscritos`/histórico após confirmação da ENTRADA; Web+Telegram continua gerando um único histórico por robô, e GALE/fechamento usam somente destinos confirmados na entrada.
- BUG-007D: Drawdown Control passa a aplicar `CONSERVADOR` (pausa no primeiro RED) e `DINAMICO` (X REDs em Y minutos), persistindo `standby_ate`/janela de REDs para sobreviver a restart e excluindo robôs em proteção da seleção de sinais.
- `greens_consecutivos` passa a ser atualizado por resultado efetivamente recebido pelo robô; aviso Telegram de proteção é encadeado após o RED.
- BUG-007E: `stop_reds_seguidos` dos Robôs/Canais passa a contar somente sinais efetivamente recebidos pelo robô; GREEN/TIE zera o streak e RED final incrementa uma vez.
- Ao atingir o limite, o Robô/Canal é desligado (`ativo=false`) antes do Drawdown Control daquele resultado e exige reativação manual. O controle permanece independente do Stop Reds financeiro do Auto-Trader.
- BUG-009: `prepararBancoDeDados()` passa a criar também `origens` e `estrategias` antes das migrations, tornando o bootstrap compatível com banco vazio sem depender de dump legado.
- O schema inicial contém somente os campos comprovadamente usados pelo CRUD, estatísticas legadas e metadados dinâmicos atuais; bancos existentes continuam preservados por `CREATE TABLE IF NOT EXISTS`.
- BUG-008B: criação ativa e reativação de Auto-Trader passam a capturar `saldo_inicial` exclusivamente do saldo global recente no backend; o frontend deixa de enviar baseline financeiro.
- Reativação inicia novo ciclo em `STANDBY`, zera `entradas_feitas`/`pulos_restantes` e rejeita ativação com HTTP 409 quando o saldo está ausente ou além da janela de freshness configurável. Edição de trader já ativo continua preservando os saldos.
