# Problemas e Riscos Conhecidos

Atualizado em 2026-08-19. Este arquivo descreve o estado atual do `main` e separa riscos ainda abertos de itens já mitigados.

## Pendências reais

### SEC-001 — Rotação operacional de credenciais antigas

Status: **mitigado no versionamento; ação operacional ainda pendente**.

Credenciais SQL, login e segredos foram externalizados para `.env`, arquivos de sessão ficaram fora do Git e o `.gitignore` cobre os artefatos sensíveis conhecidos.

Risco residual: qualquer credencial que tenha sido compartilhada antes dessa externalização deve ser rotacionada no serviço correspondente. Isso depende do ambiente/contas reais e não deve ser automatizado pelo repositório.

### BUG-014 — Lifecycle da ordem entre intenção, aceite e execução

Status: **mitigado pelos patches BUG-014A/014B/014C, sujeito à ambiguidade externa residual descrita abaixo**.

O BUG-014A passou a persistir `PREPARANDO` antes de qualquer POST externo. O BUG-014B acrescenta um lifecycle explícito entre Node e executor: ordem nova só é aceita quando o Playwright está pronto; cada aceite recebe timestamp e TTL; e o Python devolve o resultado da tentativa por callback autenticado em `/executor-status`.

O Node cria o waiter do `order_id` antes do POST, portanto um callback antecipado não se perde. `enviarOrdemAoExecutor()` só resolve com `EXECUTADA`. Uma tentativa sem clique de alvo retorna `FALHOU` e vira `FALHA_EXECUCAO`; ordem que vence na fila retorna `EXPIRADA` e vira `ORDEM_EXPIRADA`; falha após algum clique de alvo retorna `AMBIGUA`; ausência de callback continua `ENVIO_AMBIGUO`. Recusa `503` com `aceita=false` significa que o executor não persistiu/enfileirou um ID novo e é tratada como `FALHA_ENVIO` definitiva.

`EXECUTADA` não é uma garantia de exactly-once ou de aceite financeiro pela plataforma: significa somente que a automação local conseguiu completar todos os cliques planejados sem erro observável. Se o processo morrer exatamente durante a interação, a ambiguidade externa continua possível sem uma API transacional/idempotente do destino.

O BUG-014C mantém o ACK rápido de `/receber-sinal`, mas separa admissão de sequência e processamento: `coletor_sessao/coletor_seq` são reservados sincronamente antes do primeiro `await`, e toda mutação pós-ACK entra em uma fila FIFO. Assim uma rodada recebida durante MySQL/callback da anterior aguarda sua vez e não pode fechar/criar sinais sobre estado intermediário.

### BUG-015 — Frames `Resolved` repetidos podiam virar rodadas distintas

Status: **mitigado**.

O callback WebSocket chamava `processar_resultado()` para todo `bacbo.playerState` em estágio `Resolved`; não havia identidade/fingerprint local antes de incrementar `coletor_seq`. Uma repetição imediata do mesmo estado poderia, portanto, ser enviada ao Node como se fosse outra rodada válida.

O coletor agora deduplica antes de consumir sequência. Quando o payload traz `roundId`, `round_id`, `roundID`, `roundUid` ou `round_uid`, a identidade explícita prevalece. Sem identificador, usa resultado + dados normalizados apenas dentro de `RESULT_DEDUP_WINDOW_SECONDS` (3 s por padrão), permitindo que uma rodada futura legitimamente igual seja processada após a janela. Falha de POST continua consumindo a sequência da primeira observação, preservando a detecção de buraco do BUG-011.

### BUG-001R — Restart do executor e exactly-once do efeito externo

Status: **deduplicação entre restarts mitigada; ambiguidade do efeito externo ainda residual**.

O fluxo Node → Python usa `order_id` UUID. O executor agora mantém um journal JSON local dos últimos IDs aceitos, grava o estado de forma atômica antes de enfileirar uma nova ordem e restaura esse registro no startup. Reenvio do mesmo `order_id` após restart continua sendo tratado como duplicata; reutilização com payload diferente continua retornando conflito.

Journal ilegível/corrompido faz o executor falhar fechado no startup. Falha ao persistir uma nova ordem faz `/apostar` retornar 503 sem colocá-la na fila. O CI possui um gate específico que recria o runtime Flask com o mesmo journal e comprova que a ordem persistida não é reenfileirada.

