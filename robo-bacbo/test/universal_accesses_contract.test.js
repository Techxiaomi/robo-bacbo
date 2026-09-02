'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const repoRoot = path.join(root, '..');

const server = fs.readFileSync(path.join(root, 'scripts', 'betting_house_api_dev_server.js'), 'utf8');
const riskObservability = fs.readFileSync(path.join(root, 'risk_policy_observability.js'), 'utf8');
const riskCaps = fs.readFileSync(path.join(root, 'technical_risk_caps.js'), 'utf8');
const traderScope = fs.readFileSync(path.join(root, 'signal_router_trader_scope.js'), 'utf8');
const accessLink = fs.readFileSync(path.join(root, 'public', 'universal-access-link.js'), 'utf8');
const accessPage = fs.readFileSync(path.join(root, 'public', 'accesses.html'), 'utf8');
const index = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const dashboard = fs.readFileSync(path.join(root, 'public', 'dashboard-app.html'), 'utf8');
const launcher = fs.readFileSync(path.join(repoRoot, 'atalhos', '91_FINANCEIRO_ABAS.cmd'), 'utf8');
const signalRouterLauncher = fs.readFileSync(path.join(repoRoot, 'atalhos', '07_SIGNAL_ROUTER.cmd'), 'utf8');
const stopScript = fs.readFileSync(path.join(repoRoot, 'atalhos', 'Stop-Sistema.ps1'), 'utf8');
const accessShortcut = fs.readFileSync(path.join(repoRoot, 'atalhos', '92_ACESSOS.cmd'), 'utf8');

