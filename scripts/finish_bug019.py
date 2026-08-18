from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: esperado 1 match, encontrado {count}")
    return text.replace(old, new, 1)


# ------------------------------------------------------------------
# Backend: remove import que ficou redundante depois de preservar
# calcularFichaSegura autocontida para a suíte legada.
# ------------------------------------------------------------------
bot_path = Path('robo-bacbo/bot2_coletor.js')
bot = bot_path.read_text(encoding='utf-8')
bot = replace_once(
    bot,
    '    calcularFichaSegura: calcularFichaSeguraProtecao,\n',
    '',
    'import redundante calcularFichaSegura'
)
bot_path.write_text(bot, encoding='utf-8')


# ------------------------------------------------------------------
# Frontend: botões de ficha também atualizam o preview efetivo.
# ------------------------------------------------------------------
html_path = Path('robo-bacbo/public/dashboard-app.html')
html = html_path.read_text(encoding='utf-8')
html = replace_once(
    html,
    "        function addFicha(valor) { let input = document.getElementById('at-stake'); let atual = parseFloat(input.value) || 0; input.value = (atual + valor).toFixed(2); }\n        function limparFichas() { document.getElementById('at-stake').value = \"0.00\"; }",
    "        function addFicha(valor) { let input = document.getElementById('at-stake'); let atual = parseFloat(input.value) || 0; input.value = (atual + valor).toFixed(2); atualizarPreviewProtecaoEmpateAutoTrader(); }\n        function limparFichas() { document.getElementById('at-stake').value = \"0.00\"; atualizarPreviewProtecaoEmpateAutoTrader(); }",
    'preview botoes ficha'
)
html_path.write_text(html, encoding='utf-8')


# ------------------------------------------------------------------
# Node transport regression: um retry precisa preservar exatamente
# o mesmo plano composto e order_id.
# ------------------------------------------------------------------
order_path = Path('robo-bacbo/test/order-intent.test.js')
order = order_path.read_text(encoding='utf-8')
old = '''    await assert.rejects(
        () => logic.enviarOrdemAoExecutor("PlayerWon", 15, orderId),
        erro => erro && erro.envio_ambiguo === true && erro.status_executor === "AMBIGUA"
    );
    assert.equal(chamadas, 2);
    assert.equal(corpos[0].order_id, corpos[1].order_id);
});'''
new = '''    const plano = [
        { alvo: "PlayerWon", valor: 15 },
        { alvo: "Tie", valor: 5 }
    ];
    await assert.rejects(
        () => logic.enviarOrdemAoExecutor("PlayerWon", 15, orderId, plano),
        erro => erro && erro.envio_ambiguo === true && erro.status_executor === "AMBIGUA"
    );
    assert.equal(chamadas, 2);
    assert.equal(corpos[0].order_id, corpos[1].order_id);
    assert.deepEqual(corpos[0].apostas, plano);
    assert.deepEqual(corpos[1], corpos[0]);
    assert.equal(corpos[0].alvo, undefined);
    assert.equal(corpos[0].valor, undefined);
});'''
order = replace_once(order, old, new, 'retry composto transport')
order_path.write_text(order, encoding='utf-8')


# ------------------------------------------------------------------
# E2E Node + fake executor + MySQL: converte o cenário existente em
# estratégia protegida, validando duas pernas, auditoria e P&L.
# ------------------------------------------------------------------
e2e_path = Path('robo-bacbo/integration/controlled-e2e-smoke.js')
e2e = e2e_path.read_text(encoding='utf-8')

old_validate = '''                assert.ok(["PlayerWon", "BankerWon", "Tie"].includes(payload.alvo));
                assert.ok(Number(payload.valor) > 0);

                const db = getDb();
                assert.ok(db, "Conexão MySQL do teste deve existir antes da primeira ordem");
                const [[intent]] = await db.query(
                    `SELECT id, trader_id, alvo, nivel, valor_entrada, executor_order_id, status_ordem
                     FROM auditoria_ordens
                     WHERE executor_order_id=?
                     ORDER BY id DESC LIMIT 1`,
                    [payload.order_id]
                );
                assert.ok(intent, "Intenção durável deve existir antes do ACK do executor");
                assert.equal(intent.status_ordem, "PREPARANDO");
                assert.equal(intent.alvo, payload.alvo);
                assert.equal(Number(intent.valor_entrada), Number(payload.valor));'''
