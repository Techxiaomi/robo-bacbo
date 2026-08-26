'use strict';

const { onHistoricoRecuperado } = require('./bacbo_live_bus');

let instalado = false;
let sequenciaRodadas = 0;
let ultimaSequenciaRodada = 0;
let separarAntesProximaRodada = false;
let ultimoRecoveryCompacto = { count: 0, em: 0 };

const UUIDS_MAX = 5000;
const uuidsRodadas = new Map();
const TIMEZONE = process.env.AUTO_TRADER_TIMEZONE || process.env.TZ || 'America/Sao_Paulo';
const relogio = new Intl.DateTimeFormat('pt-BR', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
});

function lembrarUuid(uuid) {
    const chave = String(uuid || '').trim().toLowerCase();
    if (!chave) return true;
    if (uuidsRodadas.has(chave)) return false;
    uuidsRodadas.set(chave, Date.now());
    while (uuidsRodadas.size > UUIDS_MAX) uuidsRodadas.delete(uuidsRodadas.keys().next().value);
    return true;
}

function horaAtual() {
    try { return relogio.format(new Date()); } catch (_) { return new Date().toTimeString().slice(0, 8); }
}

function horaInstant(valor) {
    const ms = valor ? Date.parse(String(valor)) : NaN;
    if (!Number.isFinite(ms)) return '--:--:--';
    try { return relogio.format(new Date(ms)); } catch (_) { return new Date(ms).toTimeString().slice(0, 8); }
}

function nomeResultado(valor) {
    const tipo = String(valor || '').trim().toUpperCase();
    if (tipo === 'PLAYER' || tipo === 'P' || tipo === 'PLAYERWON') return 'JOGADOR';
    if (tipo === 'BANKER' || tipo === 'B' || tipo === 'BANKERWON') return 'BANCA';
    if (tipo === 'TIE' || tipo === 'T' || tipo === 'TIEWON') return 'EMPATE';
    return tipo || 'RESULTADO';
}

function simboloResultado(valor) {
    const tipo = String(valor || '').trim().toUpperCase();
    if (tipo === 'PLAYER' || tipo === 'P' || tipo === 'PLAYERWON') return 'P';
    if (tipo === 'BANKER' || tipo === 'B' || tipo === 'BANKERWON') return 'B';
    if (tipo === 'TIE' || tipo === 'T' || tipo === 'TIEWON') return 'T';
    return '?';
}

function numeroFormatado(valor) {
    return `#${String(Math.max(0, Number(valor) || 0)).padStart(5, '0')}`;
}

function numeroRodada() {
    sequenciaRodadas += 1;
    ultimaSequenciaRodada = sequenciaRodadas;
    return numeroFormatado(sequenciaRodadas);
}

function numeroUltimaRodada() {
    return numeroFormatado(ultimaSequenciaRodada);
}

function marcarSeparacaoProximaRodada() {
    separarAntesProximaRodada = true;
}

function rotuloShadowOperacional(chave) {
    const texto = String(chave || '').trim();
    const match = texto.match(/^ia_(\d+)_/i);
    return match ? `IA ${match[1]}` : (texto || 'SHADOW');
}

function formatarOcupacaoSuprimida(valor) {
    const texto = String(valor || '')
        .trim()
        .replace(/\.$/, '');

    const match = texto.match(
        /^(\d+):(.+?)\s+em\s+\S+\s+\(([^)]+)\)$/i
    );

    if (!match) return texto;

    return `Robô ${match[1]} · ${match[2].trim()} · ${match[3].trim()}`;
}

function linhaRodada(uuid, tipo, soma) {
    if (!lembrarUuid(uuid)) return null;
    const numero = numeroRodada();
    const horario = horaAtual();
    const resultado = nomeResultado(tipo).padEnd(7, ' ');
    const somaFmt = String(soma).trim().padStart(2, ' ');
    const prefixo = separarAntesProximaRodada ? '\n' : '';
    separarAntesProximaRodada = false;
    return `${prefixo}🎲 ${numero} | ${horario} | ${resultado} | Soma: ${somaFmt}`;
}

