'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backendPath = path.join(__dirname, '..', 'bot2_coletor.js');
const fonte = fs.readFileSync(backendPath, 'utf8');

function blocoEntre(inicio, fim) {
    const posInicio = fonte.indexOf(inicio);
    assert.notEqual(
        posInicio,
        -1,
        'marcador inicial precisa existir: ' + inicio
    );

    const posFim = fonte.indexOf(fim, posInicio);
    assert.notEqual(
        posFim,
        -1,
        'marcador final precisa existir: ' + fim
    );

    return fonte.slice(posInicio, posFim);
}

test(
    'Auto Pilot calcula assertividade pela RAM live canonica',
    () => {
        const bloco = blocoEntre(
            'function calcularAssertividadeLiveCanonica(',
            '\nfunction roboSintonizaEstrategia'
        );

        assert.match(
            bloco,
            /Array\.isArray\(historicoLiveCanonico\)/
        );

        assert.match(
            bloco,
            /resultado:\s*String\(giro\?\.resultado/
        );

        assert.match(
            bloco,
            /multiplicador:\s*String\(giro\?\.multiplicador/
        );

        assert.match(
            bloco,
            /calcularDetalhesPadraoNoHistorico\s*\(/
        );

        assert.match(
            bloco,
            /contarTiesLegados\(detalhes\.ties\)/
        );

        assert.doesNotMatch(
            bloco,
            /dbPool\.query/
        );

        assert.doesNotMatch(
            fonte,
            /calcularAssertividadePersistidaEstrategia/
        );
    }
);

test(
    'selecao de robos usa o historico live canonico',
    () => {
        assert.match(
            fonte,
            /async function selecionarRobosParaEstrategia\(est, historicoLiveCanonico\)/
        );

        assert.match(
            fonte,
            /const assertividade = calcularAssertividadeLiveCanonica\(est, historicoLiveCanonico\)/
        );

        assert.match(
            fonte,
            /integracaoContadorDiario\.obterHistoricoCanonicoLive\(/
        );

        assert.match(
            fonte,
            /estadoLiveCanonico\.pronto !== true/
        );

        assert.match(
            fonte,
            /const historicoLiveCanonico = estadoLiveCanonico\.history/
        );

        assert.match(
            fonte,
            /selecionarRobosParaEstrategia\(est, historicoLiveCanonico\)/
        );
    }
);