new_validate = '''                const apostas = Array.isArray(payload.apostas)
                    ? payload.apostas
                    : [{ alvo: payload.alvo, valor: payload.valor }];
                assert.ok(apostas.length >= 1 && apostas.length <= 2);
                const alvos = new Set();
                for (const perna of apostas) {
                    assert.ok(["PlayerWon", "BankerWon", "Tie"].includes(perna.alvo));
                    assert.ok(Number(perna.valor) > 0);
                    assert.equal(alvos.has(perna.alvo), false, "Plano nao pode repetir alvo");
                    alvos.add(perna.alvo);
                }
                const principal = apostas[0];
                const empate = apostas.find(perna => perna.alvo === "Tie") || null;

                const db = getDb();
                assert.ok(db, "Conexão MySQL do teste deve existir antes da primeira ordem");
                const [[intent]] = await db.query(
                    `SELECT id, trader_id, alvo, nivel, valor_entrada, valor_empate,
                            executor_order_id, status_ordem
                     FROM auditoria_ordens
                     WHERE executor_order_id=?
                     ORDER BY id DESC LIMIT 1`,
                    [payload.order_id]
                );
                assert.ok(intent, "Intenção durável deve existir antes do ACK do executor");
                assert.equal(intent.status_ordem, "PREPARANDO");
                assert.equal(intent.alvo, principal.alvo);
                assert.equal(Number(intent.valor_entrada), Number(principal.valor));
                assert.equal(Number(intent.valor_empate), empate ? Number(empate.valor) : 0);'''
e2e = replace_once(e2e, old_validate, new_validate, 'fake executor composto')

e2e = replace_once(
    e2e,
    '''                orders.push({
                    payload,
                    token: req.headers["x-internal-token"],''',
    '''                orders.push({
                    payload,
                    apostas,
                    token: req.headers["x-internal-token"],''',
    'orders apostas'
)

e2e = replace_once(
    e2e,
    '''                protegerEmpate: false,
                ativo: true''',
    '''                protegerEmpate: true,
                ativo: true''',
    'estrategia protegida'
)

e2e = replace_once(
    e2e,
    '"SELECT id, origem, padrao, entrada, gales, ativo FROM estrategias WHERE nome=? LIMIT 1",',
    '"SELECT id, origem, padrao, entrada, gales, proteger_empate, ativo FROM estrategias WHERE nome=? LIMIT 1",',
    'select estrategia protecao'
)

e2e = replace_once(
    e2e,
    '''        assert.equal(Number(strategy.gales), 0);
        assert.equal(Number(strategy.ativo), 1);''',
    '''        assert.equal(Number(strategy.gales), 0);
        assert.equal(Number(strategy.proteger_empate), 1);
        assert.equal(Number(strategy.ativo), 1);''',
    'assert estrategia protecao'
)

e2e = replace_once(
    e2e,
    '''                    gale_1_mult: 2,
                    gale_2_mult: 4,
                    modo_camuflagem: "TODAS",''',
    '''                    gale_1_mult: 2,
                    gale_2_mult: 4,
                    tie_stake_mode: "VALOR",
                    tie_stake_value: 5,
                    tie_stake_percent: 0,
                    modo_camuflagem: "TODAS",''',
    'config trader tie'
)

old_order_assert = '''        assert.equal(order.token, TOKEN);
        assert.equal(order.payload.alvo, "BankerWon");
        assert.equal(Number(order.payload.valor), 10);
        assert.equal(order.intentStatusBeforeAck, "PREPARANDO");'''
new_order_assert = '''        assert.equal(order.token, TOKEN);
        assert.equal(order.apostas.length, 2);
        assert.deepEqual(order.apostas, [
            { alvo: "BankerWon", valor: 10 },
            { alvo: "Tie", valor: 5 }
        ]);
        assert.equal(order.payload.alvo, undefined);
        assert.equal(order.payload.valor, undefined);
        assert.equal(order.intentStatusBeforeAck, "PREPARANDO");'''
e2e = replace_once(e2e, old_order_assert, new_order_assert, 'assert ordem composta')