function registrarRecoveryOperacional(payload) {
    try {
        const rounds = (Array.isArray(payload?.rounds) ? payload.rounds : [])
            .filter(round => round && typeof round === 'object')
            .sort((a, b) => Date.parse(String(a.instant || '')) - Date.parse(String(b.instant || '')));

        const novos = [];
        for (const round of rounds) {
            if (!lembrarUuid(round.uuid)) continue;
            novos.push(round);
        }
        if (novos.length === 0) return false;

        const inicio = sequenciaRodadas + 1;
        sequenciaRodadas += novos.length;
        ultimaSequenciaRodada = sequenciaRodadas;

        const primeiroNumero = numeroFormatado(inicio);
        const ultimoNumero = numeroFormatado(sequenciaRodadas);
        const primeiroHorario = horaInstant(novos[0].instant);
        const ultimoHorario = horaInstant(novos[novos.length - 1].instant);
        const faixa = `${primeiroNumero}…${ultimoNumero}`;
        const prefixo = '\n';

        ultimoRecoveryCompacto = { count: novos.length, em: Date.now() };
        separarAntesProximaRodada = true;

        if (payload?.continuity === false) {
            console.warn(
                `${prefixo}⚠️ RECOVERY | ${novos.length} rodadas disponíveis | `
                + `${primeiroHorario} → ${ultimoHorario} | ${faixa} | sem âncora na janela; nova fronteira`
            );
            return true;
        }

        console.log(
            `${prefixo}♻️ RECOVERY | ${novos.length} rodada(s) recuperada(s) | `
            + `${primeiroHorario} → ${ultimoHorario} | ${faixa}`
        );
        return true;
    } catch (_) {
        return false;
    }
}

function registrarSinalOperacional(payload) {
    if (!payload || String(payload.tipo || '').toUpperCase() !== 'ENTRADA') return false;
    const robos = Array.isArray(payload.robosNotificados) ? payload.robosNotificados : [];
    if (robos.length === 0) return false;

    const padrao = (Array.isArray(payload.padrao) ? payload.padrao : [])
        .map(simboloResultado)
        .filter(simbolo => simbolo !== '?')
        .join('-');
    const entradaSimbolo = simboloResultado(payload.entrada);
    const entradaNome = nomeResultado(payload.entrada);
    const assinatura = `${padrao || '?'} → ${entradaSimbolo}`;

    robos.forEach(robo => {
        const id = robo?.id !== undefined && robo?.id !== null ? String(robo.id) : '?';
        console.log(
            `\n🎯 SINAL | Robô ${id} | ${assinatura}\n`
            + `   └─ Entrada: ${entradaNome}`
        );
    });

    marcarSeparacaoProximaRodada();
    return true;
}

