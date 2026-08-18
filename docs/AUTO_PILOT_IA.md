# Auto Pilot IA — seleção e ciclo de vida

## Objetivo

O Auto Pilot IA deixa de tratar `max_padroes` como um simples corte por maior assertividade. A seleção passa por uma esteira conservadora de mineração, qualificação estatística, dupla validação, score, diversificação, reserva e revalidação.

A implementação não assume que sequências históricas de Bac Bo criam vantagem causal. O motor deve ser lido como um filtro estatístico contra overfitting, não como prova de previsibilidade do jogo.

## Pipeline

1. **Janela de dados** — usa no máximo `range` giros recentes e respeita `id_sessao`; ocorrências não atravessam interrupções de coleta.
2. **Geração de candidatos** — testa padrões entre `tam_min` e `tam_max` e avalia Player/Banker com os mesmos Gales e a mesma regra de proteção de empate configurados no robô.
3. **Filtros duros** — exige `ocorr_min`, `assert_min` e remove padrões da blacklist.
4. **Confiança estatística** — calcula Wilson Lower Bound de 95%. Uma amostra pequena e perfeita recebe menos confiança que uma amostra grande e consistente.
5. **Score composto** — combina Wilson, assertividade observada, volume de amostra, desempenho recente e penalidade de complexidade. Padrões já ativos recebem pequeno bônus de incumbência para reduzir troca excessiva.
6. **Validação histórica** — quando `shadow_giros > 0`, os últimos X giros ficam fora do treino e funcionam como holdout out-of-sample. O candidato precisa ocorrer nessa janela e permanecer acima do limiar de validação.
7. **Shadow Live** — quando `shadow_live_ocorrencias > 0`, candidatos aprovados no holdout histórico passam a ser acompanhados somente em rodadas futuras reais, em paper trading. Não geram Web, Telegram nem Auto-Trader. O teste termina ao completar X ocorrências: o candidato é APROVADO ou REJEITADO.
8. **Diversidade** — o TOP X evita, quando houver alternativa, preencher todas as vagas com variações quase idênticas da mesma sequência/alvo.
9. **Ativos e reserva** — apenas `max_padroes` ficam ativos. Os próximos melhores aprovados ficam persistidos como reserva e podem ser promovidos nas reavaliações.
10. **Descarte live** — após cada fechamento de um padrão IA ativo, `drop_reds` e `drop_assert` são reavaliados. Se houver descarte, o padrão é desativado imediatamente e o portfólio é reminerado para promover a melhor reserva elegível.
11. **TTL como revalidação** — `ttl_horas` não mata automaticamente um padrão bom. Ao vencer, ele é reavaliado; se continuar qualificado, recebe novo ciclo. Históricos live e de Shadow Live usam IDs determinísticos para impedir que um padrão reapareça com reputação artificialmente zerada.

## Dupla validação

O fluxo recomendado é:

```text
TREINO
  ↓
VALIDAÇÃO HISTÓRICA (holdout)
  ↓
SHADOW LIVE (paper trading futuro)
  ↓
RESERVA
  ↓
ATIVO
```

### Validação histórica

`shadow_giros` separa os últimos X giros da janela de análise. Esses dados não participam da descoberta do candidato. O padrão precisa demonstrar desempenho aceitável nesse trecho posterior antes de avançar.

### Shadow Live

`shadow_live_ocorrencias` define quantas ocorrências futuras do próprio padrão serão observadas. O contador é por **ocorrência do padrão**, e não por quantidade bruta de giros.

Ao atingir o mínimo configurado, o teste é encerrado:

- assertividade Shadow Live >= `max(drop_assert, assert_min - 10)` → **APROVADO**;
- abaixo desse limiar → **REJEITADO**.

Um rejeitado deixa imediatamente o conjunto monitorado e libera uma vaga para outro candidato. Seu histórico de paper trading permanece associado ao ID determinístico para evitar reentrada com reputação zerada.

O score de um candidato aprovado incorpora o Shadow Live com peso adicional para Wilson e assertividade futura, além de penalizar degradação relevante em relação ao treino.

