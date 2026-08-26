'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root =
    path.join(__dirname, '..');

const bot =
    fs.readFileSync(
        path.join(
            root,
            'bot2_coletor.js'
        ),
        'utf8'
    );

const dashboard =
    fs.readFileSync(
        path.join(
            root,
            'public',
            'dashboard-app.html'
        ),
        'utf8'
    );

test(
    'MC19: ativacao usa saldo fresco ou solicita sync Redis',
    () => {
        assert.match(
            bot,
            /async function obterSaldoAutoTraderParaAtivacao\(\)/
        );

        assert.match(
            bot,
            /const saldoJaFresco = obterSaldoGlobalFresco\(\)/
        );

        assert.match(
            bot,
            /await solicitarSincronizacaoSaldoRedis\(\)/
        );

        assert.match(
            bot,
            /const saldoConfirmado\s*=\s*obterSaldoGlobalFresco\(\)/
        );
    }
);

test(
    'MC19: saldo persistido nunca vira fallback de ativacao',
    () => {
        const helperMatch =
            bot.match(
                /async function obterSaldoAutoTraderParaAtivacao\(\)[\s\S]*?\n\}/
            );

        assert.ok(
            helperMatch,
            'helper MC19 não localizado'
        );

        const helper =
            helperMatch[0];

        assert.doesNotMatch(
            helper,
            /saldo_inicial|saldo_atual\s+FROM\s+auto_traders/i
        );

        assert.match(
            helper,
            /saldo:\s*null/
        );
    }
);

test(
    'MC19: falha de sync mantem ativacao fail-closed',
    () => {
        assert.match(
            bot,
            /O Auto-Trader permaneceu desligado/
        );

        const gates =
            bot.match(
                /await obterSaldoAutoTraderParaAtivacao\(\)/g
            ) || [];

        assert.equal(
            gates.length,
            2,
            'POST e reativação PUT devem compartilhar o mesmo gate'
        );

        assert.match(
            bot,
            /erro:\s*'saldo_global_indisponivel'/
        );
    }
);

test(
    'MC19: reativacao recaptura baseline somente apos gate aprovado',
    () => {
        assert.match(
            bot,
            /const saldoFresco = gateSaldo\.saldo/
        );

        assert.match(
            bot,
            /SET nome=\?, ativo=true, config_json=\?, saldo_inicial=\?, saldo_atual=\?/
        );

        assert.match(
            bot,
            /status_operacao='STANDBY'/
        );
    }
);

test(
    'MC19: switch fica bloqueado enquanto backend sincroniza',
    () => {
        assert.match(
            dashboard,
            /async function toggleAutoTraderRapido\(id, check\)/
        );

        assert.match(
            dashboard,
            /check\.disabled = true/
        );

        assert.match(
            dashboard,
            /slider\.style\.cursor = 'wait'/
        );

        assert.match(
            dashboard,
            /check\.checked\s*=\s*!novoAtivo/
        );

        assert.match(
            dashboard,
            /finally\s*\{[\s\S]*?check\.disabled = false/
        );
    }
);

test(
    'MC19: resposta informa se houve sincronizacao na ativacao',
    () => {
        const ocorrencias =
            bot.match(
                /saldo_sincronizado_agora:\s*saldoSincronizadoAgora/g
            ) || [];

        assert.equal(
            ocorrencias.length,
            2
        );
    }
);
