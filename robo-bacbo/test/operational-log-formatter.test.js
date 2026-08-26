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