function formatarTexto(valor) {
    let texto = String(valor);

    if (
        texto.includes('🔥 Vencedor:')
        && texto.includes('🔵 Jogador :')
        && texto.includes('🔴 Banca:')
    ) {
        return null;
    }

    if (/^⚠️ bacbo_events recebido mas ignorado \| motivo=evento_nao_reconhecido \| action=history_sync\.$/i.test(texto)) {
        return null;
    }

    let match = texto.match(
        /^🔄 Mapeamento BacBo -> IA \| uuid=([0-9a-f-]{36}) \| type=(PLAYER|BANKER|TIE) -> interno=(Player|Banker|Tie) \| simbolo=([PBT]) \| soma=(.+)$/i
    );
    if (match) {
        return linhaRodada(match[1], match[2], match[5]);
    }

    if (/^✅ Nova rodada processada pela IA -> Vencedor:/i.test(texto)) return null;
    if (/^✅ IA atualizada \|/i.test(texto)) return null;

    if (/^✅ Backend inicializado e pronto para atender APIs\.$/i.test(texto)) {
        marcarSeparacaoProximaRodada();
        return '✅ BACKEND | Inicializado e pronto para atender APIs';
    }

    match = texto.match(
        /^🔒 Sinal\s+(.+?)\s+suprimido:\s+nenhum robô livre para novo ciclo\.(?:\s+Ocupados:\s+(.+))?$/i
    );
    if (match) {
        marcarSeparacaoProximaRodada();

        const sinal = match[1].trim();
        const base =
            `   🔒 SUPRIMIDO | ${numeroUltimaRodada()} | ${sinal}`;

        if (!match[2]) {
            return `${base} | Nenhum robô livre`;
        }

        const ocupado =
            formatarOcupacaoSuprimida(match[2]);

        return `${base}\n`
            + '      ├─ Motivo: nenhum robô livre\n'
            + `      └─ Ocupado: ${ocupado}`;
    }

    match = texto.match(
        /^🔒 Sinal\s+(.+?)\s+suprimido:\s+(.+)$/i
    );
    if (match) {
        marcarSeparacaoProximaRodada();
        return `   🔒 SUPRIMIDO | ${numeroUltimaRodada()} | ${match[1].trim()}\n`
            + `      └─ ${match[2].trim()}`;
    }

    match = texto.match(
        /^👻 Shadow Live\s+(\S+):\s+(\d+)\/(\d+)\s+ocorrência(?:\(s\)|s)?,\s+assert=([0-9]+(?:[.,][0-9]+)?)%,\s+Wilson=([0-9]+(?:[.,][0-9]+)?)%,\s+pendente\s+\((\d+)\s+restante(?:\(s\)|s)?\)\.?$/i
    );
    if (match) {
        marcarSeparacaoProximaRodada();
        const ia =
            rotuloShadowOperacional(match[1]);
        return `   👻 SHADOW | ${numeroUltimaRodada()} | ${ia} | ${match[2]}/${match[3]} | `
            + `Assert: ${match[4]}% | Wilson: ${match[5]}% | Restam: ${match[6]}`;
    }

    match = texto.match(/^📨 Robô\s+(\d+):\s+Telegram confirmado em\s+(\d+)\/(\d+)\s+destino\(s\)\.$/i);
    if (match) {
        return `📨 TELEGRAM | Robô ${match[1]} | CONFIRMADO | Destinos: ${match[2]}/${match[3]}`;
    }

    match = texto.match(/^📨 Robô\s+(\d+):\s+teste Telegram confirmado em\s+(\d+)\/(\d+)\s+destino\(s\)\.$/i);
    if (match) {
        return `📨 TESTE TG | Robô ${match[1]} | CONFIRMADO | Destinos: ${match[2]}/${match[3]}`;
    }

    match = texto.match(/^🧩 Recovery analítico \| (\d+) giro\(s\) recomposto\(s\) cronologicamente \| janela=(\d+)(.*)$/i);
    if (match) {
        const count = Number(match[1]) || 0;
        if (count === ultimoRecoveryCompacto.count && Date.now() - ultimoRecoveryCompacto.em < 5000) return null;
        return `🧩 ANALÍTICO | ${count} giro(s) recomposto(s) | Janela: ${match[2]}${match[3] || ''}`;
    }

    match = texto.match(/^⚠️ Continuidade de dados comprometida \(([^)]+)\): (\d+) sinal\(is\) pendente\(s\) invalidado\(s\), (\d+) Auto-Trader\(s\) com ordem pendente bloqueado\(s\)\.$/i);
    if (match) {
        marcarSeparacaoProximaRodada();
        return `\n🚨 CRÍTICO | CONTINUIDADE\n`
            + `   ├─ Motivo: ${match[1]}\n`
            + `   ├─ Sinais invalidados: ${match[2]}\n`
            + `   └─ Traders bloqueados: ${match[3]}`;
    }

    if (/^⏳ Fila live aguardando o backend concluir a inicialização\.$/i.test(texto)) {
        return `⏳ FILA     | ${numeroUltimaRodada()} | Backend inicializando; rodada preservada.`;
    }
    if (/^⏳ Fila live aguardando o servidor local ficar disponível\.$/i.test(texto)) {
        return `⏳ FILA     | ${numeroUltimaRodada()} | Servidor local indisponível; rodada preservada.`;
    }
    if (/^✅ Fila live liberada \| backend pronto; processamento retomado em ordem\.$/i.test(texto)) {
        marcarSeparacaoProximaRodada();
        return `✅ FILA     | ${numeroUltimaRodada()} | Backend pronto; processamento retomado.`;
    }
    if (/^⚠️ Rodada live não entregue ao backend; fila preservada sem marcar como processada\.$/i.test(texto)) {
        marcarSeparacaoProximaRodada();
        return `\n❌ ERRO | FILA\n`
            + `   ├─ Rodada: ${numeroUltimaRodada()}\n`
            + '   └─ Entrega ao backend falhou; fila preservada.';
    }
    if (/^⚠️ Persistencia bacbo_rounds falhou/i.test(texto)) {
        texto = texto.replace(/^⚠️ Persistencia bacbo_rounds falhou[^:]*:\s*/i, '');
        marcarSeparacaoProximaRodada();
        return `\n⚠️ WARNING | PERSISTÊNCIA\n`
            + `   ├─ Rodada: ${numeroUltimaRodada()}\n`
            + `   └─ Persistência canônica falhou${texto ? `: ${texto}` : ''}`;
    }

    match = texto.match(/^♻️ TipMiner HISTORY atualizado \| janela=(\d+) \| novas=(\d+) \| origem=([^\.]+)\.$/i);
    if (match) {
        const novas = Math.max(0, Number(match[2]) || 0);
        if (novas === 0) return null;
        return `♻️ HISTÓRICO | ${novas} nova(s) detectada(s) | Janela: ${match[1]}.`;
    }

    texto = texto.replace(/TIPMINER/gi, 'BAC BO');
    texto = texto.replace(/TipMiner/g, 'Bac Bo');

    texto = texto.replace(/\buuid=[0-9a-f-]{36}\s*\|\s*/gi, '');
    texto = texto.replace(/\s*\|\s*uuid=[0-9a-f-]{36}/gi, '');
    texto = texto.replace(/\s*\|\s*UUID:\s*[0-9a-f-]{36}/gi, '');

    if (/^🎧 Bac Bo Redis V3 ativo em bacbo_events:/i.test(texto)) {
        return '🎧 Redis Bac Bo ativo | canal=bacbo_events | contrato=type+result.';
    }

    if (/^🎧 Adaptador Bac Bo HISTORY_SYNC ativo:/i.test(texto)) {
        return '🎧 Sincronização de histórico ativa | Redis -> Runtime V3.';
    }

    match = texto.match(/^♻️ Bac Bo HISTORY_SYNC -> Node \| (\d+) giro\(s\).*$/i);
    if (match) {
        return `♻️ Histórico inicial carregado | ${match[1]} giro(s).`;
    }

    match = texto.match(/^🧠 Bac Bo HISTORY schema novo persistido \| (\d+) rodada\(s\)\.$/i);
    if (match) {
        const novas = Math.max(0, Number(match[1]) || 0);
        if (novas === 0) return null;
        return `🧠 Histórico canônico | ${novas} nova(s) persistida(s).`;
    }

    match = texto.match(/^✅ Bac Bo HISTORY sincronizado com Runtime V3 \| (\d+) giro\(s\)\.$/i);
    if (match) {
        return `✅ Histórico inicial sincronizado | ${match[1]} giro(s).`;
    }

    texto = texto.replace(/Bac Bo HISTORY_SYNC/gi, 'Histórico Bac Bo');
    texto = texto.replace(/Bac Bo HISTORY/gi, 'Histórico Bac Bo');

    return texto;
}