e2e = replace_once(
    e2e,
    '''                        valor_entrada, executor_order_id, status_ordem, lucro_prejuizo, placar_mesa''',
    '''                        valor_entrada, valor_empate, executor_order_id, status_ordem, lucro_prejuizo, placar_mesa''',
    'finalized select valor empate'
)

e2e = replace_once(
    e2e,
    '''        assert.equal(Number(finalized.risco_total), 10);
        assert.equal(Number(finalized.valor_entrada), 10);''',
    '''        assert.equal(Number(finalized.risco_total), 15);
        assert.equal(Number(finalized.valor_entrada), 10);
        assert.equal(Number(finalized.valor_empate), 5);''',
    'assert exposure protected'
)

e2e = replace_once(
    e2e,
    '        assert.equal(Number(finalized.lucro_prejuizo), 10);',
    '        assert.equal(Number(finalized.lucro_prejuizo), 5);',
    'assert pnl protected win'
)

e2e_path.write_text(e2e, encoding='utf-8')


# ------------------------------------------------------------------
# Browser smoke: prova os dois modos e os valores efetivos Direto/G1/G2.
# ------------------------------------------------------------------
browser_path = Path('robo-bacbo/integration/dashboard-browser-smoke.py')
browser = browser_path.read_text(encoding='utf-8')
anchor = '''        assert opcoes["socketRegistrado"] is True, opcoes

        # Isola a prova de ordenação dos cards da regra dos seletores globais.'''
insert = '''        assert opcoes["socketRegistrado"] is True, opcoes

        # BUG-019: o formulário do Auto-Trader expõe política de Tie por percentual
        # ou valor e mostra os valores efetivos após arredondamento e Gales.
        tie_ui = page.evaluate(
            """
            () => {
                const modo = document.getElementById('at-tie-modo');
                const pct = document.getElementById('at-tie-percent');
                const valor = document.getElementById('at-tie-valor');
                const stake = document.getElementById('at-stake');
                const g1 = document.getElementById('at-gale1');
                const g2 = document.getElementById('at-gale2');
                if (!modo || !pct || !valor || !stake || !g1 || !g2) return null;

                stake.value = '100';
                g1.value = '2';
                g2.value = '4';
                modo.value = 'PERCENTUAL';
                pct.value = '5';
                window.toggleProtecaoEmpateAutoTrader();
                const percentual = document.getElementById('at-tie-preview').innerText;

                modo.value = 'VALOR';
                valor.value = '10';
                window.toggleProtecaoEmpateAutoTrader();
                const fixo = document.getElementById('at-tie-preview').innerText;

                modo.value = 'PERCENTUAL';
                pct.value = '5';
                window.toggleProtecaoEmpateAutoTrader();
                window.addFicha(5);
                const aposFicha = document.getElementById('at-tie-preview').innerText;

                return {
                    modos: Array.from(modo.options).map(o => o.value),
                    percentual,
                    fixo,
                    aposFicha,
                    boxPercentDisplay: document.getElementById('box-at-tie-percent').style.display,
                    boxValorDisplay: document.getElementById('box-at-tie-valor').style.display
                };
            }
            """
        )
        assert tie_ui is not None, tie_ui
        assert tie_ui["modos"] == ["PERCENTUAL", "VALOR"], tie_ui
        assert "Cor R$ 100 + Tie R$ 5" in tie_ui["percentual"], tie_ui
        assert "Cor R$ 200 + Tie R$ 10" in tie_ui["percentual"], tie_ui
        assert "Cor R$ 400 + Tie R$ 20" in tie_ui["percentual"], tie_ui
        assert "Cor R$ 100 + Tie R$ 10" in tie_ui["fixo"], tie_ui
        assert "Cor R$ 200 + Tie R$ 20" in tie_ui["fixo"], tie_ui
        assert "Cor R$ 400 + Tie R$ 40" in tie_ui["fixo"], tie_ui
        assert "Cor R$ 105 + Tie R$ 5" in tie_ui["aposFicha"], tie_ui
        assert tie_ui["boxPercentDisplay"] == "flex", tie_ui
        assert tie_ui["boxValorDisplay"] == "none", tie_ui

        # Isola a prova de ordenação dos cards da regra dos seletores globais.'''
browser = replace_once(browser, anchor, insert, 'browser tie ui')
browser_path.write_text(browser, encoding='utf-8')

print('Acabamento BUG-019 aplicado')
