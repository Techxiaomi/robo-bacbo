'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');

const {
    formatarTexto,
    registrarSinalOperacional,
    formatarChamadaConsole,
    detalheSql
}=require('../operational_log_formatter');

test('visual: rodada, supressão e shadow',()=>{
    const r=formatarTexto(
        '🔄 Mapeamento BacBo -> IA | uuid=11111111-1111-4111-8111-111111111111 | type=PLAYER -> interno=Player | simbolo=P | soma=11'
    );

    assert.match(
        r,
        /^🎲 #00001 \| \d{2}:\d{2}:\d{2} \| JOGADOR \| Soma: 11$/
    );

    assert.equal(
        formatarTexto(
            '🔒 Sinal padrao_1786475073874 suprimido: nenhum robô livre para novo ciclo.'
        ),
        '   🔒 SUPRIMIDO | #00001 | padrao_1786475073874 | Nenhum robô livre'
    );

    assert.equal(
        formatarTexto(
            '👻 Shadow Live ia_12_693d953bfeefba7bba: 1/2 ocorrência(s), assert=100.0%, Wilson=20.7%, pendente (1 restante(s)).'
        ),
        '   👻 SHADOW | #00001 | IA 12 | 1/2 | Assert: 100.0% | Wilson: 20.7% | Restam: 1'
    );
});

test('visual: sinal e Telegram',()=>{
    let got=null;

    const old=
        console.log;

    console.log=
        (...a)=>{
            got=a.join(' ');
        };

    try {
        registrarSinalOperacional({
            tipo:'ENTRADA',
            robosNotificados:[
                {id:7}
            ],
            padrao:[
                'Player',
                'Player',
                'Banker'
            ],
            entrada:'Banker'
        });
    } finally {
        console.log=old;
    }

    assert.equal(
        got,
        '\n🎯 SINAL | Robô 7 | P-P-B → B\n'
        + '   └─ Entrada: BANCA'
    );

    assert.equal(
        formatarTexto(
            '📨 Robô 7: Telegram confirmado em 1/1 destino(s).'
        ),
        '📨 TELEGRAM | Robô 7 | CONFIRMADO | Destinos: 1/1'
    );
});

test('SQL: ETIMEDOUT catalogado',()=>{
    const s=
        formatarChamadaConsole(
            'error',
            [
                '⚠️ Schema bacbo_rounds não inicializou no bootstrap:',
                'connect ETIMEDOUT'
            ]
        );

    assert.equal(
        s.length,
        1
    );

    assert.match(
        s[0],
        /SQL \| INDISPONÍVEL \| BACBO_ROUNDS/
    );

    assert.match(
        s[0],
        /Código: ETIMEDOUT/
    );
});

test('SQL: fatal preserva Error e stack',()=>{
    const e=
        new Error(
            'connect ETIMEDOUT'
        );

    e.code=
        'ETIMEDOUT';

    const s=
        formatarChamadaConsole(
            'error',
            [
                '🔥 Inicialização do backend falhou; encerrando processo em modo seguro:',
                e
            ]
        );

    assert.equal(
        s.length,
        2
    );

    assert.match(
        s[0],
        /BACKEND ENCERRADO EM MODO SEGURO/
    );

    assert.equal(
        s[1],
        e
    );
});

test('segurança: warn/error desconhecido não é reclassificado',()=>{
    const w=
        '⚠️ Mensagem futura não catalogada.';

    const e=
        '❌ Falha futura não catalogada.';

    assert.deepEqual(
        formatarChamadaConsole(
            'warn',
            [w]
        ),
        [w]
    );

    assert.deepEqual(
        formatarChamadaConsole(
            'error',
            [e]
        ),
        [e]
    );
});

test('SQL: limite de conexões reconhecido',()=>{
    const d=
        detalheSql([
            {
                code:'ER_CON_COUNT_ERROR',
                message:'Too many connections'
            }
        ]);

    assert.equal(
        d.codigo,
        'ER_CON_COUNT_ERROR'
    );

    assert.match(
        d.motivo,
        /limite de conexões/i
    );
});

test(
    'MC13: memória operacional vira uma linha compacta',
    () => {
        const bloco = [
            '',
            '📂 MEMÓRIA ALOCADA COM SUCESSO:',
            '   - Estratégias Ativas: 38',
            '   - Robôs de Canal: 3',
            '   - Motores Auto-Trader: 0',
            ''
        ].join('\n');

        assert.deepEqual(
            formatarChamadaConsole(
                'log',
                [bloco]
            ),
            [
                '🧩 MEMÓRIA | Estratégias: 38 | Robôs: 3 | Auto-Traders: 0'
            ]
        );
    }
);

test(
    'MC13: resumo do pool IA fica compacto',
    () => {
        assert.deepEqual(
            formatarChamadaConsole(
                'log',
                [
                    '🧠 Auto Pilot IA 7: 12 ativo(s), 0 reserva(s), 20 sombra.'
                ]
            ),
            [
                '🧠 IA 7 | Pool: 12 ativos | 0 reservas | 20 sombra'
            ]
        );
    }
);