Risco residual: o journal protege contra replay duplicado, mas não consegue provar o estado do efeito externo se o processo morrer exatamente durante a interação Playwright com a mesa. Um restart após o aceite não reenfileira automaticamente um ID já persistido, priorizando evitar aposta duplicada. Garantia de exactly-once absoluto do clique exigiria confirmação/idempotência transacional oferecida pela própria plataforma externa, que não está disponível ao executor.

### OBS-001 — Observabilidade

Status: **amplamente mitigado pelos patches OBS-001A…OBS-001H; agregação externa e alertas ainda pendentes**.

Já implementado:

- migrations e CRUDs críticos deixam erros inesperados visíveis;
- persistências críticas e rollbacks registram contexto;
- startup Node é fail-closed;
- `uncaughtException` e `unhandledRejection` encerram o processo após log;
- promises Telegram em background possuem `catch` contextual;
- executor Python registra falhas de HTTP, WebSocket, Auto-Login e Playwright;
- logging Node estruturado em JSONL com rotação por tamanho;
- redaction de chaves sensíveis e segredos conhecidos do `.env`;
- falha do sink de arquivo não derruba o backend e o console original é preservado;
- snapshot local `backend.metrics.json` com uptime, memória, event-loop delay p50/p95/p99/max/média, contagem de logs, último warn/error e falhas dos sinks;
- snapshot local `backend.operations.json` com contagem/status/latência HTTP inbound por rota normalizada, chamadas outbound agregadas por `executor`/`telegram`/`other` e freshness do último resultado/saldo aceitos;
- rotas retiram query strings e normalizam IDs; outbound não persiste URLs, tokens ou payloads;
- persistência das métricas é atômica, configurável e usa timers `unref()` para não manter o processo aberto;
- amostras e rotas operacionais são limitadas em memória para evitar cardinalidade/crescimento ilimitado.

Risco residual: as métricas ainda são locais ao processo/host. Não há agregador externo, retenção histórica central nem alertas automáticos. Latência de consultas MySQL e tempos internos de operações de negócio pós-ACK também não são medidos separadamente; instrumentar esses pontos deve ser uma decisão específica caso exista necessidade operacional real, evitando envolver o pool/banco apenas por conveniência.

### OBS-003 — Cobertura automatizada

Status: **amplamente mitigado pelos patches OBS-003A…OBS-003H; o site real permanece dependência externa não determinística**.

Já implementado:

- suíte Node `node:test` de lógica pura;
- suíte Python `unittest` sem iniciar Flask/Playwright;
- GitHub Actions em PR/push para `main`;
- testes de contrato HTTP usando handlers reais de login/logout/middleware com `req`/`res`/`app` simulados;
- testes do logger estruturado/rotativo, das métricas runtime e das métricas operacionais HTTP;
- teste real `http.createServer + fetch` comprova que os hooks de telemetria não alteram a resposta e não persistem query sensível;
- integração real do `bot2_coletor.js` com Express + MySQL 8.4 descartável no CI;
- smoke HTTP real cobrindo bootstrap de banco/schema/memória, login/logout, sessão administrativa, validação de Origin, APIs e `/receber-sinal` com `INTERNAL_API_TOKEN`;
- handshake Socket.IO real cobrindo rejeição sem sessão, aceitação com cookie administrativo válido e nova rejeição do cookie invalidado após logout;
- verificação no MySQL de que as nove tabelas esperadas são criadas a partir de banco vazio e de que o smoke de infraestrutura não grava giro nem ordem financeira;
- Chromium real em DOM controlado local validando parsing/leitura de saldo no DOM principal e em iframe, além dos seletores de ficha/alvo usados por `executar_aposta_na_tela`;
- E2E controlado do ciclo coletor Python → Node → executor fake autenticado → MySQL: o executor comprova `PREPARANDO`, atrasa o callback enquanto a rodada seguinte já chega ao Node e valida que a fila FIFO impede ultrapassagem; depois a mesma auditoria fecha em `WIN` e `historico_resultados` registra `GREEN/DIRETO`;
- integração específica do executor recria o runtime Flask com o mesmo journal e valida deduplicação de `order_id` através de restart, conflito de payload e falha fechada com journal corrompido.

Risco residual externo:

- o DOM/WebSocket do site real, sessão autenticada, disponibilidade e regras da plataforma podem divergir do ambiente controlado do CI; esses fatores devem ser tratados como validação operacional, não como gate determinístico do repositório.

