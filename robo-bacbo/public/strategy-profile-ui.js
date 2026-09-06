(() => {
    'use strict';

    function boolEstrutural(valor) {
        if (
            valor === true
            || valor === 1
            || valor === '1'
            || String(valor).trim().toLowerCase() === 'true'
        ) {
            return true;
        }

        if (
            valor === false
            || valor === 0
            || valor === '0'
            || String(valor).trim().toLowerCase() === 'false'
        ) {
            return false;
        }

        return null;
    }

    function estrategiaDinamica(est) {
        return boolEstrutural(
            est?.is_dinamico
        ) === true;
    }

    function perfilDaEstrategia(est) {
        const gales =
            Number(est?.gales);

        const protegerEmpate =
            boolEstrutural(
                est?.proteger_empate
            );

        if (
            !Number.isInteger(gales)
            || gales < 0
            || gales > 2
            || protegerEmpate == null
        ) {
            return null;
        }

        return Object.freeze({
            gales,

            proteger_empate:
                protegerEmpate,

            signature:
                `G${gales}_${
                    protegerEmpate
                        ? 'COM_EMPATE'
                        : 'SEM_EMPATE'
                }`
        });
    }

    function textoPerfil(perfil) {
        if (!perfil) {
            return 'SEM PERFIL';
        }

        return (
            `G${perfil.gales} • `
            + (
                perfil.proteger_empate
                    ? 'COM PROTEÇÃO DE EMPATE'
                    : 'SEM PROTEÇÃO DE EMPATE'
            )
        );
    }

    function estrategiasManuais() {
        if (
            typeof estrategiasGlobais === 'undefined'
            || !Array.isArray(estrategiasGlobais)
        ) {
            return [];
        }

        return estrategiasGlobais.filter(
            est => !estrategiaDinamica(est)
        );
    }

    function perfilDaOrigem(nome) {
        const alvo =
            String(nome ?? '');

        const lista =
            estrategiasManuais().filter(
                est =>
                    String(est?.origem ?? '')
                    === alvo
            );

        if (lista.length === 0) {
            return Object.freeze({
                status: 'EMPTY',
                perfil: null,
                total: 0
            });
        }

        const perfis =
            lista.map(perfilDaEstrategia);

        if (
            perfis.some(
                perfil => perfil == null
            )
        ) {
            return Object.freeze({
                status: 'INVALID',
                perfil: null,
                total: lista.length
            });
        }

        const signatures =
            [...new Set(
                perfis.map(
                    perfil =>
                        perfil.signature
                )
            )];

        if (signatures.length !== 1) {
            return Object.freeze({
                status: 'INCONSISTENT',
                perfil: null,
                total: lista.length
            });
        }

        return Object.freeze({
            status: 'CONSISTENT',
            perfil: perfis[0],
            total: lista.length
        });
    }

    function estrategiaEmEdicao() {
        if (
            typeof estrategiaEditandoId === 'undefined'
            || estrategiaEditandoId == null
        ) {
            return null;
        }

        return (
            estrategiasManuais().find(
                est =>
                    String(est.id)
                    === String(
                        estrategiaEditandoId
                    )
            )
            || null
        );
    }

    function criarInfoApos(
        elemento,
        id
    ) {
        let info =
            document.getElementById(id);

        if (info) {
            return info;
        }

        if (!elemento?.parentElement) {
            return null;
        }

        info =
            document.createElement('div');

        info.id = id;

        info.style.cssText =
            'margin-top:7px;'
            + 'padding:8px 10px;'
            + 'background:#151515;'
            + 'border:1px solid #444;'
            + 'border-radius:6px;'
            + 'font-size:11px;'
            + 'line-height:1.45;';

        elemento.parentElement
            .appendChild(info);

        return info;
    }

    function decorarOrigens() {
        const select =
            document.getElementById('origem');

        if (!select) {
            return;
        }

        Array.from(select.options)
            .forEach(option => {
                const resultado =
                    perfilDaOrigem(
                        option.value
                    );

                let perfilTexto;

                if (
                    resultado.status ===
                    'CONSISTENT'
                ) {
                    perfilTexto =
                        textoPerfil(
                            resultado.perfil
                        );
                } else if (
                    resultado.status === 'EMPTY'
                ) {
                    perfilTexto =
                        'SEM PADRÕES';
                } else {
                    perfilTexto =
                        '⚠ PERFIL INCONSISTENTE';
                }

                option.textContent =
                    `${option.value} — ${perfilTexto}`;
            });
    }

    function atualizarFormularioEstrategia() {
        const origem =
            document.getElementById(
                'origem'
            );

        const gales =
            document.getElementById(
                'gales'
            );

        const empate =
            document.getElementById(
                'proteger_empate'
            );

        if (
            !origem
            || !gales
            || !empate
        ) {
            return;
        }

        const resultado =
            perfilDaOrigem(
                origem.value
            );

        const atual =
            estrategiaEmEdicao();

        const estrategiasOrigem =
            estrategiasManuais().filter(
                est =>
                    String(est.origem ?? '')
                    === String(origem.value)
            );

        const unicoPadraoAtual =
            Boolean(
                atual
                && estrategiasOrigem.length === 1
                && String(
                    estrategiasOrigem[0].id
                ) === String(atual.id)
            );

        const trava =
            resultado.status === 'CONSISTENT'
            && !unicoPadraoAtual;

        if (trava) {
            gales.value =
                String(
                    resultado.perfil.gales
                );

            empate.checked =
                resultado
                    .perfil
                    .proteger_empate;
        }

        gales.disabled = trava;
        empate.disabled = trava;

        const info =
            criarInfoApos(
                origem,
                'strategy-profile-origin-info'
            );

        if (!info) {
            return;
        }

        if (
            resultado.status === 'CONSISTENT'
        ) {
            info.style.borderColor =
                '#28a745';

            info.style.color =
                '#b9e7c4';

            info.innerHTML =
                '🧬 <strong>Perfil da origem:</strong> '
                + textoPerfil(
                    resultado.perfil
                )
                + ` · ${resultado.total} padrão(ões)`
                + (
                    unicoPadraoAtual
                        ? '<br><span style="color:#ffc107;">Único padrão da origem: esta edição pode redefinir o perfil.</span>'
                        : '<br><span style="color:#888;">Gale e proteção de empate são herdados desta origem.</span>'
                );

            return;
        }

        if (
            resultado.status === 'EMPTY'
        ) {
            info.style.borderColor =
                '#17a2b8';

            info.style.color =
                '#9edce6';

            info.innerHTML =
                '🧬 <strong>Origem sem padrões:</strong> '
                + 'o primeiro padrão definirá o perfil estrutural.';

            return;
        }

        info.style.borderColor =
            '#dc3545';

        info.style.color =
            '#ffaaaa';

        info.innerHTML =
            '⛔ Esta origem possui perfil estrutural inconsistente.';
    }

    function selecionados(classe) {
        return Array.from(
            document.querySelectorAll(
                `.${classe}:checked`
            )
        ).map(
            item => String(item.value)
        );
    }

    function perfilEstrategiaPorId(id) {
        const estrategia =
            estrategiasManuais().find(
                est =>
                    String(est.id)
                    === String(id)
            );

        return estrategia
            ? perfilDaEstrategia(estrategia)
            : null;
    }

    function estrategiasEfetivasManuaisRobo() {
        const origens =
            selecionados(
                'chk-robo-origem'
            );

        const avulsos =
            selecionados(
                'chk-robo-avulso'
            );

        const excecoes =
            new Set(
                selecionados(
                    'chk-robo-excecao'
                )
            );

        return estrategiasManuais()
            .filter(est => {
                const id =
                    String(est.id);

                if (excecoes.has(id)) {
                    return false;
                }

                if (avulsos.includes(id)) {
                    return true;
                }

                return origens.includes(
                    String(
                        est.origem ?? ''
                    )
                );
            });
    }

    function perfisFilhosIaExistentes() {
        if (
            typeof roboEditandoId === 'undefined'
            || roboEditandoId == null
            || typeof estrategiasGlobais === 'undefined'
            || !Array.isArray(estrategiasGlobais)
        ) {
            return [];
        }

        return estrategiasGlobais
            .filter(
                est =>
                    estrategiaDinamica(est)
                    && Number(
                        est.robo_dono_id
                    ) === Number(
                        roboEditandoId
                    )
            )
            .map(perfilDaEstrategia)
            .filter(Boolean);
    }

    function perfilIaConfigurado() {
        const ativo =
            document.getElementById(
                'robo-ia-ativo'
            );

        const gales =
            document.getElementById(
                'robo-ia-gales'
            );

        const empate =
            document.getElementById(
                'robo-ia-prot'
            );

        if (
            !ativo?.checked
            || !gales
            || !empate
        ) {
            return null;
        }

        return perfilDaEstrategia({
            gales:
                gales.value,

            proteger_empate:
                empate.checked
        });
    }

    function perfisRoboSemConfigIa() {
        return [
            ...estrategiasEfetivasManuaisRobo()
                .map(perfilDaEstrategia)
                .filter(Boolean),

            ...perfisFilhosIaExistentes()
        ];
    }

    function perfilBaseRoboSemConfigIa() {
        const perfis =
            perfisRoboSemConfigIa();

        const signatures =
            [...new Set(
                perfis.map(
                    p => p.signature
                )
            )];

        if (signatures.length !== 1) {
            return null;
        }

        return perfis[0] || null;
    }

    function perfisEfetivosRobo() {
        const perfis =
            [...perfisRoboSemConfigIa()];

        const ia =
            perfilIaConfigurado();

        if (ia) {
            perfis.push(ia);
        }

        return perfis;
    }

    function signaturesRobo() {
        return [
            ...new Set(
                perfisEfetivosRobo()
                    .map(
                        p => p.signature
                    )
            )
        ];
    }

    function garantirInfoRobo() {
        const tab =
            document.getElementById(
                'robo-tab-sint'
            );

        if (!tab) {
            return null;
        }

        let info =
            document.getElementById(
                'robo-perfil-estrutural-info'
            );

        if (!info) {
            info =
                document.createElement(
                    'div'
                );

            info.id =
                'robo-perfil-estrutural-info';

            info.style.cssText =
                'margin-bottom:12px;'
                + 'padding:10px 12px;'
                + 'background:#151515;'
                + 'border:1px solid #444;'
                + 'border-radius:7px;'
                + 'font-size:11px;'
                + 'line-height:1.45;';

            tab.insertBefore(
                info,
                tab.firstChild
            );
        }

        return info;
    }

    function adicionarBadge(
        checkbox,
        texto
    ) {
        const label =
            checkbox.closest('label');

        if (!label) {
            return;
        }

        let badge =
            label.querySelector(
                '.strategy-profile-badge'
            );

        if (!badge) {
            badge =
                document.createElement(
                    'small'
                );

            badge.className =
                'strategy-profile-badge';

            badge.style.cssText =
                'margin-left:auto;'
                + 'font-size:9px;'
                + 'color:#888;';

            label.appendChild(badge);
        }

        badge.textContent = texto;
    }

    function sincronizarIa() {
        const ativo =
            document.getElementById(
                'robo-ia-ativo'
            );

        const gales =
            document.getElementById(
                'robo-ia-gales'
            );

        const empate =
            document.getElementById(
                'robo-ia-prot'
            );

        if (
            !ativo
            || !gales
            || !empate
        ) {
            return;
        }

        const base =
            perfilBaseRoboSemConfigIa();

        const deveHerdar =
            ativo.checked
            && Boolean(base);

        if (deveHerdar) {
            gales.value =
                String(base.gales);

            empate.checked =
                base.proteger_empate;
        }

        gales.disabled =
            deveHerdar;

        empate.disabled =
            deveHerdar;
    }

    function atualizarRobo() {
        sincronizarIa();

        const signatures =
            signaturesRobo();

        const perfilBase =
            signatures.length === 1
                ? perfisEfetivosRobo()[0]
                : null;

        const info =
            garantirInfoRobo();

        if (info) {
            if (
                signatures.length === 0
            ) {
                info.style.borderColor =
                    '#17a2b8';

                info.style.color =
                    '#9edce6';

                info.innerHTML =
                    '🧬 <strong>Perfil do robô:</strong> ainda não definido. '
                    + 'A primeira seleção definirá sua estrutura.';
            } else if (
                signatures.length === 1
            ) {
                info.style.borderColor =
                    '#28a745';

                info.style.color =
                    '#b9e7c4';

                info.innerHTML =
                    '🧬 <strong>Perfil do robô:</strong> '
                    + textoPerfil(perfilBase)
                    + '<br><span style="color:#888;">Opções incompatíveis ficam indisponíveis.</span>';
            } else {
                info.style.borderColor =
                    '#dc3545';

                info.style.color =
                    '#ffaaaa';

                info.innerHTML =
                    '⛔ <strong>Composição estrutural incompatível:</strong> '
                    + signatures.join(' + ');
            }
        }

        const baseSignature =
            signatures.length === 1
                ? signatures[0]
                : null;

        document
            .querySelectorAll(
                '.chk-robo-origem'
            )
            .forEach(checkbox => {
                const resultado =
                    perfilDaOrigem(
                        checkbox.value
                    );

                const perfil =
                    resultado.perfil;

                adicionarBadge(
                    checkbox,
                    resultado.status
                        === 'CONSISTENT'
                        ? textoPerfil(perfil)
                        : (
                            resultado.status === 'EMPTY'
                                ? 'SEM PADRÕES'
                                : '⚠ INCONSISTENTE'
                        )
                );

                if (checkbox.checked) {
                    checkbox.disabled = false;
                    return;
                }

                checkbox.disabled =
                    Boolean(
                        baseSignature
                        && perfil
                        && perfil.signature
                            !== baseSignature
                    );
            });

        document
            .querySelectorAll(
                '.chk-robo-avulso'
            )
            .forEach(checkbox => {
                const perfil =
                    perfilEstrategiaPorId(
                        checkbox.value
                    );

                adicionarBadge(
                    checkbox,
                    perfil
                        ? textoPerfil(perfil)
                        : 'PERFIL INVÁLIDO'
                );

                if (checkbox.checked) {
                    checkbox.disabled = false;
                    return;
                }

                checkbox.disabled =
                    Boolean(
                        baseSignature
                        && perfil
                        && perfil.signature
                            !== baseSignature
                    );
            });

        document
            .querySelectorAll(
                '.chk-robo-excecao'
            )
            .forEach(
                checkbox => {
                    checkbox.disabled = false;
                }
            );
    }

    function feedback(
        modalId,
        mensagem,
        erro = true
    ) {
        const modal =
            document.getElementById(
                modalId
            );

        const content =
            modal?.querySelector(
                '.modal-form-content'
            );

        if (!content) {
            alert(mensagem);
            return;
        }

        let box =
            content.querySelector(
                '.strategy-profile-feedback'
            );

        if (!box) {
            box =
                document.createElement(
                    'div'
                );

            box.className =
                'strategy-profile-feedback';

            box.style.cssText =
                'padding:10px 12px;'
                + 'margin:0 0 12px;'
                + 'border-radius:6px;'
                + 'font-size:12px;'
                + 'line-height:1.45;';

            content.insertBefore(
                box,
                content.children[1]
                    || content.firstChild
            );
        }

        box.style.background =
            erro
                ? '#35191b'
                : '#14291a';

        box.style.border =
            erro
                ? '1px solid #8d3038'
                : '1px solid #285b36';

        box.style.color =
            erro
                ? '#ffaaaa'
                : '#b9e7c4';

        box.textContent =
            mensagem;
    }

    function mensagem409(payload) {
        switch (
            String(payload?.erro ?? '')
        ) {
            case 'ESTRATEGIA_PERFIL_INCOMPATIVEL_COM_ORIGEM':
                return (
                    'Perfil incompatível com a origem. '
                    + `Esperado: ${payload.perfil_esperado || '—'}. `
                    + `Recebido: ${payload.perfil_recebido || '—'}.`
                );

            case 'ESTRATEGIA_ORIGEM_INEXISTENTE':
                return (
                    'A origem selecionada não existe mais. '
                    + 'Atualize a tela e tente novamente.'
                );

            case 'ORIGEM_ESTADO_ESTRUTURAL_INVALIDO':
                return (
                    'A origem possui padrões estruturalmente incompatíveis.'
                );

            case 'ROBO_PERFIL_ESTRUTURAL_INCOMPATIVEL': {
                const perfis =
                    Array.isArray(
                        payload?.perfis_encontrados
                    )
                        ? payload
                            .perfis_encontrados
                            .map(
                                item =>
                                    item.signature
                            )
                            .filter(Boolean)
                            .join(', ')
                        : '';

                return (
                    'O robô possui origens ou padrões de estruturas diferentes.'
                    + (
                        perfis
                            ? ` Perfis encontrados: ${perfis}.`
                            : ''
                    )
                );
            }

            case 'ROBO_REFERENCIAS_INVALIDAS':
                return (
                    'O robô referencia uma origem ou padrão que não existe mais.'
                );

            default:
                return (
                    payload?.mensagem
                    || 'A operação foi recusada pela validação estrutural.'
                );
        }
    }

    async function respostaJson(res) {
        try {
            return await res.json();
        } catch (_) {
            return {};
        }
    }

    function ligarEventosRobo() {
        document
            .querySelectorAll(
                '.chk-robo-origem,'
                + '.chk-robo-avulso,'
                + '.chk-robo-excecao'
            )
            .forEach(checkbox => {
                if (
                    checkbox.dataset
                        .perfilEstruturalLigado
                    === '1'
                ) {
                    return;
                }

                checkbox.dataset
                    .perfilEstruturalLigado =
                    '1';

                checkbox.addEventListener(
                    'change',
                    () => {
                        if (
                            signaturesRobo()
                                .length > 1
                        ) {
                            checkbox.checked =
                                !checkbox.checked;

                            feedback(
                                'modal-robo',
                                'Seleção revertida: ela criaria um robô com perfis estruturais diferentes.',
                                true
                            );
                        }

                        atualizarRobo();
                    }
                );
            });

        [
            'robo-ia-ativo',
            'robo-ia-gales',
            'robo-ia-prot'
        ].forEach(id => {
            const el =
                document.getElementById(id);

            if (
                !el
                || el.dataset
                    .perfilEstruturalLigado
                    === '1'
            ) {
                return;
            }

            el.dataset
                .perfilEstruturalLigado =
                '1';

            el.addEventListener(
                'change',
                () => {
                    atualizarRobo();

                    if (
                        signaturesRobo()
                            .length > 1
                    ) {
                        feedback(
                            'modal-robo',
                            'A configuração IA diverge do perfil estrutural do robô.',
                            true
                        );
                    }
                }
            );
        });
    }

    function instalarEstrategias() {
        const originalAbrir =
            window.abrirFormularioNova;

        const originalEditar =
            window.prepararEdicao;

        const originalCarregar =
            window.carregarOrigens;

        if (
            typeof originalAbrir ===
            'function'
        ) {
            window.abrirFormularioNova =
                function (...args) {
                    const retorno =
                        originalAbrir.apply(
                            this,
                            args
                        );

                    decorarOrigens();
                    atualizarFormularioEstrategia();

                    return retorno;
                };
        }

        if (
            typeof originalEditar ===
            'function'
        ) {
            window.prepararEdicao =
                function (...args) {
                    const retorno =
                        originalEditar.apply(
                            this,
                            args
                        );

                    decorarOrigens();
                    atualizarFormularioEstrategia();

                    return retorno;
                };
        }

        if (
            typeof originalCarregar ===
            'function'
        ) {
            window.carregarOrigens =
                async function (...args) {
                    const retorno =
                        await originalCarregar.apply(
                            this,
                            args
                        );

                    decorarOrigens();
                    atualizarFormularioEstrategia();

                    return retorno;
                };
        }

        const select =
            document.getElementById(
                'origem'
            );

        if (
            select
            && select.dataset
                .perfilEstruturalLigado
                !== '1'
        ) {
            select.dataset
                .perfilEstruturalLigado =
                '1';

            select.addEventListener(
                'change',
                atualizarFormularioEstrategia
            );
        }

        window.salvarPadrao =
            async function () {
                const data = {
                    nome:
                        document
                            .getElementById('nome')
                            .value,

                    origem:
                        document
                            .getElementById('origem')
                            .value,

                    padrao:
                        document
                            .getElementById('padrao')
                            .value,

                    entrada:
                        document
                            .getElementById('entrada')
                            .value,

                    gales:
                        document
                            .getElementById('gales')
                            .value,

                    protegerEmpate:
                        document
                            .getElementById(
                                'proteger_empate'
                            )
                            .checked,

                    ativo:
                        document
                            .getElementById('ativo')
                            .checked
                };

                if (
                    !data.nome
                    || !data.padrao
                ) {
                    return alert(
                        'Preencha Nome e Padrão'
                    );
                }

                try {
                    const editando =
                        typeof estrategiaEditandoId
                            !== 'undefined'
                        && estrategiaEditandoId
                            !== null;

                    const res =
                        await fetch(
                            editando
                                ? '/api/estrategia/'
                                    + estrategiaEditandoId
                                : '/api/novo-padrao',
                            {
                                method:
                                    editando
                                        ? 'PUT'
                                        : 'POST',

                                headers: {
                                    'Content-Type':
                                        'application/json'
                                },

                                body:
                                    JSON.stringify(data)
                            }
                        );

                    const payload =
                        await respostaJson(res);

                    if (!res.ok) {
                        feedback(
                            'modal-cadastro',
                            res.status === 409
                                ? mensagem409(payload)
                                : (
                                    payload?.mensagem
                                    || 'Erro ao salvar a estratégia.'
                                ),
                            true
                        );

                        return;
                    }

                    if (
                        payload.sucesso
                        !== true
                    ) {
                        feedback(
                            'modal-cadastro',
                            'A API não confirmou o salvamento da estratégia.',
                            true
                        );

                        return;
                    }

                    fecharFormulario();

                    await inicializarSistema();
                } catch (_) {
                    feedback(
                        'modal-cadastro',
                        'Erro de conexão ao salvar a estratégia.',
                        true
                    );
                }
            };
    }

    function instalarRobos() {
        const originalRender =
            window.renderizarSintonizadorRobo;

        const originalAbrir =
            window.abrirFormularioRobo;

        const originalEditar =
            window.prepararEdicaoRobo;

        if (
            typeof originalRender ===
            'function'
        ) {
            window.renderizarSintonizadorRobo =
                function (...args) {
                    const retorno =
                        originalRender.apply(
                            this,
                            args
                        );

                    ligarEventosRobo();
                    atualizarRobo();

                    return retorno;
                };
        }

        if (
            typeof originalAbrir ===
            'function'
        ) {
            window.abrirFormularioRobo =
                function (...args) {
                    const retorno =
                        originalAbrir.apply(
                            this,
                            args
                        );

                    ligarEventosRobo();
                    atualizarRobo();

                    return retorno;
                };
        }

        if (
            typeof originalEditar ===
            'function'
        ) {
            window.prepararEdicaoRobo =
                function (...args) {
                    const retorno =
                        originalEditar.apply(
                            this,
                            args
                        );

                    ligarEventosRobo();
                    atualizarRobo();

                    return retorno;
                };
        }

        window.salvarRobo =
            async function () {
                const roboBase =
                    (
                        typeof roboEditandoId !==
                            'undefined'
                        && roboEditandoId !== null
                    )
                        ? robosGlobais.find(
                            robo =>
                                Number(robo.id)
                                === Number(
                                    roboEditandoId
                                )
                        )
                        : null;

                const payload =
                    construirPayloadRobo(
                        roboBase
                    );

                if (!payload.nome) {
                    return alert(
                        'Preencha o Nome do Robô / Sala.'
                    );
                }

                if (
                    signaturesRobo()
                        .length > 1
                ) {
                    feedback(
                        'modal-robo',
                        'Não é possível salvar: o robô possui perfis estruturais diferentes.',
                        true
                    );

                    return;
                }

                const tokenJaConfigurado =
                    Boolean(
                        roboBase
                            ?.telegram_configurado
                    );

                if (
                    payload.enviar_telegram
                    && !payload.telegram_token
                    && !tokenJaConfigurado
                ) {
                    return alert(
                        'Informe o Token do Bot ou desative "Enviar para Telegram".'
                    );
                }

                const possuiDestinoTelegram =
                    payload.telegram_chat_id !== ''
                    || payload.destinatarios.length > 0;

                if (
                    payload.enviar_telegram
                    && !possuiDestinoTelegram
                ) {
                    return alert(
                        'Informe o Chat ID principal ou adicione ao menos um destinatário do Telegram.'
                    );
                }

                try {
                    const editando =
                        typeof roboEditandoId !==
                            'undefined'
                        && roboEditandoId !== null;

                    const url =
                        editando
                            ? `/api/robo/${roboEditandoId}`
                            : '/api/robo';

                    const method =
                        editando
                            ? 'PUT'
                            : 'POST';

                    const res =
                        await fetch(
                            url,
                            {
                                method,

                                headers: {
                                    'Content-Type':
                                        'application/json'
                                },

                                body:
                                    JSON.stringify(
                                        payload
                                    )
                            }
                        );

                    const resposta =
                        await respostaJson(
                            res
                        );

                    if (!res.ok) {
                        feedback(
                            'modal-robo',

                            res.status === 409
                                ? mensagem409(
                                    resposta
                                )
                                : (
                                    resposta?.mensagem
                                    || resposta?.erro
                                    || 'Erro ao salvar o robô.'
                                ),

                            true
                        );

                        return;
                    }

                    if (
                        resposta?.sucesso ===
                            false
                    ) {
                        feedback(
                            'modal-robo',

                            resposta?.mensagem
                            || resposta?.erro
                            || 'A API não confirmou o salvamento do robô.',

                            true
                        );

                        return;
                    }

                    fecharFormularioRobo();

                    await carregarRobos();
                }
                catch (_) {
                    feedback(
                        'modal-robo',
                        'Erro de conexão ao salvar o robô.',
                        true
                    );
                }
            };
    }

    function install() {
        if (
            window.__strategyProfileUiInstalled
            === true
        ) {
            return true;
        }

        if (
            typeof window.abrirFormularioNova
                !== 'function'
            || typeof window
                .renderizarSintonizadorRobo
                !== 'function'
        ) {
            return false;
        }

        instalarEstrategias();
        instalarRobos();

        decorarOrigens();

        window.__strategyProfileUiInstalled =
            true;

        return true;
    }

    window.__strategyProfileUi =
        Object.freeze({
            boolEstrutural,
            perfilDaEstrategia,
            textoPerfil,
            perfilDaOrigem,
            mensagem409,
            install
        });

    window.__strategyProfileUiReady =
        true;
})();