test(
    'MC13: descarte live vira evento operacional curto',
    () => {
        assert.deepEqual(
            formatarChamadaConsole(
                'warn',
                [
                    '🗑️ Auto Pilot IA: padrão ia_7_4d5fb6f8d455faee41 desativado imediatamente por DROP_ASSERT (assertividade live=80.0%, streak RED=0).'
                ]
            ),
            [
                '🗑️ IA 7 | DROP_ASSERT | padrão=ia_7_4d5fb6f8d455faee41 | live=80.0% | streak RED=0'
            ]
        );
    }
);

test(
    'MC13: revalidação live omite ranking completo e mantém pool',
    () => {
        const bloco = [
            '',
            '🧠 AUTO PILOT IA 7 — DESCARTE_LIVE:DROP_ASSERT',
            '   Janela: 1000 | treino: 800 | validação histórica: 200',
            '   Padrões únicos: 231 | combinações avaliadas: 462',
            '   Reprovados: ocorrências=312, assertividade=109, shadow histórico=23',
            '   Blacklist configurada: 0',
            '   Pool: 12/20 ativos | 0 reservas | 20 shadow histórico | 0 shadow live | 0 rejeitados live | 9 fora do pool',
            '   🏆 ATIVOS',
            '      #1 P-P-B-P → P | score=85.1 | assert=97.0% | n=33 | Wilson=84.7%',
            '      #2 T-B-P → B | score=80.4 | assert=100.0% | n=12 | Wilson=75.7%'
        ].join('\n');

        const saida =
            formatarChamadaConsole(
                'log',
                [bloco]
            );

        assert.deepEqual(
            saida,
            [
                '🧠 IA 7 | DESCARTE_LIVE:DROP_ASSERT | Pool 12/20 | Reservas 0 | Shadow H/L 20/0 | Rejeitados 0 | Fora 9'
            ]
        );

        assert.doesNotMatch(
            saida[0],
            /🏆|#1|score=/
        );
    }
);

test(
    'MC13: STARTUP da IA fica compacto no console',
    () => {
        const bloco = [
            '',
            '\u{1F9E0} AUTO PILOT IA 12 \u2014 STARTUP',
            '   Janela: 1000 | treino: 800 | valida\u00E7\u00E3o hist\u00F3rica: 200',
            '   Pool: 3/40 ativos | 0 reservas | 18 shadow hist\u00F3rico | 1 shadow live | 1 rejeitados live | 1 fora do pool',
            '   \u{1F3C6} ATIVOS',
            '      #1 P-P-T \u2192 P | score=71.7 | assert=91.3% | n=23 | Wilson=73.2%'
        ].join('\n');

        assert.deepEqual(
            formatarChamadaConsole(
                'log',
                [bloco]
            ),
            [
                '\u{1F9E0} IA 12 | STARTUP | Pool 3/40 | Reservas 0 | Shadow H/L 18/1 | Rejeitados 1 | Fora 1'
            ]
        );
    }
);

test(
    'MC13: bloco IA desconhecido permanece literal',
    () => {
        const bloco =
            '🧠 AUTO PILOT EXPERIMENTAL | formato futuro sem contrato';

        assert.deepEqual(
            formatarChamadaConsole(
                'warn',
                [bloco]
            ),
            [bloco]
        );
    }
);

test(
    'MC13 real: quatro console.log de memória viram uma linha',
    () => {
        assert.equal(
            formatarChamadaConsole(
                'log',
                [
                    '\n📂 MEMÓRIA ALOCADA COM SUCESSO:'
                ]
            ),
            null
        );

        assert.equal(
            formatarChamadaConsole(
                'log',
                [
                    '   - Estratégias Ativas: 38'
                ]
            ),
            null
        );

        assert.equal(
            formatarChamadaConsole(
                'log',
                [
                    '   - Robôs de Canal: 3'
                ]
            ),
            null
        );

        assert.deepEqual(
            formatarChamadaConsole(
                'log',
                [
                    '   - Motores Auto-Trader: 0\n'
                ]
            ),
            [
                '🧩 MEMÓRIA | Estratégias: 38 | Robôs: 3 | Auto-Traders: 0'
            ]
        );
    }
);

test(
    'MC13 real: sequência de memória incompleta falha aberta sem perder log',
    () => {
        assert.equal(
            formatarChamadaConsole(
                'log',
                [
                    '\n📂 MEMÓRIA ALOCADA COM SUCESSO:'
                ]
            ),
            null
        );

        const saida =
            formatarChamadaConsole(
                'warn',
                [
                    '⚠️ Evento inesperado entre as linhas.'
                ]
            );

        assert.equal(
            saida.length,
            1
        );

        assert.match(
            saida[0],
            /MEMÓRIA ALOCADA COM SUCESSO/
        );

        assert.match(
            saida[0],
            /Evento inesperado/
        );
    }
);