## Itens mitigados

### BUG-027 — Auto-Trader não reconhecia fontes dinâmicas selecionadas no painel

Status: **mitigado em código; validação operacional com ordem real pendente**.

O formulário persistia a seleção de um Robô IA como `[AUTO] Nome`, mas cada estratégia dinâmica era identificada no backend por `AUTO_PILOT_IA:<robo_dono_id>`. Como entrada, Gale e fechamento usavam igualdade literal entre esses valores, o Auto-Trader era silenciosamente ignorado antes de criar a intenção `PREPARANDO` ou chamar o executor Python. O estado `OPERANDO` comprovava apenas sincronização com a mesa, não a validade da associação da fonte.

O painel agora grava `AUTO_PILOT_IA:<id>` como identidade estável e continua exibindo `[AUTO] Nome` apenas como rótulo. O backend centraliza a autorização: estratégias IA são associadas pelo proprietário real, origens manuais continuam pelo nome e robôs diferentes permanecem isolados. Um fallback nominal preserva configurações legadas, mas novas configurações não dependem de nome nem são quebradas por renomeação do robô. O log registra quando um Auto-Trader é efetivamente autorizado para um sinal antes das demais barreiras operacionais.

### BUG-026 — Handover legítimo sem `roundId` ainda podia expirar sem evidência alternativa

Status: **mitigado em código; validação operacional da semântica da roadmap pendente**.

Na mesa real observada, a reconexão pode retornar `bacbo.playerState` com `stage`, mas sem uma identidade de rodada que possa ser comparada ao socket anterior. Esperar mais tempo não prova continuidade e, por isso, o timeout do BUG-025 ainda produzia uma interrupção mesmo quando a sequência visível na mesa estava correta.

Durante a quarentena, o coletor agora extrai somente marcadores semânticos P/B/T de contêineres de roadmap/histórico/resultados no DOM, inclusive dentro de iframes. A retomada sem `roundId` é aceita apenas quando os últimos `ROADMAP_RECONCILIATION_MIN_RESULTS` resultados da roadmap (6 por padrão) coincidem exatamente, em ordem direta ou inversa, com a cauda dos resultados que o Python já entregou com sucesso ao Node. Não há leitura de texto bruto, cookies ou payload de jogo; os diagnósticos registram somente quantidades de frames, raízes e trilhas.

Risco residual: o HTML/semântica visual da Evolution é externo e pode mudar. Se a roadmap não for reconhecida, se houver menos de seis resultados locais ou se a cauda divergir, o timeout permanece propositalmente fail-closed e a continuidade é invalidada. A validação em mesa real deve conferir os diagnósticos `frames`, `raízes` e `trilhas`; uma reconciliação bem-sucedida registra `ROADMAP_DOM_CAUSA_COMPATIVEL`.

### BUG-025 — Frame parcial na reconexão encerrava a quarentena antes da evidência estrutural

Status: **mitigado em código; validação operacional pendente**.

Alguns handovers da Evolution podem entregar inicialmente um `bacbo.playerState` sem `roundId`. O BUG-023 tratava esse primeiro frame como uma ambiguidade definitiva e criava nova sessão, embora ainda existisse tempo na janela de reconexão para receber o estado completo.

Durante a quarentena, frames sem `stage` ou sem identidade de rodada agora são apenas ignorados, mantendo o executor bloqueado. A decisão é tomada somente ao chegar um `playerState` completo, ou quando expira `WEBSOCKET_RECONNECT_GRACE_SECONDS`. A ausência de identidade até o timeout, uma troca incompatível ou outra evidência estrutural continuam invalidando em modo fail-closed.

### BUG-024 — Reload preventivo criava uma janela periódica sem observabilidade

Status: **mitigado em código; validação operacional prolongada pendente**.

O executor encerrava aproximadamente a cada duas horas o loop de uma sessão saudável e navegava novamente para a mesa. Antes do `page.goto()`, o contexto do WebSocket oficial era apagado, de modo que o fechamento provocado pela própria navegação não passava pela quarentena estrutural do BUG-023. Uma rodada resolvida durante essa troca poderia ficar invisível ao coletor.

