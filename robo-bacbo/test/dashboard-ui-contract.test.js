const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const loaderHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const appHtml = fs.readFileSync(path.join(root, 'public', 'dashboard-app.html'), 'utf8');
const dashboardJs = fs.readFileSync(path.join(root, 'public', 'dashboard-ui.js'), 'utf8');
const enhancementsJs = fs.readFileSync(path.join(root, 'public', 'ui-enhancements.js'), 'utf8');
const backend = fs.readFileSync(path.join(root, 'bot2_coletor.js'), 'utf8');

function criarElemento(valor = '') {
    return {
        value: valor,
        innerText: '',
        style: {},
        atributos: {},
        setAttribute(nome, valorAtributo) {
            this.atributos[nome] = String(valorAtributo);
        }
    };
}

function criarSandboxDashboard(fetchImpl) {
    const elementos = {
        'select-robo-dash': criarElemento('42'),
        'select-origem-dash': criarElemento('Origem VIP'),
        'dash-sinais': criarElemento(),
        'dash-greens': criarElemento(),
        'dash-reds': criarElemento(),
        'dash-ties': criarElemento(),
        'dash-max-green': criarElemento(),
        'dash-max-red': criarElemento(),
        'dash-assertividade': criarElemento(),
        'box-assertividade': criarElemento(),
        'label-assertividade': criarElemento()
    };

    const botoes = ['24h', 'hoje', 'semana', 'mes', 'geral'].map(periodo => {
        const botao = criarElemento();
        botao.id = `btn-dash-${periodo}`;
        elementos[botao.id] = botao;
        return botao;
    });

    const sandbox = {
        window: { getCor: () => '#28a745' },
        document: {
            getElementById: id => elementos[id] || null,
            querySelectorAll: seletor => seletor === '.btn-dash' ? botoes : []
        },
        fetch: fetchImpl,
        URLSearchParams,
        Date,
        Number,
        Set,
        String,
        Math,
        console: { error() {} }
    };

    vm.runInNewContext(dashboardJs, sandbox, { filename: 'dashboard-ui.js' });
    return { sandbox, elementos, botoes };
}

