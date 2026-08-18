const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const dashboardJs = fs.readFileSync(path.join(root, 'public', 'dashboard-ui.js'), 'utf8');
const backend = fs.readFileSync(path.join(root, 'bot2_coletor.js'), 'utf8');

test('BUG-016: index carrega o controlador do Resumo Executivo', () => {
    assert.match(html, /<script\s+src=["']\/dashboard-ui\.js["']><\/script>/);
});

test('BUG-016: filtros do dashboard chamam funções globais implementadas', () => {
    assert.match(html, /onchange=["']mudarFiltrosDash\(\)["']/);
    for (const periodo of ['24h', 'hoje', 'semana', 'mes', 'geral']) {
        assert.match(html, new RegExp(`onclick=["']mudarDashGeral\\('${periodo}'\\)["']`));
    }

    assert.match(dashboardJs, /window\.atualizarDashboardValores\s*=\s*atualizarDashboardValores/);
    assert.match(dashboardJs, /window\.mudarDashGeral\s*=\s*mudarDashGeral/);
    assert.match(dashboardJs, /window\.mudarFiltrosDash\s*=\s*mudarFiltrosDash/);
});

test('BUG-016: frontend envia robô, origem e período ao endpoint real', () => {
    assert.match(dashboardJs, /\/api\/dashboard-stats\?\$\{params\.toString\(\)\}/);
    assert.match(dashboardJs, /params\.set\('robo_id',\s*roboId\)/);
    assert.match(dashboardJs, /params\.set\('periodo',\s*periodo\)/);
    assert.match(dashboardJs, /params\.set\('origem',\s*origem\)/);
});

test('BUG-016: dashboard de disparos reais continua ligado ao histórico por robô', () => {
    assert.match(backend, /app\.get\("\/api\/dashboard-stats"/);
    assert.match(backend, /FROM\s+historico_disparos_robos\s+h/);
    assert.match(backend, /h\.robo_id\s*=\s*\?/);
    assert.match(backend, /h\.estrategia_origem\s*=\s*\?/);
});
