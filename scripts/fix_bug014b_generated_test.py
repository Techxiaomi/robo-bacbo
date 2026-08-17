from pathlib import Path

p = Path("robo-bacbo/test/order-intent.test.js")
text = p.read_text(encoding="utf-8")
old = '''test("5xx sem aceita=false continua ambiguo e usa mesmo order_id", async () => {
    let chamadas = 0;
    const corpos = [];
    const logic = carregarTransporte(async (_url, options) => {
        chamadas++;
        corpos.push(JSON.parse(options.body));
        return { ok: false, status: 503, json: async () => ({ erro: "indisponivel" }) };
    }, 45);

    await assert.rejects(
        () => logic.enviarOrdemAoExecutor("PlayerWon", 15, "22222222-2222-4222-8222-222222222222"),
        erro => erro && erro.envio_ambiguo === true && erro.status_executor === "TIMEOUT"
    );
    assert.equal(chamadas, 2);
    assert.equal(corpos[0].order_id, corpos[1].order_id);
});
'''
new = '''test("5xx sem aceita=false continua ambiguo, repete o mesmo ID e aceita callback tardio", async () => {
    let chamadas = 0;
    let registrar = null;
    const corpos = [];
    const orderId = "22222222-2222-4222-8222-222222222222";
    const logic = carregarTransporte(async (_url, options) => {
        chamadas++;
        corpos.push(JSON.parse(options.body));
        if (chamadas === 2) {
            assert.equal(registrar({ order_id: orderId, status: "AMBIGUA", motivo: "resposta HTTP perdida" }), true);
        }
        return { ok: false, status: 503, json: async () => ({ erro: "indisponivel" }) };
    });
    registrar = logic.registrarResultadoExecucaoExecutor;

    await assert.rejects(
        () => logic.enviarOrdemAoExecutor("PlayerWon", 15, orderId),
        erro => erro && erro.envio_ambiguo === true && erro.status_executor === "AMBIGUA"
    );
    assert.equal(chamadas, 2);
    assert.equal(corpos[0].order_id, corpos[1].order_id);
});
'''
if text.count(old) != 1:
    raise SystemExit(f"trecho do teste ambiguo nao encontrado exatamente uma vez: {text.count(old)}")
p.write_text(text.replace(old, new, 1), encoding="utf-8")
print("teste ambiguo BUG-014B corrigido")