`shadow_live_max_candidatos` limita quantos candidatos podem permanecer simultaneamente em paper trading.

## Estados IA

As estratégias dinâmicas usam estados explícitos:

- `ATIVO` — pode participar do matcher real;
- `RESERVA` — aprovado, mas fora do TOP X;
- `SHADOW_HISTORICO` — ainda não aprovou o holdout histórico;
- `SHADOW_LIVE` — aprovado historicamente e coletando ocorrências futuras;
- `REJEITADO` — concluiu o Shadow Live abaixo do limiar.

Somente `ATIVO` é carregado como estratégia operacional. Reserva e sombras permanecem `ativo=false`.

## Paper trading e persistência

Os resultados simulados do Shadow Live são gravados em `historico_shadow_ia`, separados de `historico_resultados` e `historico_disparos_robos`.

A chave única `(estrategia_id, giro_resultado_id)` torna o registro idempotente e impede contagem duplicada do mesmo padrão no mesmo giro de fechamento.

Essa separação garante que Shadow Live não contamine estatísticas de sinais realmente distribuídos e não seja interpretado como execução financeira.

## Telemetria da mineração

Cada mineração imprime auditoria suficiente para explicar a seleção:

- tamanho da janela, treino e holdout histórico;
- quantidade de padrões únicos e combinações padrão+alvo avaliadas;
- reprovações por ocorrências, assertividade e validação histórica;
- quantidade configurada na blacklist;
- ativos, reservas, Shadow Histórico, Shadow Live, rejeitados e candidatos fora do pool;
- para cada ativo: padrão, alvo, score, assertividade, ocorrências e Wilson;
- TOP reservas para comparação;
- progresso de cada candidato Shadow Live após uma ocorrência futura.

A telemetria é observacional: não altera score, stake nem execução.

## Perfis de seleção

- **CONSERVADOR** — maior peso para Wilson e tamanho de amostra; penaliza mais padrões longos e exige maior diversidade entre os ativos.
- **BALANCEADO** — perfil padrão; equilibra confiança, assertividade, amostra e recência.
- **AGRESSIVO** — dá mais peso à assertividade e à recência e tolera maior semelhança entre candidatos.

O perfil muda somente a seleção estatística dos padrões. Ele não altera stake, Gales, Stop Win/Loss, executor ou regras financeiras do Auto-Trader.

## Blacklist

Cada padrão deve ser separado por `;`, quebra de linha ou `|`.

Exemplo:

```text
P,B,P,B ; B,P,B,P
```

Dentro de cada padrão podem ser usados `P/B/T` ou `Player/Banker/Tie`.

## Segurança operacional

- Mineração e reconciliação não alteram o conjunto de estratégias enquanto existir um sinal em andamento.
- Alterações ou promoções forçadas durante sinal/Gale ficam pendentes para o próximo giro seguro.
- Reserva, Shadow Histórico, Shadow Live e Rejeitado ficam fora do matcher real.
- Shadow Live não chama Web, Telegram nem Auto-Trader.
- IDs dos padrões IA são determinísticos por robô + sequência + alvo + Gales + proteção de empate.
- Padrões dinâmicos continuam pertencendo exclusivamente ao `robo_dono_id`.
- A memória operacional do backend é recarregada somente após reconciliação segura.

## Configurações

Configurações utilizadas pelo motor:

`range`, `trigger`, `tam_min`, `tam_max`, `assert_min`, `ocorr_min`, `gales`, `proteger_empate`, `blacklist`, `shadow_giros`, `shadow_live_ocorrencias`, `shadow_live_max_candidatos`, `max_padroes`, `drop_reds`, `drop_assert`, `ttl_horas` e `perfil_selecao`.

Compatibilidade: JSONs antigos que não possuem `shadow_live_ocorrencias` continuam com Shadow Live desativado (`0`) até serem explicitamente salvos com o novo campo.

Na interface, novos robôs recebem como sugestão inicial `shadow_giros=200`, `shadow_live_ocorrencias=10` e `shadow_live_max_candidatos=10`; todos os valores continuam editáveis, e `0` desativa cada etapa correspondente quando permitido.