function textoErro(valor) {
    if (valor instanceof Error) return String(valor.message || valor);
    if (valor && typeof valor === 'object' && valor.message) return String(valor.message);
    return typeof valor === 'string' ? valor : '';
}

function detalheSql(args) {
    const itens = Array.isArray(args) ? args : [];
    const erro = itens.find(v => v && typeof v === 'object');
    const texto = itens.map(textoErro).filter(Boolean).join(' | ');

    const porErrno = {
        1040: 'ER_CON_COUNT_ERROR',
        1045: 'ER_ACCESS_DENIED_ERROR',
        1049: 'ER_BAD_DB_ERROR',
        1054: 'ER_BAD_FIELD_ERROR',
        1146: 'ER_NO_SUCH_TABLE',
        1205: 'ER_LOCK_WAIT_TIMEOUT',
        1213: 'ER_LOCK_DEADLOCK'
    };

    const motivos = {
        ETIMEDOUT: 'Timeout ao estabelecer/completar a conexão com MySQL',
        ECONNREFUSED: 'Servidor MySQL recusou a conexão',
        ECONNRESET: 'Conexão com MySQL foi resetada',
        ENOTFOUND: 'Host MySQL não foi encontrado',
        EAI_AGAIN: 'Falha temporária de DNS do host MySQL',
        PROTOCOL_CONNECTION_LOST: 'Conexão MySQL foi perdida durante a operação',
        ER_ACCESS_DENIED_ERROR: 'Acesso MySQL negado para a origem/credencial configurada',
        ER_CON_COUNT_ERROR: 'Servidor MySQL atingiu o limite de conexões',
        ER_LOCK_DEADLOCK: 'Deadlock detectado pelo MySQL',
        ER_LOCK_WAIT_TIMEOUT: 'Timeout aguardando lock no MySQL',
        ER_BAD_DB_ERROR: 'Banco MySQL configurado não existe ou não está acessível',
        ER_NO_SUCH_TABLE: 'Tabela MySQL esperada não existe',
        ER_BAD_FIELD_ERROR: 'Coluna MySQL esperada não existe'
    };

    let codigo = String(erro?.code || '').trim().toUpperCase();

    if (!motivos[codigo]) {
        codigo =
            Object.keys(motivos).find(
                c => new RegExp('\\b' + c + '\\b', 'i').test(texto)
            )
            || porErrno[Number(erro?.errno)]
            || '';
    }

    return {
        codigo: codigo || 'N/D',
        motivo:
            motivos[codigo]
            || texto.replace(/\s+/g, ' ').slice(0, 180)
            || 'Falha SQL sem detalhe textual'
    };
}

