# Auto Pilot IA — seleção e ciclo de vida

## Objetivo

O Auto Pilot IA deixa de tratar `max_padroes` como um simples corte por maior assertividade. A seleção passa por uma esteira conservadora de mineração, qualificação estatística, validação sombra, score, diversificação, reserva e revalidação.

A implementação não assume que sequências históricas de Bac Bo criam vantagem causal. O motor deve ser lido como um filtro estatístico contra overfitting, não como prova de previsibilidade do jogo.

## Pipeline

1. **Janela de dados** — usa no máximo `range` giros recentes e respeita `id_sessao`; ocorrências não atravessam interrupções de coleta.
2. **Geração de candidatos** — testa padrões entre `tam_min` e `tam_max` e avalia Player/Banker com os mesmos Gales e a mesma regra de proteção de empate configurados no robô.
3. **Filtros duros** — exige `ocorr_min`, `assert_min` e remove padrões da blacklist.
4. **Confiança estatística** — calcula Wilson Lower Bound de 95%. Uma amostra pequena e perfeita recebe menos confiança que uma amostra grande e consistente.
5. **Score composto** — combina Wilson, assertividade observada, volume de amostra, desempenho recente e penalidade de complexidade. Padrões já ativos recebem pequeno bônus de incumbência para reduzir troca excessiva.
6. **Shadow / holdout** — quando `shadow_giros > 0`, os últimos X giros ficam fora do treino e funcionam como validação out-of-sample. O candidato não pode ser promovido se não tiver observações suficientes nessa janela ou se degradar abaixo do limiar de validação.
7. **Diversidade** — o TOP X evita, quando houver alternativa, preencher todas as vagas com variações quase idênticas da mesma sequência/alvo.
8. **Ativos e reserva** — apenas `max_padroes` ficam ativos. Os próximos melhores ficam persistidos como reserva e podem ser promovidos nas próximas reavaliações.
9. **Descarte live** — após cada fechamento de um padrão IA, `drop_reds` e `drop_assert` são reavaliados. Se houver descarte, o padrão é desativado imediatamente e o portfólio é reminerado para promover a melhor reserva elegível.
10. **TTL como revalidação** — `ttl_horas` não mata automaticamente um padrão bom. Ao vencer, ele é reavaliado; se continuar qualificado, recebe novo ciclo. Quando uma definição expirada sai do pool, seu histórico live é preservado pelo ID determinístico para impedir que um padrão ruim reapareça com reputação zerada. Esse histórico é removido na exclusão definitiva do robô proprietário.

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
- Reservas e candidatos em sombra ficam com `ativo=false`, portanto não entram no matcher real e não bloqueiam sinais ativos.
- IDs dos padrões IA são determinísticos por robô + sequência + alvo + Gales + proteção de empate. Isso preserva o histórico quando o mesmo candidato é reencontrado.
- Padrões dinâmicos continuam pertencendo exclusivamente ao `robo_dono_id`.
- A memória do backend é recarregada somente após a reconciliação transacional dos padrões.

## Configurações já existentes utilizadas

`range`, `trigger`, `tam_min`, `tam_max`, `assert_min`, `ocorr_min`, `gales`, `proteger_empate`, `blacklist`, `shadow_giros`, `max_padroes`, `drop_reds`, `drop_assert` e `ttl_horas` passam a ter efeito no motor.

A configuração adicional `perfil_selecao` aceita `CONSERVADOR`, `BALANCEADO` e `AGRESSIVO`, com `BALANCEADO` como default.