O limite temporal foi removido. Enquanto página, WebSocket oficial e `playerState` permanecerem saudáveis, a sessão continua indefinidamente. A navegação e a recuperação permanecem orientadas por falhas observáveis: reconexão não confirmada, silêncio do `playerState`, ausência de WebSocket após navegação, necessidade de Auto-Login, timeout ou exceção do Playwright. O botão `Continuar` continua sendo tratado sem reiniciar a sessão.

### BUG-022 — Pausa legítima da mesa era tratada como interrupção

Status: **mitigado**.

O Python e o Node usavam, independentemente, mais de 60 segundos entre dois resultados como causa de interrupção. Troca de crupiê, ajuste ou substituição dos dados e outras pausas operacionais legítimas podiam, portanto, invalidar sinais pendentes mesmo com o ciclo de rodada e a comunicação íntegros.

O intervalo temporal agora é apenas diagnóstico: o Python registra aviso de pausa longa e preserva a continuidade. O Node não produz mais `INTERVALO_NODE`. A invalidação permanece fail-closed quando existe evidência estrutural: fechamento ou silêncio do WebSocket oficial, troca de `roundId` sem `Resolved`, resultado inválido, falha de POST, reinício do coletor, metadados ausentes ou salto de `coletor_seq`.

Risco residual: o watchdog de `playerState` continua deliberadamente fail-closed. Se a Evolution deixar de transmitir estados por tempo superior ao configurado, mesmo durante uma pausa operacional, o evento será tratado como perda de observabilidade e exigirá nova sessão. A validação no site real deve confirmar se a fonte mantém `playerState` durante trocas de crupiê e manutenção da mesa.

### BUG-023 — Handover transitório do WebSocket invalidava continuidade íntegra

Status: **mitigado em código; validação operacional no site real pendente**.

O fechamento do socket que havia entregue `bacbo.playerState` era tratado imediatamente como prova de perda de rodada. A Evolution pode, porém, substituir essa conexão durante uma sequência correta. Isso invalidava sinais em andamento e o mesmo evento ainda reaparecia no primeiro resultado por meio do lacre do Python.

O coletor agora bloqueia o executor e abre uma quarentena curta após o fechamento. A continuidade é preservada somente quando o novo `playerState` comprova a mesma `roundId`, ou uma nova rodada após o estado anterior ter sido observado como `Resolved`, dentro de `WEBSOCKET_RECONNECT_GRACE_SECONDS`. Reconexão tardia, identidade ausente, troca durante rodada não resolvida e demais ambiguidades continuam falhando fechado.

Interrupções confirmadas recebem um `interrupcao_id` derivado da sessão e geração do lacre. `/collector-health` e o resultado de retomada usam esse mesmo identificador, e o Node invalida pendências apenas uma vez. A comprovação determinística está coberta por testes; frequência e formato dos handovers reais da Evolution ainda devem ser acompanhados operacionalmente.

### BUG-021 — Rodada invisível ao Python podia concluir o sinal no resultado seguinte

Status: **mitigado em modo fail-closed, com dependência externa residual**.

O `coletor_seq` anterior provava somente a ordem dos resultados que o Python havia observado. Se uma rodada desaparecesse antes de `processar_resultado()`, o próximo resultado recebia uma sequência local contígua e podia concluir um sinal pendente. Além disso, interrupções temporais apenas separavam o histórico; a invalidação financeira ocorria somente em salto/restart/metadados ausentes.

O coletor agora elege como oficial apenas o WebSocket que efetivamente entrega `bacbo.playerState`, monitora o tempo desde o último estado e mantém um lacre de interrupção até o Node confirmar um resultado posterior. `playerState` silencioso, payload `Resolved` inválido e falha no POST rompem a continuidade; desde o BUG-023, um fechamento transitório passa primeiro pela quarentena estrutural de reconexão. A rota interna autenticada `/collector-health` antecipa interrupções confirmadas sem esperar a próxima rodada; o Node as coloca na mesma FIFO dos resultados e só confirma após limpar sinais pendentes e bloquear Auto-Traders com ordem `PENDENTE` como `DADOS_INCOMPLETOS`.

Qualquer interrupção estrutural reconhecida ou sinalizada pelo Python invalida pendências antes de processar o giro de retomada. O resultado de retomada abre uma nova `id_sessao`, podendo servir como nova âncora histórica, mas nunca como desfecho do sinal anterior. Desde o BUG-022, o simples intervalo entre resultados não é uma interrupção. `Resolved` também exige vencedor conhecido, quatro dados únicos no intervalo 1..6 e coerência matemática entre os dados e o vencedor. Quando o payload fornece `roundId`/variante, uma troca de rodada antes de observar `Resolved` rompe a continuidade.