function blocoSql(titulo, linhas) {
    const itens = linhas.filter(Boolean);

    return '\n'
        + titulo
        + '\n'
        + itens
            .map(
                (v, i) =>
                    (i === itens.length - 1 ? '   └─' : '   ├─')
                    + ' '
                    + v
            )
            .join('\n');
}

function formatarFalhaSqlConhecida(nivel, args) {
    const entrada = Array.isArray(args) ? [...args] : [];
    const p = typeof entrada[0] === 'string' ? entrada[0] : '';

    if (!p) return null;

    const d = detalheSql(entrada);

    let titulo = '';
    let linhas = [];
    let preservarErro = false;
    let m;

    if (
        /^⚠️ Schema bacbo_rounds não inicializou no bootstrap:/i.test(p)
    ) {
        titulo = '⚠️ SQL | INDISPONÍVEL | BACBO_ROUNDS';

        linhas = [
            'Fase: bootstrap do schema canônico',
            'Impacto: runtime segue ativo; persistência canônica pode ficar indisponível',
            `Código: ${d.codigo}`,
            `Motivo: ${d.motivo}`
        ];

    } else if (
        (
            m = p.match(
                /^⚠️ Persistencia bacbo_rounds falhou(?:\s*\|\s*uuid=([^:|]+))?:?/i
            )
        )
    ) {
        titulo = '⚠️ SQL | PERSISTÊNCIA | RODADA LIVE';

        linhas = [
            `Rodada: ${numeroUltimaRodada()}`,
            m[1] ? `UUID: ${m[1].trim()}` : '',
            'Impacto: rodada permanece no runtime; persistência canônica falhou',
            `Código: ${d.codigo}`,
            `Motivo: ${d.motivo}`
        ];

    } else if (
        /^⚠️ Persistencia do historico BacBo falhou:/i.test(p)
    ) {
        titulo = '⚠️ SQL | PERSISTÊNCIA | HISTÓRICO BAC BO';

        linhas = [
            'Fase: sincronização do histórico canônico',
            'Impacto: histórico não é confirmado enquanto persistir a falha',
            `Código: ${d.codigo}`,
            `Motivo: ${d.motivo}`
        ];

    } else if (
        /^⚠️ Recovery analítico do histórico falhou sem afetar bacbo_rounds:/i.test(p)
    ) {
        titulo = '⚠️ SQL | RECOVERY | ANALÍTICO';

        linhas = [
            'Fase: recomposição analítica do histórico',
            'Impacto: bacbo_rounds permanece preservado',
            `Código: ${d.codigo}`,
            `Motivo: ${d.motivo}`
        ];

    } else if (
        /^⚠️ Telegram: (?:preferências visuais não foram migradas no bootstrap|não foi possível carregar preferências visuais do robô):/i.test(p)
    ) {
        titulo = '⚠️ SQL | CONFIGURAÇÃO | TELEGRAM';

        linhas = [
            'Fase: preferências visuais do robô',
            'Impacto: Telegram usa configuração persistida/default',
            `Código: ${d.codigo}`,
            `Motivo: ${d.motivo}`
        ];

    } else if (
        /^❌ Erro Crítico ao preparar banco de dados:/i.test(p)
    ) {
        titulo = '🚨 SQL | BOOTSTRAP BLOQUEADO';

        linhas = [
            'Fase: preparar banco de dados',
            'Ação: inicialização permanece fail-closed',
            `Código: ${d.codigo}`,
            `Motivo: ${d.motivo}`
        ];

    } else if (
        /^❌ Falha em migration incremental:/i.test(p)
    ) {
        titulo = '🚨 SQL | MIGRATION BLOQUEADA';

        linhas = [
            'Fase: migration incremental',
            'Ação: bootstrap não ignora migration inválida',
            `Código: ${d.codigo}`,
            `Motivo: ${d.motivo}`
        ];

    } else if (
        /^⚠️ Falha ao encerrar pool MySQL após erro de inicialização:/i.test(p)
    ) {
        titulo = '⚠️ SQL | ENCERRAMENTO | POOL';

        linhas = [
            'Fase: fechamento seguro após falha de bootstrap',
            `Código: ${d.codigo}`,
            `Motivo: ${d.motivo}`
        ];

    } else if (
        /^🔥 Inicialização do backend falhou; encerrando processo em modo seguro:/i.test(p)
        && d.codigo !== 'N/D'
    ) {
        titulo = '🚨 SQL | BACKEND ENCERRADO EM MODO SEGURO';

        linhas = [
            'Fase: inicialização principal',
            'Ação: backend permanece fail-closed',
            `Código: ${d.codigo}`,
            `Motivo: ${d.motivo}`
        ];

        preservarErro = true;
    }

    if (!titulo) return null;

    marcarSeparacaoProximaRodada();

    const bloco = blocoSql(
        titulo,
        linhas
    );

    const objetos = entrada
        .slice(1)
        .filter(
            v =>
                v
                && typeof v === 'object'
        );

    return preservarErro && objetos.length
        ? [bloco, ...objetos]
        : [bloco];
}

