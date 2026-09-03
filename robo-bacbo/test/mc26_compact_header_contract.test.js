'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const switcher = fs.readFileSync(path.join(root, 'public', 'mesa-switcher.js'), 'utf8');

test('MC26: switcher deixa de ocupar uma faixa propria e monta junto ao titulo', () => {
    assert.match(switcher, /function montarHeaderCompacto\(mesa\)/);
    assert.match(switcher, /const headerTitulo = header\?\.querySelector\('h1'\)/);
    assert.match(switcher, /switcher\.className = 'mc26-mesa-inline'/);
    assert.match(switcher, /headerTitulo\.insertBefore\(switcher, versao\.nextSibling\)/);
    assert.doesNotMatch(switcher, /className = 'mc25-mesa-strip'/);
    assert.match(switcher, /\.topo-header > h1 \{/);
    assert.match(switcher, /flex: 1 1 100%/);
});

test('MC26: identidade e status financeiro ficam compactos e semanticamente claros', () => {
    assert.match(switcher, /class="mc26-mesa-codigo"/);
    assert.match(switcher, /class="mc26-mesa-financeiro"/);
    assert.match(switcher, /BACBO_INT[\s\S]*?financeiro:\s*true/);
    assert.match(switcher, /BACBO_BR[\s\S]*?financeiro:\s*true/);
    assert.match(switcher, /💰 Ativo/);
    assert.match(switcher, /--mc26-mesa-accent: #28a745/);
    assert.match(switcher, /--mc26-mesa-accent: #f59e0b/);
    assert.match(switcher, /aria-label="Alternar mesa operacional"/);
});

test('MC26: navegacao principal usa nomes curtos solicitados', () => {
    assert.match(switcher, /'nav-btn-dashboard': '📊 Dashboard'/);
    assert.match(switcher, /'nav-btn-padroes': '⚙️ Padrões'/);
    assert.match(switcher, /'nav-btn-robos': '🤖 Robôs'/);
    assert.match(switcher, /botao\.textContent = '💸 Trader'/);
    assert.match(switcher, /'nav-btn-backtest': '🔬 Backtest'/);
    assert.match(switcher, /botao\.textContent = '🔮 Oráculo'/);
});

test('MC26: Oraculo tardio recebe rotulo compacto sem alterar seu carregamento', () => {
    assert.match(switcher, /function observarRotuloOraculo\(\)/);
    assert.match(switcher, /new MutationObserver\(/);
    assert.match(switcher, /document\.getElementById\('nav-btn-oraculo'\)/);
    assert.match(switcher, /observer\.disconnect\(\)/);
});

test('MC26: compactacao nao altera a mecanica de troca de runtime', () => {
    assert.match(switcher, /url\.port = destino\.porta/);
    assert.match(switcher, /window\.location\.assign\(url\.toString\(\)\)/);
    assert.match(switcher, /function detectarMesaAtual\(\)/);
    assert.match(switcher, /Object\.values\(MESAS\)\.find\(mesa => mesa\.porta === porta\)/);
    assert.match(switcher, /void trocarMesa\(event\.target\.value\)/);
    assert.doesNotMatch(switcher, /definirMesaRuntime/);
    assert.doesNotMatch(switcher, /BACBO_MESA_CODIGO\s*=/);
});