Risco residual externo: o projeto não presume que `roundId` seja numérico/sequencial sem contrato oficial. Se a plataforma omitir uma rodada completa, continuar enviando outros `playerState` válidos e retornar antes do watchdog, uma única fonte não consegue provar matematicamente a ausência. A proteção prioriza falhar fechado em fechamento, silêncio e transições observáveis; reconciliação por uma segunda fonte oficial/roadmap continua sendo a única forma de elevar essa garantia contra omissão totalmente invisível da fonte primária.

### BUG-032 — Camada interna interceptava o ponteiro da ficha

Status: **mitigado em código; validação operacional no site real pendente**.

O log Playwright comprovou que a ficha estava visível, habilitada e estável, mas outro `div` do componente interceptava os eventos de ponteiro. Repetir o timeout não resolveria, e usar `force=True` eliminaria uma proteção importante.

Após o clique Playwright normal falhar, o executor pode identificar com `elementFromPoint` a superfície central da ficha. O acionamento só é permitido se essa superfície for o próprio elemento, descendente, ancestral ou membro do mesmo container. Como essa etapa apenas escolhe a denominação, ela não cria exposição; ainda assim, o executor exige que a assinatura/seleção DOM mude após o evento. Sem confirmação, termina com zero cliques de alvo. Player/Banker/Tie nunca passam por esse caminho e continuam protegidos pela actionability padrão, stage e sequência.

### BUG-031 — Prova curta de actionability da ficha bloqueava antes do clique financeiro

Status: **mitigado em código; validação operacional no site real pendente**.

O diagnóstico posterior mostrou a ficha exata presente e visível, sem marca de seleção, mas incapaz de concluir `click(trial=True)` em 250 ms; Banker e Tie estavam ambos acionáveis. Como a seleção da denominação não registra aposta, tratá-la com o mesmo gate do alvo financeiro criava um bloqueio sem benefício financeiro.

Uma ficha exata e visível agora pode prosseguir para o clique normal Playwright, que aguarda estabilidade por até 2 s e continua sem `force=True`. Falha nessa etapa ocorre antes de qualquer clique de alvo. Depois da ficha, o executor revalida stage e `coletor_seq` antes de cada clique financeiro; se a janela fechar durante a espera, a ordem expira sem aposta. A mesma denominação não é reclicada entre pernas do mesmo plano composto.

### BUG-030 — Ficha já selecionada era tratada como não acionável

Status: **mitigado em código; validação operacional no site real pendente**.

O diagnóstico do teste seguinte comprovou `fichas=0/1 (DOM 1)` e `alvos=1/1 (DOM 1)`: a ficha R$25 existia, mas não aceitava novo clique, enquanto Banker estava acionável. Isso é compatível com uma ficha corrente que o frontend mantém selecionada e desabilita contra reclick.

O executor agora reconhece uma ficha já selecionada somente quando o elemento correspondente está visível e possui evidência semântica explícita (`aria-pressed`, `aria-selected`, `data-selected`, `data-is-selected`, `data-active`, `data-state` ou token de classe selecionado/ativo). Nesse caso ele preserva a ficha corrente e prova o alvo com `trial=True`. Ausência dessa evidência continua fail-closed; não há `force=True` nem aceitação baseada apenas em presença no DOM.

### BUG-029 — Varredura DOM consumia a janela curta de AcceptingBets

Status: **mitigado em código; validação operacional no site real pendente**.

O primeiro teste com o stage real mostrou `ABERTA` em `AcceptingBets`, mas nenhum clique antes de `FirstDie`. A pré-validação fazia até 64 leituras Playwright individuais de `data-value` em cada frame; em uma fase curta, a própria varredura podia consumir a janela antes de concluir ficha + alvo.

Os valores das fichas agora são extraídos em uma única avaliação DOM por frame. Apenas os índices numericamente correspondentes passam pela prova de actionability, mantendo a exigência do conjunto integral e o bloqueio de todas as fases não apostáveis. Se a próxima rodada resolver sem execução, o motivo inclui a última inspeção agregada de frames/fichas/alvos para separar seletor ausente, elemento não acionável e renderização tardia sem expor o DOM.

