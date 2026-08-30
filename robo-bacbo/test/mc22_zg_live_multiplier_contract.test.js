'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
    path.join(__dirname, '..', 'bot2_coletor.js'),
    'utf8'
);

function blocoWriterLive() {
    const inicio = source.indexOf(
        'let nEmp = 0;'
    );

    assert.notEqual(
        inicio,
        -1,
        'writer LIVE precisa declarar nEmp/mult'
    );

    const fim = source.indexOf(
        'giroPersistidoParaIA = true;',
        inicio
    );

    assert.notEqual(
        fim,
        -1,
        'writer LIVE precisa persistir giro analítico'
    );

    return source.slice(
        inicio,
        fim
    );
}

test(
    'MC22-Z-G: Player/Banker nao recebem multiplicador de Tie no writer LIVE',
    () => {
        const bloco = blocoWriterLive();

        assert.match(
            bloco,
            /let nEmp = 0;\s*let mult = "";/,
            'multiplicador LIVE precisa nascer vazio'
        );

        assert.doesNotMatch(
            bloco,
            /let nEmp = 0;\s*let mult = "4x";/,
            '4x nao pode ser default de qualquer resultado'
        );

        assert.match(
            bloco,
            /if\s*\(vencedor === "Tie"\)/,
            'somente Tie deve entrar na classificacao de multiplicador'
        );

        assert.match(
            bloco,
            /nEmp,\s*mult,\s*idSessaoContinua/,
            'INSERT deve persistir o multiplicador normalizado'
        );

        assert.match(
            bloco,
            /multiplicador:\s*mult\s*\|\|\s*''/,
            'memoria analitica deve usar o mesmo valor normalizado'
        );
    }
);