test('portal universal usa somente a porta administrativa 3010', () => {
    assert.match(server, /BETTING_HOUSE_API_DEV_PORT \|\| 3010/);
    assert.match(server, /app\.get\('\/accesses'/);
    assert.match(server, /app\.get\('\/betting-houses'/);
    assert.match(server, /app\.get\('\/supervisor'/);
    assert.match(accessShortcut, /127\.0\.0\.1:3010\/accesses/);
    assert.doesNotMatch(accessShortcut, /:3000|:3001/);
});

test('portal agrega Casas Contas e Processos de Traders', () => {
    assert.match(accessPage, /Casas e Contas/);
    assert.match(accessPage, /Processos de Traders/);
    assert.match(accessPage, /href="\/betting-houses"/);
    assert.match(accessPage, /href="\/supervisor"/);
});

test('cabecalho usa somente icones na ordem audio configuracoes acessos', () => {
    assert.match(dashboard, /id="btn-som"[^>]*>🔊<\/span>/);
    assert.match(dashboard, /class="gear-icon spin"[^>]*>⚙️<\/span>/);
    assert.match(accessLink, /link\.textContent = '🔒'/);
    assert.doesNotMatch(accessLink, /🔐 Acessos/);
    assert.match(accessLink, /speaker\.title = 'Áudio'/);
    assert.match(accessLink, /gear\.title = 'Configurações'/);
    assert.match(accessLink, /link\.title = 'Acessos'/);
    assert.match(accessLink, /title\.insertBefore\(link, gear\.nextSibling\)/);
});

test('link discreto do painel abre Acessos em nova aba', () => {
    assert.match(accessLink, /http:\/\/127\.0\.0\.1:3010\/accesses/);
    assert.match(accessLink, /link\.target = '_blank'/);
    assert.match(accessLink, /link\.rel = 'noopener'/);
    assert.match(accessLink, /link\.className = 'gear-icon universal-access-icon'/);
    assert.match(index, /\/universal-access-link\.js/);
    assert.match(index, /__universalAccessLink\.install\(\)/);
});

test('stack completa inclui aba Acessos e encerramento cobre porta 3010', () => {
    assert.match(launcher, /08_ACESSOS_SERVER\.cmd/);
    assert.match(launcher, /--title "Acessos"/);
    assert.match(stopScript, /08_ACESSOS_SERVER\.cmd/);
    assert.match(stopScript, /3010/);
    assert.match(stopScript, /betting_house_api_dev_server/);
});

test('Acessos expoe somente status e desarme financeiro fail-closed', () => {
    assert.match(server, /app\.get\('\/api\/financial-safety\/status'/);
    assert.match(server, /app\.post\('\/api\/financial-safety\/disarm'/);
    assert.match(server, /auto-trader\.arm/);
    assert.match(server, /Disarm-AutoTrader\.ps1/);
    assert.match(server, /runtimeMustStop/);
    assert.match(server, /scheduleRuntimeDisarm\(\)/);

    assert.match(accessPage, /Segurança Financeira/);
    assert.match(accessPage, /BLOQUEAR EXECUÇÃO/);
    assert.match(accessPage, /\/api\/financial-safety\/status/);
    assert.match(accessPage, /\/api\/financial-safety\/disarm/);
    assert.match(accessPage, /não pode habilitá-la/);

    assert.doesNotMatch(server, /financial-safety\/arm/);
    assert.doesNotMatch(accessPage, /HABILITAR EXECUÇÃO/);
});

test('status financeiro aceita session.json PowerShell com BOM e usa rotulos claros', () => {
    assert.match(server, /function stripUtf8Bom\(text\)/);
    assert.match(server, /replace\(\/\^\\uFEFF\//);
    assert.match(server, /JSON\.parse\(stripUtf8Bom\(rawSession\)\)/);

    assert.match(accessPage, /Execução atual/);
    assert.match(accessPage, /Próxima inicialização/);
    assert.match(accessPage, /Verificação/);
    assert.match(accessPage, /✅ BLOQUEADA/);
    assert.match(accessPage, /✅ CONFIRMADA/);
    assert.match(accessPage, /SESSÃO ILEGÍVEL — FAIL-CLOSED/);
});

test('Acessos expoe hierarquia SSOT de risco com origens explicitas', () => {
    assert.match(server, /readRiskPolicyObservability/);
    assert.match(server, /app\.get\('\/api\/financial-safety\/risk-policy'/);
    assert.match(riskObservability, /getTechnicalRiskCaps/);
    assert.match(riskObservability, /resolveRiskPolicy/);
    assert.match(riskObservability, /auto_traders\.config_json/);
    assert.match(riskObservability, /robo-bacbo\/technical_risk_caps\.js/);
    assert.match(riskObservability, /07_SIGNAL_ROUTER\.cmd/);
    assert.match(riskCaps, /global_router_cap:\s*20\.00/);
    assert.match(riskCaps, /per_bridge_cap:\s*5\.00/);

    assert.match(accessPage, /Política de Risco \/ Hierarquia SSOT/);
    assert.match(accessPage, /Cap por Live Bridge/);
    assert.match(accessPage, /Cap global do Router/);
    assert.match(accessPage, /Stop Loss/);
    assert.match(accessPage, /Stop Win/);
    assert.match(accessPage, /DRY RUN ATIVO/);
    assert.match(accessPage, /\/api\/financial-safety\/risk-policy/);
    assert.match(accessPage, /escapeHtml/);
});

test('observabilidade permanece fail-closed se DRY RUN nao puder ser confirmado', () => {
    assert.match(riskObservability, /DRY_RUN_SETTING_NOT_FOUND/);
    assert.match(riskObservability, /DRY_RUN_LAUNCHER_UNREADABLE/);
    assert.match(riskObservability, /real_dispatch_blocked:\s*dryRunLocked/);
    assert.match(riskObservability, /fail_closed:\s*!dryRunLocked \|\| invalidTraderPolicy/);
    assert.match(signalRouterLauncher, /SIGNAL_ROUTER_FINANCIAL_DRY_RUN=true/);
    assert.doesNotMatch(signalRouterLauncher, /SIGNAL_ROUTER_FINANCIAL_DRY_RUN=false/);
});

test('Router mantém log explicito RISK_POLICY_HIERARCHY', () => {
    assert.match(traderScope, /RISK_POLICY_HIERARCHY/);
    assert.match(traderScope, /trader_stop_loss=/);
    assert.match(traderScope, /trader_stop_win=/);
    assert.match(traderScope, /technical_global_cap=/);
    assert.match(traderScope, /technical_bridge_cap=/);
    assert.match(traderScope, /per_account_exposure=/);
    assert.match(traderScope, /aggregate_exposure=/);
});