### BUG-028 — Ordem expirava antes de a próxima janela Betting abrir

Status: **mitigado em código; validação operacional no site real pendente**.

O BUG-027 confirmou o roteamento integral Node→Python, mas a primeira ordem real terminou sem cliques porque o executor usava 15 segundos contados ainda no `Resolved`. Essa duração podia acabar durante animações/pagamento da rodada anterior. O mesmo gate aceitava qualquer stage diferente de `Resolved`, filtrava frames pelo texto da URL e testava apenas o primeiro elemento correspondente, combinando falso negativo de DOM com risco de stage permissivo.

O executor agora aguarda exclusivamente o stage real `AcceptingBets` com playerState fresco (`Betting` é mantido apenas como variante compatível) e mantém a ordem ligada ao `coletor_seq` do resultado que gerou o sinal. `WaitingForBets`, `ClosingBets`, as quatro fases dos dados, `Confirmation` e `Resolved` não autorizam cliques. Novo resultado, inconsistência de sequência, perda de prontidão ou interrupção continuam cancelando antes de qualquer clique. O tempo virou somente um fusível final de 180 s; o waiter do Node usa 210 s para nunca abandonar uma ordem que o Python ainda possa executar.

A mesa é identificada pelo conjunto completo de fichas e alvos necessários, independentemente da URL do iframe. Duplicatas ocultas são ignoradas, valores equivalentes de `data-value` são normalizados e o mesmo Locator acionável pré-validado é usado no clique. O diagnóstico de expiração informa apenas stage/seq/frescor e contagens de elementos, sem conteúdo ou URL sensível.

### BUG-019 — Proteção no empate existia no sinal, mas não na execução financeira

Status: **mitigado**.

O Auto-Trader segue `proteger_empate` da estratégia: sinal sem proteção envia apenas a cor; sinal protegido exige política financeira válida (`PERCENTUAL` ou `VALOR`) e envia uma única ordem lógica composta com principal + Tie. O valor base do Tie recebe os mesmos multiplicadores configurados para G1/G2 e é arredondado para fichas de R$5. O executor pré-valida todas as pernas com `trial=True` antes do primeiro clique; falha posterior a qualquer clique permanece `AMBIGUA`. A auditoria armazena `valor_empate` separadamente e calcula P&L usando a semântica exibida pela mesa (`4:1`, `6:1`, `10:1`, `25:1`, `88:1`), em que X representa lucro líquido por unidade apostada. Em Tie sem proteção, Player/Banker registra perda de 10% da stake da etapa e o sinal segue para o Gale quando aplicável.


### BUG-018 — Resultado resolvido antecede a janela real de apostas

Status: **mitigado**.

O sinal pode nascer assim que o coletor recebe `stage=Resolved`, enquanto a mesa só libera fichas/alvos alguns segundos depois. O executor vincula cada ordem ao `coletor_seq` vigente no aceite e exige pré-validação por `click(trial=True)` antes de qualquer clique real. O BUG-028 endureceu esse contrato: somente `stage=AcceptingBets` fresco (`Betting` compatível) autoriza o DOM, a expiração principal é estrutural e o antigo limite de 15 s foi substituído por um fusível de 180 s com waiter Node de 210 s. O TTL de 8 s continua limitando somente o tempo anterior à retirada da fila.

### SEC-002 — Comunicação interna Node ↔ Python sem autenticação

Status: **mitigado**.

`/apostar`, `/receber-sinal`, `/collector-health` e `/executor-status` exigem `INTERNAL_API_TOKEN`; o executor Flask usa loopback por padrão e valida payload mínimo antes de enfileirar ordem.

### SEC-003 — APIs Node sem autenticação e CORS amplo

Status: **mitigado pelos patches SEC-003A e SEC-003B**.

O Node usa `127.0.0.1` por padrão, valida `Host`/`Origin`, protege Socket.IO e suporta autenticação administrativa por sessão opaca em memória com cookie `HttpOnly` + `SameSite=Strict`. Fora do loopback, credenciais administrativas são obrigatórias e o backend falha fechado se estiverem incompletas.

`/receber-sinal` permanece separado da sessão administrativa e continua protegido pelo token interno.

### SEC-004 — Token Telegram exposto pelo backend

Status: **mitigado**.

`GET /api/robos` não devolve `telegram_token`; edição/toggle preserva o segredo quando o campo chega vazio/ausente.

