'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    wilsonLowerBound95,
    avaliarCenarioOraculo,
    extrairMesaAtual,
    decidirOraculo
} = require('../oraculo_dinamico');

function giro(resultado, sessao = 'S') {
    return { resultado, id_sessao: sessao };
}

function mesaSemEmpates() {
    return ['P', 'B', 'P', 'B', 'P', 'B']
        .map(item => giro(item));
}

function cenario(n, lado, taxaBruta, amostras = 100) {
    return {
        n,
        lado,
        amostras,
        acertos: Math.round(
            amostras * taxaBruta / 100
        ),
        taxa_bruta: taxaBruta,
        confianca_wilson: wilsonLowerBound95(
            Math.round(amostras * taxaBruta / 100),
            amostras
        )
    };
}

test(
    'Oraculo: Wilson 95% continua disponivel como metrica estatistica',
    () => {
        const valor = wilsonLowerBound95(80, 100);
        assert.ok(valor > 71 && valor < 72);
    }
);

test(
    'Oraculo: Gale 1 considera o giro imediato e o proximo',
    () => {
        const historico = [
            giro('P'),
            giro('B'),
            giro('T'),
            giro('B'),
            giro('P')
        ];

        const direto = avaliarCenarioOraculo(
            historico,
            ['P', 'B', 'T'],
            'P',
            0
        );

        const gale1 = avaliarCenarioOraculo(
            historico,
            ['P', 'B', 'T'],
            'P',
            1
        );

        assert.equal(direto.amostras, 1);
        assert.equal(direto.acertos, 0);
        assert.equal(gale1.amostras, 1);
        assert.equal(gale1.acertos, 1);
    }
);

test(
    'Oraculo: ocorrencia nao atravessa fronteira de sessao',
    () => {
        const historico = [
            giro('P', 'A'),
            giro('B', 'A'),
            giro('T', 'A'),
            giro('P', 'B')
        ];

        const resultado = avaliarCenarioOraculo(
            historico,
            ['P', 'B', 'T'],
            'P',
            0
        );

        assert.equal(resultado.amostras, 0);
    }
);

test(
    'Oraculo: mesa atual usa somente a cauda continua da sessao',
    () => {
        const dados = [
            giro('P', 'A'),
            giro('B', 'A'),
            giro('T', 'B'),
            giro('P', 'B'),
            giro('B', 'B')
        ];

        const mesa = extrairMesaAtual(dados, 20);

        assert.deepEqual(
            mesa.map(item => item.resultado),
            ['T', 'P', 'B']
        );
    }
);

test(
    'Oraculo: dois empates nos ultimos cinco rejeitam imediatamente',
    () => {
        const mesa = [
            'P',
            'T',
            'B',
            'T',
            'P',
            'B'
        ].map(item => giro(item));

        const resultado = decidirOraculo(
            [cenario(4, 'P', 95)],
            mesa,
            85
        );

        assert.equal(resultado.status, 'REJEITADO');
        assert.equal(
            resultado.detalhe,
            'EMPATES_EXCESSIVOS'
        );
    }
);

test(
    'Oraculo: maior taxa bruta vence mesmo com direcoes diferentes entre N-grams',
    () => {
        const cenarios = [
            cenario(3, 'P', 91),
            cenario(3, 'B', 62),
            cenario(4, 'P', 86),
            cenario(4, 'B', 65),
            cenario(5, 'P', 61),
            cenario(5, 'B', 92),
            cenario(6, 'P', 84),
            cenario(6, 'B', 70)
        ];

        const resultado = decidirOraculo(
            cenarios,
            mesaSemEmpates(),
            85
        );

        assert.deepEqual(resultado, {
            status: 'APROVADO',
            sugerido: 'B',
            confianca_wilson: 92,
            amostras_base: 100,
            padrao_vencedor: 'N-5',
            mensagem: 'Sinal forte detectado.'
        });
    }
);

test(
    'Oraculo: maior taxa bruta abaixo da meta rejeita',
    () => {
        const resultado = decidirOraculo(
            [
                cenario(3, 'P', 71.2),
                cenario(3, 'B', 65)
            ],
            mesaSemEmpates(),
            85
        );

        assert.equal(resultado.status, 'REJEITADO');
        assert.equal(
            resultado.detalhe,
            'ABAIXO_DA_META'
        );
        assert.equal(
            resultado.melhor_confianca,
            71.2
        );
    }
);

test(
    'Oraculo: maior taxa bruta aprovada define lado amostra e N-gram',
    () => {
        const cenarios = [
            cenario(3, 'P', 86, 500),
            cenario(3, 'B', 70, 500),
            cenario(4, 'P', 88.5, 412),
            cenario(4, 'B', 72, 412),
            cenario(5, 'P', 84, 260),
            cenario(5, 'B', 80, 260),
            cenario(6, 'P', 82, 120),
            cenario(6, 'B', 78, 120)
        ];

        const resultado = decidirOraculo(
            cenarios,
            mesaSemEmpates(),
            85
        );

        assert.deepEqual(resultado, {
            status: 'APROVADO',
            sugerido: 'P',
            confianca_wilson: 88.5,
            amostras_base: 412,
            padrao_vencedor: 'N-4',
            mensagem: 'Sinal forte detectado.'
        });
    }
);