function formatarChamadaIaConhecida(
    nivel,
    args
) {
    const entrada =
        Array.isArray(args)
            ? [...args]
            : [];

    if (
        typeof entrada[0]
        !== 'string'
    ) {
        return undefined;
    }

    const texto =
        entrada[0];

    let match =
        texto.match(
            /^\s*📂 MEMÓRIA ALOCADA COM SUCESSO:\s*\r?\n\s*-\s*Estratégias Ativas:\s*(\d+)\s*\r?\n\s*-\s*Robôs de Canal:\s*(\d+)\s*\r?\n\s*-\s*Motores Auto-Trader:\s*(\d+)\s*$/i
        );

    if (match) {
        return [
            `🧩 MEMÓRIA | Estratégias: ${match[1]} | Robôs: ${match[2]} | Auto-Traders: ${match[3]}`,
            ...entrada.slice(1)
        ];
    }

    match =
        texto.match(
            /^🧠 Auto Pilot IA\s+(\d+):\s+(\d+)\s+ativo\(s\),\s+(\d+)\s+reserva\(s\),\s+(\d+)\s+sombra\.\s*$/i
        );

    if (match) {
        return [
            `🧠 IA ${match[1]} | Pool: ${match[2]} ativos | ${match[3]} reservas | ${match[4]} sombra`,
            ...entrada.slice(1)
        ];
    }

    match =
        texto.match(
            /^🗑️ Auto Pilot IA:\s+padrão\s+(ia_(\d+)_[A-Za-z0-9]+)\s+desativado imediatamente por\s+([A-Z0-9_:-]+)\s+\(assertividade live=([^,]+),\s*streak RED=(\d+)\)\.\s*$/i
        );

    if (match) {
        return [
            `🗑️ IA ${match[2]} | ${match[3].toUpperCase()} | padrão=${match[1]} | live=${match[4].trim()} | streak RED=${match[5]}`,
            ...entrada.slice(1)
        ];
    }

    const linhas =
        texto
            .split(/\r?\n/)
            .map(
                linha =>
                    linha.trim()
            )
            .filter(Boolean);

    if (
        linhas.length === 0
    ) {
        return undefined;
    }

    const cabecalho =
        linhas[0].match(
            /^🧠 AUTO PILOT IA\s+(\d+)\s+—\s+(.+)$/i
        );

    if (!cabecalho) {
        return undefined;
    }

    const roboId =
        cabecalho[1];

    const motivo =
        String(
            cabecalho[2] || ''
        )
            .trim()
            .toUpperCase();

    /*
     * STARTUP permanece completo.
     *
     * É um diagnóstico único,
     * importante para verificar
     * mineração, Wilson, ranking,
     * shadow e composição inicial.
     */
    if (
        motivo === 'STARTUP'
    ) {
        return entrada;
    }

    const pool =
        linhas.find(
            linha =>
                /^Pool:/i.test(linha)
        );

    /*
     * Fail-safe visual:
     *
     * se aparecer um formato novo
     * que ainda não conhecemos,
     * NÃO eliminamos nenhuma informação.
     */
    if (!pool) {
        return entrada;
    }

    match =
        pool.match(
            /^Pool:\s*(\d+)\/(\d+)\s+ativos\s*\|\s*(\d+)\s+reservas\s*\|\s*(\d+)\s+shadow histórico\s*\|\s*(\d+)\s+shadow live\s*\|\s*(\d+)\s+rejeitados live\s*\|\s*(\d+)\s+fora do pool$/i
        );

    if (!match) {
        return entrada;
    }

    return [
        `🧠 IA ${roboId} | ${motivo} | Pool ${match[1]}/${match[2]} | Reservas ${match[3]} | Shadow H/L ${match[4]}/${match[5]} | Rejeitados ${match[6]} | Fora ${match[7]}`,
        ...entrada.slice(1)
    ];
}


