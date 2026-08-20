from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
FILE = ROOT / "robo-bacbo" / "support" / "pure-logic-suite.js"
text = FILE.read_text(encoding="utf-8")

pattern = re.compile(
    r'test\("BUG-028: executor espera AcceptingBets estrutural e Node preserva o callback", \(\) => \{.*?\n\}\);',
    re.S,
)

replacement = r'''test("BUG-046: executor ancora a janela em Resolved + 8s e Node preserva o callback", () => {
    assert.match(executorPythonSource, /EXECUTOR_BETTING_WINDOW_TIMEOUT_SECONDS = 180\.0/);
    assert.match(executorPythonSource, /normalizado in \{"waitingforbets", "closingbets", "acceptingbets", "betting"\}/);
    assert.match(executorPythonSource, /ultimo_resolved_monotonic = 0\.0/);
    assert.match(executorPythonSource, /resolved_monotonic_aceite/);
    assert.match(executorPythonSource, /alvo_temporal = resolved_base \+ 8\.0/);
    assert.match(executorPythonSource, /janela real alvo em \+8000ms/);
    assert.match(executorPythonSource, /janela real liberada em/);
    assert.match(executorPythonSource, /if contexto\["estado"\] == "EXPIRADA":/);
    assert.match(executorPythonSource, /fichas_acionaveis/);
    assert.match(executorPythonSource, /alvos_acionaveis/);
    assert.match(executorPythonSource, /candidatos\.evaluate_all/);
    assert.match(executorPythonSource, /JA_SELECIONADA/);
    assert.match(executorPythonSource, /CLICAR_AGUARDANDO_ESTABILIDADE/);
    assert.match(executorPythonSource, /selecionar_ficha_com_confirmacao/);
    assert.match(executorPythonSource, /SUPERFICIE_PLAYWRIGHT_/);
    assert.match(executorPythonSource, /page\.wait_for_timeout\(25\)/);
    assert.match(executorPythonSource, /page\.wait_for_timeout\(2500\)/);
    assert.equal((executorPythonSource.match(/elemento\.click\(timeout=2000\)/g) || []).length, 2);
    assert.match(executorPythonSource, /page\.wait_for_timeout\(150\)/);
    assert.match(executorPythonSource, /page\.wait_for_timeout\(120\)/);
    assert.doesNotMatch(executorPythonSource, /aguardando 1500ms para estabilização visual das fichas/);
    assert.doesNotMatch(executorPythonSource, /page\.mouse\.move/);
    assert.doesNotMatch(executorPythonSource, /elemento\.dispatch_event\("pointerdown"\)/);
    assert.doesNotMatch(executorPythonSource, /elemento\.dispatch_event\("pointerup"\)/);
    assert.doesNotMatch(executorPythonSource, /elemento\.evaluate\("el => el\.click\(\)"\)/);
    assert.doesNotMatch(executorPythonSource, /hit_elemento\.click/);
    assert.match(executorPythonSource, /aria-pressed/);

    const localizador = executorPythonSource.slice(
        executorPythonSource.indexOf("def localizar_contexto_apostavel"),
        executorPythonSource.indexOf("def localizar_frame_apostavel")
    );
    assert.doesNotMatch(localizador, /evolution|evocdn|game/);
    assert.match(source, /process\.env\.EXECUTOR_EXECUTION_TIMEOUT_MS \|\| 210000/);
    assert.match(source, /executorExecutionTimeoutConfig >= 195000/);
});'''

text, count = pattern.subn(replacement, text, count=1)
if count != 1:
    if 'test("BUG-046: executor ancora a janela em Resolved + 8s' not in text:
        raise SystemExit(f"bloco de contrato Node esperado 1 vez, encontrado {count}")

FILE.write_text(text, encoding="utf-8")
print("Contrato Node BUG-046 alinhado ao Resolved+8s e clique Playwright simples.")
