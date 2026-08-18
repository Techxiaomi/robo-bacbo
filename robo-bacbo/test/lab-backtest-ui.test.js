const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const loaderHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const labJs = fs.readFileSync(path.join(root, 'public', 'lab-enhancements.js'), 'utf8');

function carregarHelpers() {
    const sandbox = {
        window: {},
        document: {},
        Number,
        Object,
        Array,
        String,
        Math,
        console
    };
    vm.runInNewContext(labJs, sandbox, { filename: 'lab-enhancements.js' });
    return sandbox.window;
}

test('UX-004: loader encadeia UI -> Lab -> DOMContentLoaded na ordem de execução', () => {
    assert.match(loaderHtml, /enhancements\.src = '\/ui-enhancements\.js\?_t=' \+ Date\.now\(\)/);
    assert.match(loaderHtml, /lab\.src = '\/lab-enhancements\.js\?_t=' \+ Date\.now\(\)/);
    assert.match(loaderHtml, /enhancements\.onload = \(\) => \{[\s\S]*?window\.aplicarAprimoramentosUI\(\);[\s\S]*?carregarLab\(\);[\s\S]*?\}/);
    assert.match(loaderHtml, /lab\.onload = \(\) => \{[\s\S]*?window\.configurarLabPadroes\(\);[\s\S]*?finalizarInicializacao\(\);[\s\S]*?\}/);
    assert.match(loaderHtml, /const finalizarInicializacao = \(\) => \{[\s\S]*?window\.dispatchEvent\(new Event\('DOMContentLoaded'\)\);[\s\S]*?\}/);
});

test('UX-004: modalidades agrupam alvo e proteção de empate em um único seletor', () => {
    assert.match(labJs, /value:\s*'PLAYER'.*alvo:\s*'Player'.*protegeEmpate:\s*false/s);
    assert.match(labJs, /value:\s*'PLAYER_TIE'.*alvo:\s*'Player'.*protegeEmpate:\s*true/s);
    assert.match(labJs, /value:\s*'BANKER'.*alvo:\s*'Banker'.*protegeEmpate:\s*false/s);
    assert.match(labJs, /value:\s*'BANKER_TIE'.*alvo:\s*'Banker'.*protegeEmpate:\s*true/s);
    assert.match(labJs, /value="AUTO"/);
    assert.match(labJs, /labelProt\.remove\(\)/);
});