let memoriaOperacionalPendente = null;

function formatarMemoriaOperacionalSequencial(args) {
    const entrada =
        Array.isArray(args)
            ? [...args]
            : [];

    if (
        typeof entrada[0]
        !== 'string'
    ) {
        if (!memoriaOperacionalPendente) {
            return undefined;
        }

        const anterior =
            memoriaOperacionalPendente;

        memoriaOperacionalPendente =
            null;

        return [
            anterior.linhas.join('\n'),
            ...entrada
        ];
    }

    const primeiro =
        entrada[0];

    const limpo =
        primeiro.trim();

    const ehCabecalho =
        /^📂 MEMÓRIA ALOCADA COM SUCESSO:$/i
            .test(limpo);

    if (!memoriaOperacionalPendente) {
        if (!ehCabecalho) {
            return undefined;
        }

        memoriaOperacionalPendente = {
            etapa: 1,
            linhas: [primeiro],
            estrategias: null,
            robos: null
        };

        return null;
    }

    const pendente =
        memoriaOperacionalPendente;

    /*
     * Um novo cabeçalho antes do fechamento
     * não pode apagar silenciosamente o anterior.
     */
    if (ehCabecalho) {
        memoriaOperacionalPendente = {
            etapa: 1,
            linhas: [primeiro],
            estrategias: null,
            robos: null
        };

        return [
            pendente.linhas.join('\n')
        ];
    }

    let match = null;

    if (pendente.etapa === 1) {
        match =
            limpo.match(
                /^-\s*Estratégias Ativas:\s*(\d+)$/i
            );

        if (match) {
            pendente.estrategias =
                match[1];

            pendente.etapa = 2;
            pendente.linhas.push(primeiro);

            return null;
        }
    }

    if (pendente.etapa === 2) {
        match =
            limpo.match(
                /^-\s*Robôs de Canal:\s*(\d+)$/i
            );

        if (match) {
            pendente.robos =
                match[1];

            pendente.etapa = 3;
            pendente.linhas.push(primeiro);

            return null;
        }
    }

    if (pendente.etapa === 3) {
        match =
            limpo.match(
                /^-\s*Motores Auto-Trader:\s*(\d+)$/i
            );

        if (match) {
            memoriaOperacionalPendente =
                null;

            return [
                '🧩 MEMÓRIA'
                + ' | Estratégias: '
                + pendente.estrategias
                + ' | Robôs: '
                + pendente.robos
                + ' | Auto-Traders: '
                + match[1],
                ...entrada.slice(1)
            ];
        }
    }

    /*
     * Fail-safe:
     * se o contrato de quatro linhas mudar,
     * devolvemos tudo que já foi recebido.
     * Nada fica oculto.
     */
    memoriaOperacionalPendente =
        null;

    return [
        pendente.linhas.join('\n')
            + '\n'
            + primeiro,
        ...entrada.slice(1)
    ];
}