test('BUG-017: loader elimina document.write e fixa a ordem das dependencias criticas', () => {
    assert.doesNotMatch(loaderHtml, /document\.open\(\)/);
    assert.doesNotMatch(loaderHtml, /document\.write\(/);
    assert.doesNotMatch(loaderHtml, /document\.close\(\)/);

    const posChart = loaderHtml.indexOf('cdn.jsdelivr.net/npm/chart.js');
    const posPdf = loaderHtml.indexOf('html2pdf.bundle.min.js');
    const posSocket = loaderHtml.indexOf('/socket.io/socket.io.js');
    const posDashboard = loaderHtml.indexOf('/dashboard-ui.js');
    assert.ok(posChart >= 0, 'Chart.js ausente');
    assert.ok(posPdf > posChart, 'html2pdf deve carregar depois do Chart.js');
    assert.ok(posSocket > posPdf, 'Socket.IO deve carregar antes da aplicacao');
    assert.ok(posDashboard > posSocket, 'dashboard-ui deve carregar depois do Socket.IO');

    assert.match(loaderHtml, /new DOMParser\(\)\.parseFromString\(html, 'text\/html'\)/);
    assert.match(loaderHtml, /querySelectorAll\('script:not\(\[src\]\)'\)/);
    assert.match(loaderHtml, /codigo\.includes\('const socketWeb = io\(\);'\)/);
    assert.match(loaderHtml, /parsed\.querySelectorAll\('script'\)\.forEach\(script => script\.remove\(\)\)/);
    assert.match(loaderHtml, /document\.body\.replaceChildren\(/);
    assert.match(loaderHtml, /script\.textContent = scriptPrincipal/);
});

test('BUG-017: seletores e card de sinal continuam ligados ao ciclo principal da aplicacao', () => {
    assert.match(appHtml, /const socketWeb = io\(\);/);
    assert.match(appHtml, /socketWeb\.on\('alerta_painel', \(dados\) => \{/);

    assert.match(appHtml, /fetch\('\/api\/estrategias'\+q\)/);
    assert.match(appHtml, /fetch\('\/api\/origens'\+q\)/);
    assert.match(appHtml, /fetch\('\/api\/robos\?_t=' \+ Date\.now\(\)\)/);
    assert.match(appHtml, /document\.getElementById\('select-origem-filtro'\)\.innerHTML = ops/);
    assert.match(appHtml, /document\.getElementById\('select-origem-dash'\)\.innerHTML = ops/);
    assert.match(appHtml, /renderizarCardsRobos\(\); atualizarFiltrosRoboUI\(\); await atualizarDashboardValores\(\)/);
    assert.match(appHtml, /sintonizador\.innerHTML = '<option value="TODOS">Todos os Robôs<\/option>' \+/);
    assert.match(appHtml, /filtroDash\.innerHTML = '<option value="TODOS">🤖 Todos os Robôs<\/option>' \+/);

    assert.match(appHtml, /document\.getElementById\('conteudo-card-ativo'\)\.innerHTML = gerarHtmlCardEstrategia\(est, 'ativo', dashPeriodoAtual\)/);
    assert.match(appHtml, /document\.getElementById\('container-card-ativo'\)\.style\.display = 'block'/);
});

test('UX-002/003: aprimoramentos carregam depois do JavaScript principal sem alterar o bootstrap', () => {
    const posPrincipal = loaderHtml.indexOf('script.textContent = scriptPrincipal');
    const posEnhancements = loaderHtml.indexOf("enhancements.src = '/ui-enhancements.js?_t='");
    assert.ok(posPrincipal >= 0);
    assert.ok(posEnhancements > posPrincipal);
    assert.match(loaderHtml, /window\.aplicarAprimoramentosUI\(\)/);
    assert.match(enhancementsJs, /window\.renderizarCardsRobos\s*=\s*renderizarCardsRobosAprimorado/);
    assert.match(enhancementsJs, /window\.mudarPeriodoCardRobo\s*=\s*mudarPeriodoCardRobo/);
    assert.match(enhancementsJs, /Maior sequência Green/);
    assert.match(enhancementsJs, /Maior sequência Red/);
    for (const periodo of ['24h', 'hoje', 'semana', 'mes', 'geral']) {
        assert.match(enhancementsJs, new RegExp(`\\b${periodo === '24h' ? "'24h'" : periodo}\\b`));
    }
});

test('BUG-016: filtros do dashboard chamam funções globais implementadas', () => {
    assert.match(appHtml, /onchange=["']mudarFiltrosDash\(\)["']/);
    for (const periodo of ['24h', 'hoje', 'semana', 'mes', 'geral']) {
        assert.match(appHtml, new RegExp(`onclick=["']mudarDashGeral\\('${periodo}'\\)["']`));
    }

    assert.match(dashboardJs, /window\.atualizarDashboardValores\s*=\s*atualizarDashboardValores/);
    assert.match(dashboardJs, /window\.mudarDashGeral\s*=\s*mudarDashGeral/);
    assert.match(dashboardJs, /window\.mudarFiltrosDash\s*=\s*mudarFiltrosDash/);
});

test('UX-003: período consulta robô + origem e atualiza sinais, greens, reds, empates e sequências', async () => {
    const urls = [];
    const { sandbox, elementos } = criarSandboxDashboard(async url => {
        urls.push(String(url));
        return {
            ok: true,
            async json() {
                return {
                    sinais: 8,
                    greens: 6,
                    reds: 2,
                    ties: 2,
                    max_green_seq: 4,
                    max_red_seq: 2,
                    assertividade: '75.0%'
                };
            }
        };
    });

    await sandbox.window.mudarDashGeral('mes');

    assert.equal(urls.length, 1);
    const chamada = new URL(urls[0], 'http://localhost');
    assert.equal(chamada.pathname, '/api/dashboard-stats');
    assert.equal(chamada.searchParams.get('robo_id'), '42');
    assert.equal(chamada.searchParams.get('origem'), 'Origem VIP');
    assert.equal(chamada.searchParams.get('periodo'), 'mes');

    assert.equal(elementos['dash-sinais'].innerText, 8);
    assert.equal(elementos['dash-greens'].innerText, 6);
    assert.equal(elementos['dash-reds'].innerText, 2);
    assert.equal(elementos['dash-ties'].innerText, 2);
    assert.equal(elementos['dash-max-green'].innerText, '✅ 4');
    assert.equal(elementos['dash-max-red'].innerText, '❌ 2');
    assert.equal(elementos['dash-assertividade'].innerText, '75.0%');
    assert.equal(elementos['btn-dash-mes'].style.background, '#007bff');
    assert.equal(elementos['btn-dash-mes'].atributos['aria-pressed'], 'true');
    assert.equal(elementos['btn-dash-24h'].atributos['aria-pressed'], 'false');
});

test('BUG-016: troca de robô/origem reaproveita o período selecionado', async () => {
    const urls = [];
    const { sandbox, elementos } = criarSandboxDashboard(async url => {
        urls.push(String(url));
        return { ok: true, json: async () => ({ sinais: 1, greens: 1, reds: 0, ties: 0, max_green_seq: 1, max_red_seq: 0, assertividade: '100.0%' }) };
    });

    await sandbox.window.mudarDashGeral('semana');
    elementos['select-robo-dash'].value = '7';
    elementos['select-origem-dash'].value = 'Outra Origem';
    await sandbox.window.mudarFiltrosDash();

    const chamada = new URL(urls.at(-1), 'http://localhost');
    assert.equal(chamada.searchParams.get('robo_id'), '7');
    assert.equal(chamada.searchParams.get('origem'), 'Outra Origem');
    assert.equal(chamada.searchParams.get('periodo'), 'semana');
});

test('UX-003: falha de API não é apresentada como falso zero também nos novos indicadores', async () => {
    const { sandbox, elementos } = criarSandboxDashboard(async () => ({ ok: false, status: 500 }));
    await sandbox.window.atualizarDashboardValores();

    assert.equal(elementos['dash-sinais'].innerText, '—');
    assert.equal(elementos['dash-greens'].innerText, '—');
    assert.equal(elementos['dash-reds'].innerText, '—');
    assert.equal(elementos['dash-ties'].innerText, '—');
    assert.equal(elementos['dash-max-green'].innerText, '✅ —');
    assert.equal(elementos['dash-max-red'].innerText, '❌ —');
    assert.equal(elementos['dash-assertividade'].innerText, '—');
});

test('UX-002/003: backend usa histórico real e expõe empates e máximas de sequência', () => {
    assert.match(backend, /app\.get\("\/api\/dashboard-stats"/);
    assert.match(backend, /FROM\s+historico_disparos_robos\s+h/);
    assert.match(backend, /h\.robo_id\s*=\s*\?/);
    assert.match(backend, /h\.estrategia_origem\s*=\s*\?/);
    assert.match(backend, /max_green_seq/);
    assert.match(backend, /max_red_seq/);
    assert.match(backend, /ties/);
});