### BUG-001 — Ordem contabilizada sem confirmação do executor

Status: **mitigado pelos patches BUG-001 e BUG-001B**, sujeito ao risco residual BUG-001R acima.

Node aguarda confirmação do executor antes de contabilizar entrada/criar Gale e usa `order_id` idempotente para retry ambíguo.

### BUG-002 — `STANDBY` indefinido

Status: **mitigado**.

Auto-Trader ativo passa de `STANDBY` para `OPERANDO` ao primeiro resultado válido/autenticado da mesa.

### BUG-003 — Edição/toggle resetava saldo do Auto-Trader

Status: **mitigado**.

Edição e toggle preservam `saldo_inicial`, `saldo_atual` e contadores operacionais; reativação usa novo baseline fresco quando apropriado.

### BUG-004 — `interrupcao_fluxo` não separava sessões

Status: **mitigado**.

Interrupção aceita rotaciona `id_sessao` antes de persistir o próximo giro, impedindo padrões atravessarem a fronteira lógica.

### BUG-005 — Persistência de históricos incompleta

Status: **mitigado em conjunto por BUG-005A + BUG-007B/007C**.

Resultados finalizados alimentam `historico_resultados`. Participação efetiva de Robôs/Canais alimenta `historico_disparos_robos`, incluindo canal Web e Telegram confirmado sem duplicação multicanal.

### BUG-006 — Regras financeiras/configuráveis sem enforcement

Status: **mitigado pelos patches BUG-006A…BUG-006D**.

Implementados: janela de horário, Stop Win, Stop Loss, Stop Reds do Auto-Trader e Trailing Stop. Gales já iniciados continuam até o desfecho para manter auditoria coerente.

### BUG-007 — Telegram, filtros e proteção de Robôs/Canais incompletos

Status: **mitigado pelos patches BUG-007A…BUG-007E**.

Implementados: CRUD visual, Web, Telegram confirmado, filtros, propriedade de padrão dinâmico, assertividade mínima, Drawdown Control e Stop Reds definitivo do Robô/Canal.

### BUG-008 — Sincronização de saldo incompleta

Status: **mitigado pelos patches BUG-008A/008B e validação operacional de 2026-08-17**.

Executor lê saldo por seletor CSS explícito, envia mudança/heartbeat ao Node e o backend usa freshness antes de permitir novo baseline/exposição.

### BUG-009 / OBS-002 — Schema inicial incompleto

Status: **mitigado**.

O backend cria as tabelas necessárias antes das migrations incrementais, permitindo inicialização de banco vazio sem depender de dump legado para as estruturas conhecidas. O OBS-003E passa a validar esse bootstrap automaticamente contra MySQL 8.4 vazio no CI.

### BUG-010 — Auto-Trader desligado permanecia `OPERANDO`

Status: **mitigado**.

Transição manual ON→OFF grava `DESLIGADO`; estados explícitos de hard stop são preservados.

### BUG-011 — Buraco Python→Node podia concatenar sequência inexistente

Status: **mitigado**.

Cada processo coletor usa `coletor_sessao` e `coletor_seq`. O Node detecta salto, restart, duplicata/atraso e desaparecimento de metadados; buraco confirmado rotaciona sessão e invalida pendências sem inferir WIN/LOSS.

### BUG-012 — Padrões IA órfãos após excluir Robô/Canal

Status: **mitigado**.

Exclusão é transacional e remove padrões IA filhos/históricos relacionados; startup também limpa órfãos legados de forma idempotente.

### BUG-013 — Cards usavam estatística operacional em vez de matching histórico

Status: **mitigado**.

Cards usam `giros_recentes` como fonte analítica, respeitam `id_sessao` e calculam DIRETO/G1/G2/TIE/RED nas janelas 24H, Hoje, Semana, Mês e Geral.

## Dependências externas que continuam fora do controle do código

- disponibilidade do MySQL e do site de destino;
- validade das credenciais reais;
- mudanças no DOM/WebSocket da plataforma;
- Chromium/Playwright instalado e compatível;
- seletor de saldo correto;
- estabilidade de rede entre processos/serviços locais.

## Política para novos problemas

Antes de criar um novo BUG/SEC/OBS, confirmar que o comportamento ainda existe no `main` atual e não está apenas descrito em documentação antiga. Novos patches devem ser pequenos, isolados, validados por testes e GitHub Actions, sem misturar correções independentes.
