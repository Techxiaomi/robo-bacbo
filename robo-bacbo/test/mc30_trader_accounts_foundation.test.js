'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    listarCasasHomologadas,
    resolverCasaHomologada
} = require('../trader_house_registry');

const {
    obterPerfilFichasReais,
    decomporValorEmFichas
} = require('../trader_mesa_chip_profile');

const {
    avaliarHabilitacaoConta,
    podeSalvarTraderDesligado
} = require('../trader_account_exclusivity');

const {
    CHECKS_OBRIGATORIOS,
    validarRelatorioTesteConta
} = require('../trader_account_test_contract');

const {
    fingerprintConta,
    criptografarCredenciais,
    descriptografarCredenciais,
    resolverChaveCredenciais
} = require('../trader_credentials_crypto');

test('MC30-A: dropdown expoe somente as duas casas homologadas', () => {
    assert.deepEqual(
        listarCasasHomologadas(),
        [
            { codigo: 'APOSTASONLINE', nome: 'Apostasonline' },
            { codigo: 'BRASIL_DA_SORTE', nome: 'Brasil da Sorte' }
        ]
    );

    assert.equal(
        resolverCasaHomologada('brasil_da_sorte').nome,
        'Brasil da Sorte'
    );

    assert.throws(
        () => resolverCasaHomologada('outra'),
        erro => erro?.code === 'CASA_APOSTAS_NAO_HOMOLOGADA'
    );
});

test('MC30-A: perfil de fichas pertence a mesa, nao a casa', () => {
    assert.deepEqual(
        obterPerfilFichasReais('BACBO_INT'),
        [5000, 2500, 500, 125, 25, 10, 5]
    );

    assert.deepEqual(
        obterPerfilFichasReais('BACBO_BR'),
        [2500, 500, 125, 25, 5, 2.5]
    );

    assert.equal(
        obterPerfilFichasReais('BACBO_BR').includes(5000),
        false
    );

    assert.equal(
        obterPerfilFichasReais('BACBO_BR').includes(10),
        false
    );
});

test('MC30-A: BR decompoe valores usando 2.5 e repeticao de fichas', () => {
    assert.deepEqual(
        decomporValorEmFichas('BACBO_BR', 7.5)
            .cliques_necessarios,
        [
            { ficha_centavos: 500, ficha: 5, quantidade: 1 },
            { ficha_centavos: 250, ficha: 2.5, quantidade: 1 }
        ]
    );

    assert.deepEqual(
        decomporValorEmFichas('BACBO_BR', 10)
            .cliques_necessarios,
        [
            { ficha_centavos: 500, ficha: 5, quantidade: 2 }
        ]
    );

    assert.deepEqual(
        decomporValorEmFichas('BACBO_BR', 12.5)
            .cliques_necessarios,
        [
            { ficha_centavos: 500, ficha: 5, quantidade: 2 },
            { ficha_centavos: 250, ficha: 2.5, quantidade: 1 }
        ]
    );

    assert.equal(
        decomporValorEmFichas('BACBO_BR', 1).representavel,
        false
    );
});

test('MC30-A: mesma conta pode ser salva, mas nao habilitada duas vezes', () => {
    assert.equal(
        podeSalvarTraderDesligado().permitido,
        true
    );

    const avaliacao = avaliarHabilitacaoConta({
        trader_id: 22,
        account_id: 91,
        traders: [
            {
                id: 11,
                account_id: 91,
                ativo: true,
                mesa_codigo: 'BACBO_INT',
                nome: 'Trader Internacional'
            }
        ]
    });

    assert.equal(avaliacao.permitido, false);
    assert.equal(avaliacao.codigo, 'CONTA_TRADER_EM_USO');
    assert.match(avaliacao.mensagem, /BACBO_INT/);
    assert.match(avaliacao.mensagem, /Trader Internacional/);
});

test('MC30-A: conta diferente pode habilitar em paralelo', () => {
    const avaliacao = avaliarHabilitacaoConta({
        trader_id: 22,
        account_id: 92,
        traders: [
            {
                id: 11,
                account_id: 91,
                ativo: true,
                mesa_codigo: 'BACBO_INT',
                nome: 'Trader Internacional'
            }
        ]
    });

    assert.equal(avaliacao.permitido, true);
});

test('MC30-A: teste de conta exige jornada completa, saldo e zero clique financeiro', () => {
    const relatorio = {
        checks: CHECKS_OBRIGATORIOS.map(codigo => ({
            codigo,
            ok: true
        })),
        saldo: 123.45,
        financial_clicks_executed: false,
        bet_executed: false
    };

    const valido = validarRelatorioTesteConta(relatorio);
    assert.equal(valido.ok, true);
    assert.equal(valido.saldo, 123.45);

    const semSaldo = validarRelatorioTesteConta({
        ...relatorio,
        saldo: null
    });
    assert.equal(semSaldo.ok, false);
    assert.ok(semSaldo.falhos.includes('BALANCE_READ'));

    const comClique = validarRelatorioTesteConta({
        ...relatorio,
        financial_clicks_executed: true
    });
    assert.equal(comClique.ok, false);
    assert.ok(
        comClique.falhos.includes('FINANCIAL_ACTION_FORBIDDEN')
    );
});

test('MC30-A: credenciais usam AES-256-GCM e fingerprint nao depende de senha', () => {
    const chave = Buffer.alloc(32, 7).toString('base64');

    const fingerprintA = fingerprintConta(
        'BRASIL_DA_SORTE',
        ' Pessoa@Email.com '
    );
    const fingerprintB = fingerprintConta(
        'BRASIL_DA_SORTE',
        'pessoa@email.com'
    );

    assert.equal(fingerprintA, fingerprintB);

    const cifrada = criptografarCredenciais(
        {
            login: 'pessoa@email.com',
            senha: 'segredo-local'
        },
        chave
    );

    assert.equal(cifrada.alg, 'aes-256-gcm');
    assert.equal(
        JSON.stringify(cifrada).includes('segredo-local'),
        false
    );

    assert.deepEqual(
        descriptografarCredenciais(cifrada, chave),
        {
            login: 'pessoa@email.com',
            senha: 'segredo-local'
        }
    );

    assert.throws(
        () => resolverChaveCredenciais(''),
        erro => erro?.code === 'TRADER_CREDENTIALS_KEY_AUSENTE'
    );

    const chaveErrada = Buffer.alloc(32, 9).toString('base64');
    assert.throws(
        () => descriptografarCredenciais(cifrada, chaveErrada),
        erro => erro?.code === 'CREDENCIAL_CRIPTO_FALHOU'
    );
});