test('UX-005: Automático é a primeira opção e seleção padrão', () => {
    assert.match(labJs, /entrada\.innerHTML = \[\s*'<option value="AUTO">/);
    assert.match(labJs, /entrada\.value = 'AUTO'/);
    assert.match(labJs, /const modoSelecionado = document\.getElementById\('bk-entrada'\)\?\.value \|\| 'AUTO'/);
});

test('UX-004/006A: opções de quantidade são padronizadas e MAX usa toda a memória', () => {
    for (const valor of ['100', '200', '500', '1000', '2000', '5000', 'MAX']) {
        assert.match(labJs, new RegExp(`value: '${valor}'`));
    }
    assert.match(labJs, /Toda a Base \(Max\)/);
    assert.match(labJs, /preencherRange\(range, 'MAX'\)/);
    assert.match(labJs, /preencherRange\(document\.getElementById\('mn-range'\), '1000'\)/);
    assert.match(labJs, /id="bk-dashboard-range"/);
});

test('UX-006A: corte compartilhado atende 100/200/500/1000/2000/5000/MAX', () => {
    const ui = carregarHelpers();
    const dados = Array.from({ length: 6007 }, (_, indice) => indice);

    for (const limite of [100, 200, 500, 1000, 2000, 5000]) {
        const corte = ui.ux006CortarDadosPorRange(String(limite), dados);
        assert.equal(corte.length, limite);
        assert.equal(corte[0], dados.length - limite);
    }

    const max = ui.ux006CortarDadosPorRange('MAX', dados);
    assert.equal(max.length, dados.length);
    assert.notEqual(max, dados);
});

test('UX-006A: dashboard do Backtest mantém filtro próprio e não herda range do Lab', () => {
    assert.match(labJs, /const valor = document\.getElementById\('bk-dashboard-range'\)\?\.value \|\| 'MAX'/);
    assert.match(labJs, /function atualizarDashboardBacktestPorRange\(\)/);
    assert.match(labJs, /calcularEstatisticasMesaBase\(obterDadosDashboardBacktest\(\)\)/);
    assert.match(labJs, /atualizarDashboardBacktestPorRange\(\);\s*renderizarFitaTemporal\(dadosCorte/);
});

test('UX-004: modo Automático executa as quatro modalidades no mesmo motor', () => {
    assert.match(labJs, /if \(modoSelecionado === 'AUTO'\)/);
    assert.match(labJs, /MODOS_APOSTA\.map\(modo => \(\{/);
    assert.match(labJs, /simularBacktestCore\(bkPadraoAtual, modo\.alvo, gales, modo\.protegeEmpate, dadosCorte\)/);
    assert.match(labJs, /mostrarResultadosAutomaticos\(resultados\)/);
    assert.match(labJs, /data-bk-modo=/);
});

test('UX-004: helpers preservam semântica de Player/Banker e empate protegido', () => {
    const ui = carregarHelpers();

    const player = ui.ux004ResolverModoAposta('PLAYER');
    const playerTie = ui.ux004ResolverModoAposta('PLAYER_TIE');
    const banker = ui.ux004ResolverModoAposta('BANKER');
    const bankerTie = ui.ux004ResolverModoAposta('BANKER_TIE');

    assert.equal(player.alvo, 'Player');
    assert.equal(player.protegeEmpate, false);
    assert.equal(playerTie.alvo, 'Player');
    assert.equal(playerTie.protegeEmpate, true);
    assert.equal(banker.alvo, 'Banker');
    assert.equal(banker.protegeEmpate, false);
    assert.equal(bankerTie.alvo, 'Banker');
    assert.equal(bankerTie.protegeEmpate, true);
    assert.equal(ui.ux004ResolverModoAposta('AUTO'), null);
});

test('UX-004: resumo automático separa greens, ties, reds e níveis', () => {
    const ui = carregarHelpers();
    const resumo = ui.ux004ResumirStats({
        sg: 3,
        g1: 2,
        g2: 1,
        red: 2,
        totalEncontrado: 10,
        ties: {
            direto: { '4x': 1 },
            g1: { '5x': 1 },
            g2: {}
        }
    });

    assert.equal(resumo.direto, 3);
    assert.equal(resumo.g1, 2);
    assert.equal(resumo.g2, 1);
    assert.equal(resumo.greensSemTie, 6);
    assert.equal(resumo.ties, 2);
    assert.equal(resumo.reds, 2);
    assert.equal(resumo.vitorias, 8);
    assert.equal(resumo.ocorrencias, 10);
    assert.equal(resumo.assertividade, 80);
});

test('UX-005: resultados automáticos são ordenados por assertividade decrescente com desempate estável', () => {
    const ui = carregarHelpers();
    const criar = (value, wins, reds) => ({
        modo: { value },
        resultado: {
            stats: {
                sg: wins,
                g1: 0,
                g2: 0,
                red: reds,
                totalEncontrado: wins + reds,
                ties: { direto: {}, g1: {}, g2: {} }
            }
        }
    });

    const ordenados = ui.ux005OrdenarResultadosAutomaticos([
        criar('A', 1, 3),
        criar('B', 3, 1),
        criar('C', 2, 2),
        criar('D', 3, 1)
    ]);

    assert.deepEqual(Array.from(ordenados, item => item.modo.value), ['B', 'D', 'C', 'A']);
});

test('UX-005: ocorrências têm métrica própria e o texto redundante de vitórias foi removido', () => {
    assert.match(labJs, /class="bk-auto-ocorrencias"/);
    assert.match(labJs, /<span>Ocorrências<\/span><strong>\$\{s\.ocorrencias\}<\/strong>/);
    assert.doesNotMatch(labJs, /\$\{s\.vitorias\} vitórias em \$\{s\.ocorrencias\} ocorrências/);
});

test('UX-004: salvar no modo automático é explicitamente bloqueado por ambiguidade', () => {
    assert.match(labJs, /if \(valor === 'AUTO'\)/);
    assert.match(labJs, /Para salvar, escolha Player, Player \+ Empate, Banker ou Banker \+ Empate/);
    assert.match(labJs, /document\.getElementById\('proteger_empate'\)\.checked = modo\.protegeEmpate/);
});
