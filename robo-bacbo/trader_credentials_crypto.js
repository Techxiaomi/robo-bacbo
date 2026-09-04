'use strict';

const crypto = require('node:crypto');

const VERSAO_CREDENCIAL = 1;
const ALGORITMO = 'aes-256-gcm';

function criarErroCredencial(codigo, mensagem) {
    const erro = new Error(mensagem);
    erro.code = codigo;
    return erro;
}

function resolverChaveCredenciais(valor = process.env.TRADER_CREDENTIALS_KEY) {
    const texto = String(valor || '').trim();

    if (!texto) {
        throw criarErroCredencial(
            'TRADER_CREDENTIALS_KEY_AUSENTE',
            'TRADER_CREDENTIALS_KEY obrigatoria para credenciais de Auto-Trader.'
        );
    }

    let chave = null;

    if (/^[0-9a-f]{64}$/i.test(texto)) {
        chave = Buffer.from(texto, 'hex');
    } else {
        try {
            chave = Buffer.from(texto, 'base64');
        } catch (e) {
            chave = null;
        }
    }

    if (!Buffer.isBuffer(chave) || chave.length !== 32) {
        throw criarErroCredencial(
            'TRADER_CREDENTIALS_KEY_INVALIDA',
            'TRADER_CREDENTIALS_KEY deve representar exatamente 32 bytes.'
        );
    }

    return chave;
}

function normalizarLogin(login) {
    return String(login ?? '').trim().toLowerCase();
}

function fingerprintConta(casaCodigo, login) {
    const casa = String(casaCodigo ?? '').trim().toUpperCase();
    const loginNormalizado = normalizarLogin(login);

    if (!casa || !loginNormalizado) {
        throw criarErroCredencial(
            'IDENTIDADE_CONTA_INVALIDA',
            'Casa e login sao obrigatorios para identificar a conta.'
        );
    }

    return crypto
        .createHash('sha256')
        .update(`${casa}\0${loginNormalizado}`, 'utf8')
        .digest('hex');
}

function validarCredenciais(credenciais) {
    const login = String(credenciais?.login ?? '').trim();
    const senha = String(credenciais?.senha ?? '');

    if (!login || !senha) {
        throw criarErroCredencial(
            'CREDENCIAIS_INCOMPLETAS',
            'Login e senha sao obrigatorios.'
        );
    }

    return { login, senha };
}

function criptografarCredenciais(credenciais, chaveBruta) {
    const chave = resolverChaveCredenciais(chaveBruta);
    const dados = validarCredenciais(credenciais);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(
        ALGORITMO,
        chave,
        iv
    );

    const plaintext = Buffer.from(
        JSON.stringify(dados),
        'utf8'
    );

    const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final()
    ]);
    const tag = cipher.getAuthTag();

    return {
        v: VERSAO_CREDENCIAL,
        alg: ALGORITMO,
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        ciphertext: ciphertext.toString('base64')
    };
}

function descriptografarCredenciais(payload, chaveBruta) {
    const chave = resolverChaveCredenciais(chaveBruta);

    if (
        !payload
        || Number(payload.v) !== VERSAO_CREDENCIAL
        || payload.alg !== ALGORITMO
    ) {
        throw criarErroCredencial(
            'CREDENCIAL_CRIPTO_FORMATO_INVALIDO',
            'Payload de credencial criptografada invalido.'
        );
    }

    try {
        const iv = Buffer.from(String(payload.iv || ''), 'base64');
        const tag = Buffer.from(String(payload.tag || ''), 'base64');
        const ciphertext = Buffer.from(
            String(payload.ciphertext || ''),
            'base64'
        );

        if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
            throw new Error('tamanho invalido');
        }

        const decipher = crypto.createDecipheriv(
            ALGORITMO,
            chave,
            iv
        );
        decipher.setAuthTag(tag);

        const plaintext = Buffer.concat([
            decipher.update(ciphertext),
            decipher.final()
        ]).toString('utf8');

        return validarCredenciais(
            JSON.parse(plaintext)
        );
    } catch (e) {
        throw criarErroCredencial(
            'CREDENCIAL_CRIPTO_FALHOU',
            'Nao foi possivel descriptografar as credenciais.'
        );
    }
}

module.exports = {
    VERSAO_CREDENCIAL,
    ALGORITMO,
    resolverChaveCredenciais,
    normalizarLogin,
    fingerprintConta,
    criptografarCredenciais,
    descriptografarCredenciais
};
