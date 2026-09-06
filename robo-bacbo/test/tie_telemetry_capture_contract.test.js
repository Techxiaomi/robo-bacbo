'use strict';

const test =
    require('node:test');

const assert =
    require('node:assert/strict');

const fs =
    require('fs');

const path =
    require('path');

const source =
    fs.readFileSync(
        path.join(
            __dirname,
            '..',
            'bot2_coletor.js'
        ),
        'utf8'
    );

test(
    'TIE-2 cria tabela aditiva de observações sem alterar historico terminal',
    () => {
        assert.match(
            source,
            /CREATE TABLE IF NOT EXISTS historico_tie_observado/
        );

        assert.match(
            source,
            /giro_resultado_id INT NOT NULL/
        );

        assert.match(
            source,
            /proteger_empate_snapshot BOOLEAN DEFAULT NULL/
        );

        assert.match(
            source,
            /UNIQUE KEY uq_tie_observado/
        );
    }
);

test(
    'TIE-2 usa giro persistido como identidade canônica',
    () => {
        assert.match(
            source,
            /giroResultadoId:\s*\n\s*giroIdPersistidoParaIA/
        );

        assert.match(
            source,
            /INSERT INTO historico_tie_observado/
        );
    }
);

test(
    'TIE-2 registra observação antes da decisão terminal',
    () => {
        const inicio =
            source.indexOf(
                'let isTie = (vencedor===\'Tie\');'
            );

        const captura =
            source.indexOf(
                'await registrarTieObservado({',
                inicio
            );

        const decisao =
            source.indexOf(
                'if (vencedor === est.entrada || (isTie && est.protegerEmpate))',
                inicio
            );

        assert.ok(
            inicio >= 0
        );

        assert.ok(
            captura > inicio
        );

        assert.ok(
            decisao > captura
        );
    }
);

test(
    'TIE sem proteção continua elegível ao fluxo de gale existente',
    () => {
        const decisao =
            source.indexOf(
                'if (vencedor === est.entrada || (isTie && est.protegerEmpate))'
            );

        const gale =
            source.indexOf(
                'if (st.galeAtual < est.gales)',
                decisao
            );

        assert.ok(
            decisao >= 0
        );

        assert.ok(
            gale > decisao
        );
    }
);

test(
    'telemetria não escreve historico_resultados nem altera tipo terminal',
    () => {
        const inicio =
            source.indexOf(
                'async function registrarTieObservado({'
            );

        const fim =
            source.indexOf(
                'async function registrarHistoricoResultadoEstrategia(',
                inicio
            );

        const helper =
            source.slice(
                inicio,
                fim
            );

        assert.doesNotMatch(
            helper,
            /historico_resultados/
        );

        assert.doesNotMatch(
            helper,
            /historico_disparos_robos/
        );
    }
);

test(
    'cada TIE gera escopo estratégia e robôs inscritos sem duplicar robô',
    () => {
        const inicio =
            source.indexOf(
                'async function registrarTieObservado({'
            );

        const fim =
            source.indexOf(
                'async function registrarHistoricoResultadoEstrategia(',
                inicio
            );

        const helper =
            source.slice(
                inicio,
                fim
            );

        assert.match(
            helper,
            /escopo:\s*\n\s*'ESTRATEGIA'/
        );

        assert.match(
            helper,
            /escopo:\s*\n\s*'ROBO'/
        );

        assert.match(
            helper,
            /new Set\(\)/
        );

        assert.match(
            helper,
            /estado\?\.robosInscritos/
        );
    }
);

test(
    'TIE-2 usa classificador puro da TIE-1',
    () => {
        assert.match(
            source,
            /classificarTieObservado/
        );

        assert.match(
            source,
            /require\('\.\/tie_telemetry'\)/
        );
    }
);

test(
    'TIE-2 não adiciona chamadas ao executor dentro do helper de telemetria',
    () => {
        const inicio =
            source.indexOf(
                'async function registrarTieObservado({'
            );

        const fim =
            source.indexOf(
                'async function registrarHistoricoResultadoEstrategia(',
                inicio
            );

        const helper =
            source.slice(
                inicio,
                fim
            );

        assert.doesNotMatch(
            helper,
            /enviarOrdemAoExecutor/
        );

        assert.doesNotMatch(
            helper,
            /criarIntencaoOrdem/
        );

        assert.doesNotMatch(
            helper,
            /auditoria_ordens/
        );

        assert.doesNotMatch(
            helper,
            /AUTO_TRADERS_MEMORIA/
        );
    }
);
