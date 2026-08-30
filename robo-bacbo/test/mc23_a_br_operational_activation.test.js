'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

const contextSource = fs.readFileSync(
    path.join(root, 'mesa_context.js'),
    'utf8'
);

const schemaSource = fs.readFileSync(
    path.join(root, 'mesa_schema.js'),
    'utf8'
);

const financialSource = fs.readFileSync(
    path.join(root, 'mesa_financial_scope.js'),
    'utf8'
);

const {
    resolverMesaConhecida,
    afirmarMesaRuntimeHabilitada
} = require('../mesa_context');

test(
    'MC23-A: BR continua exigindo opt-in explicito e round proprio',
    () => {
        const br = resolverMesaConhecida(
            'BACBO_BR'
        );

        assert.equal(
            br.runtime_habilitado,
            false
        );

        assert.equal(
            br.runtime_ativacao_explicita,
            true
        );

        assert.equal(
            br.ativo_persistido,
            false
        );

        assert.throws(
            () => afirmarMesaRuntimeHabilitada(
                br,
                {}
            ),
            err => (
                err
                && err.code
                    === 'MESA_RUNTIME_ATIVACAO_EXPLICITA_AUSENTE'
            )
        );

        const liberada =
            afirmarMesaRuntimeHabilitada(
                br,
                {
                    BACBO_MESA_RUNTIME_ENABLED: '1',
                    TIPMINER_BACBO_ROUND_ID:
                        'daed14c3-2a22-47b3-83c6-2c3a50c2ae69'
                }
            );

        assert.equal(
            liberada.codigo,
            'BACBO_BR'
        );
    }
);

test(
    'MC23-A: startup BR explicitamente autorizado ativa somente a identidade persistida selecionada',
    () => {
        assert.match(
            schemaSource,
            /mesa\.runtime_ativacao_explicita\s*===\s*true/
        );

        assert.match(
            schemaSource,
            /UPDATE mesas[\s\S]*?SET ativo=true[\s\S]*?WHERE codigo=\?/
        );

        assert.match(
            schemaSource,
            /\[mesa\.codigo\]/
        );

        // Continua pre-ativada no catalogo.
        // BACBO_INT nao deve ligar BR incidentalmente.
        assert.match(
            contextSource,
            /ativo_persistido:\s*false/
        );
    }
);

test(
    'MC23-A: ativacao operacional BR nao altera o gate financeiro INT-only',
    () => {
        assert.match(
            financialSource,
            /=== MESA_PADRAO_CODIGO/
        );

        assert.match(
            financialSource,
            /MESA_FINANCEIRA_NAO_AUTORIZADA/
        );

        assert.doesNotMatch(
            financialSource,
            /MESA_BR_CODIGO/
        );
    }
);
