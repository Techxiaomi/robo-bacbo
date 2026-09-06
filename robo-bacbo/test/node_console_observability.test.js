'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.BACBO_MESA_CODIGO =
    'BACBO_INT';

const formatter =
    require('../operational_log_formatter');


test(
    'mesa INT usa BAC BO INT',
    () => {
        assert.equal(
            formatter.MESA_CODIGO,
            'BACBO_INT'
        );

        assert.equal(
            formatter.MESA_DISPLAY,
            'BAC BO INT'
        );

        assert.match(
            formatter.NODE_AUDIT_FILE,
            /node-console\.audit\.BACBO_INT\.jsonl$/
        );
    }
);


test(
    'READY true e INSTALLED true sao somente audit',
    () => {
        const casos = [
            'TABLE_FINANCIAL_RULES_GUARD_READY=true',
            'AUTO_TRADER_STRUCTURAL_INTEGRITY_READY=true',
            'MULTI_ACCOUNT_FINANCIAL_AUTHORIZATION_INSTALLED=true table=bacbo_int',
            'CONTINUOUS_BALANCE_READY=true table=bacbo_int pattern=x'
        ];

        for (const linha of casos) {
            assert.equal(
                formatter.suprimirInicializacaoTecnica(
                    'log',
                    [linha]
                ),
                true
            );
        }
    }
);


test(
    'false permanece visivel',
    () => {
        assert.equal(
            formatter.suprimirInicializacaoTecnica(
                'log',
                [
                    'TABLE_FINANCIAL_RULES_GUARD_READY=false'
                ]
            ),
            false
        );
    }
);


test(
    'warn e error permanecem visiveis',
    () => {
        assert.equal(
            formatter.suprimirInicializacaoTecnica(
                'warn',
                [
                    'TEST_READY=true'
                ]
            ),
            false
        );

        assert.equal(
            formatter.suprimirInicializacaoTecnica(
                'error',
                [
                    'TEST_INSTALLED=true'
                ]
            ),
            false
        );
    }
);


test(
    'texto indicando falha nao e suprimido',
    () => {
        assert.equal(
            formatter.suprimirInicializacaoTecnica(
                'log',
                [
                    'TEST_READY=true warning'
                ]
            ),
            false
        );

        assert.equal(
            formatter.suprimirInicializacaoTecnica(
                'log',
                [
                    'TEST_READY=true falha'
                ]
            ),
            false
        );
    }
);


test(
    'rodada segue padrao BAC BO INT',
    () => {
        assert.equal(
            formatter.prefixarIdentidadeNode(
                '\u{1F3B2} #00001 | 12:00:00 | JOGADOR | Soma: 7'
            ),
            '\u{1F3B2} BAC BO INT | #00001 | 12:00:00 | JOGADOR | Soma: 7'
        );
    }
);


test(
    'painel fica compacto',
    () => {
        assert.equal(
            formatter.prefixarIdentidadeNode(
                '\u{1F310} Painel Web rodando em http://127.0.0.1:3000'
            ),
            '\u{1F310} BAC BO INT | PAINEL | http://127.0.0.1:3000'
        );
    }
);


test(
    'webhook fica compacto',
    () => {
        assert.equal(
            formatter.prefixarIdentidadeNode(
                '\u{1F3A7} Webhook aguardando sinais em: http://127.0.0.1:3000/receber-sinal'
            ),
            '\u{1F3A7} BAC BO INT | WEBHOOK | aguardando sinais | http://127.0.0.1:3000/receber-sinal'
        );
    }
);


test(
    'historico analitico fica compacto',
    () => {
        assert.equal(
            formatter.prefixarIdentidadeNode(
                '\u{1F4CA} Hist\u00F3rico anal\u00EDtico carregado: 114565 giros.'
            ),
            '\u{1F4CA} BAC BO INT | HIST\u00D3RICO | 114565 giros carregados'
        );
    }
);


test(
    'continuidade critica recebe mesa',
    () => {
        const entrada = [
            '\u{1F6A8} CR\u00CDTICO | CONTINUIDADE',
            '   Motivo: COLETOR_REINICIADO',
            '   Sinais invalidados: 0',
            '   Traders bloqueados: 0'
        ].join('\n');

        const saida =
            formatter.prefixarIdentidadeNode(
                entrada
            );

        assert.match(
            saida,
            /^\u{1F6A8} BAC BO INT \| CONTINUIDADE/u
        );

        assert.match(
            saida,
            /COLETOR_REINICIADO/
        );
    }
);


test(
    'memoria identica consecutiva e omitida',
    () => {
        const memoria =
            '\u{1F9E9} BAC BO INT | MEM\u00D3RIA | Estrat\u00E9gias: 68 | Rob\u00F4s: 3 | Auto-Traders: 0';

        formatter.deduplicarMemoriaVisual(
            ['RESET']
        );

        assert.deepEqual(
            formatter.deduplicarMemoriaVisual(
                [memoria]
            ),
            [memoria]
        );

        assert.deepEqual(
            formatter.deduplicarMemoriaVisual(
                [memoria]
            ),
            []
        );
    }
);


test(
    '72 para 68 permanece visivel',
    () => {
        const a =
            '\u{1F9E9} BAC BO INT | MEM\u00D3RIA | Estrat\u00E9gias: 72 | Rob\u00F4s: 3 | Auto-Traders: 0';

        const b =
            '\u{1F9E9} BAC BO INT | MEM\u00D3RIA | Estrat\u00E9gias: 68 | Rob\u00F4s: 3 | Auto-Traders: 0';

        formatter.deduplicarMemoriaVisual(
            ['RESET']
        );

        assert.deepEqual(
            formatter.deduplicarMemoriaVisual(
                [a]
            ),
            [a]
        );

        assert.deepEqual(
            formatter.deduplicarMemoriaVisual(
                [b]
            ),
            [b]
        );
    }
);


test(
    'outro evento quebra consecutividade',
    () => {
        const memoria =
            '\u{1F9E9} BAC BO INT | MEM\u00D3RIA | Estrat\u00E9gias: 68 | Rob\u00F4s: 3 | Auto-Traders: 0';

        formatter.deduplicarMemoriaVisual(
            ['RESET']
        );

        formatter.deduplicarMemoriaVisual(
            [memoria]
        );

        assert.deepEqual(
            formatter.deduplicarMemoriaVisual(
                ['OUTRO EVENTO']
            ),
            ['OUTRO EVENTO']
        );

        assert.deepEqual(
            formatter.deduplicarMemoriaVisual(
                [memoria]
            ),
            [memoria]
        );
    }
);


test(
    'evento desconhecido continua fail-open',
    () => {
        const original =
            'EVENTO_FUTURO payload=123';

        assert.equal(
            formatter.prefixarIdentidadeNode(
                original
            ),
            original
        );

        assert.deepEqual(
            formatter.formatarChamadaConsole(
                'warn',
                [original]
            ),
            [original]
        );
    }
);


test(
    'normalizacao de acentos e deterministica',
    () => {
        assert.equal(
            formatter.normalizarAsciiOperacional(
                'Hist\u00F3rico anal\u00EDtico'
            ),
            'Historico analitico'
        );

        assert.equal(
            formatter.normalizarAsciiOperacional(
                'CR\u00CDTICO'
            ),
            'CRITICO'
        );
    }
);