function formatarChamadaConsole(nivel, args) {
    const memoria = formatarMemoriaOperacionalSequencial(args);
    if (memoria !== undefined) return memoria;

    const ia = formatarChamadaIaConhecida(nivel, args);
    if (ia !== undefined) return ia;
    const sql =
        formatarFalhaSqlConhecida(
            nivel,
            args
        );

    if (sql) return sql;

    const out = [];

    for (
        const arg of
        Array.isArray(args)
            ? args
            : []
    ) {
        if (
            typeof arg !== 'string'
        ) {
            out.push(arg);
            continue;
        }

        const v =
            formatarTexto(arg);

        if (v === null) {
            return null;
        }

        out.push(v);
    }

    return out;
}

function instalarLogOperacional() {
    if (instalado) return;

    for (
        const nivel of
        ['log', 'info', 'warn', 'error']
    ) {
        const original =
            console[nivel].bind(console);

        console[nivel] =
            (...args) => {
                const saida =
                    formatarChamadaConsole(
                        nivel,
                        args
                    );

                if (saida === null) {
                    return;
                }

                original(...saida);
            };
    }

    onHistoricoRecuperado(
        registrarRecoveryOperacional
    );

    instalado = true;
}

module.exports = {
    instalarLogOperacional,
    formatarTexto,
    registrarSinalOperacional,
    registrarRecoveryOperacional,
    formatarChamadaConsole,
    detalheSql
};
