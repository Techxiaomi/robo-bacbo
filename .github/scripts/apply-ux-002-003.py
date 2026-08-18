from pathlib import Path

path = Path('robo-bacbo/bot2_coletor.js')
text = path.read_text(encoding='utf-8')

if 'UX-002/003: estatísticas cronológicas dos robôs' in text:
    print('UX-002/003 já aplicado; nada a fazer.')
    raise SystemExit(0)

start_robos = text.index('app.get("/api/robos", async (req, res) => {')
end_robos = text.index('\n\napp.post("/api/robo", async (req, res) => {', start_robos)

novo_robos = r'''app.get("/api/robos", async (req, res) => {
    try {
        const [linhas] = await dbPool.query('SELECT * FROM robos_canais ORDER BY id DESC');
        const [destinatarios] = await dbPool.query('SELECT * FROM destinatarios_robo');
        const [countDinamicos] = await dbPool.query('SELECT robo_dono_id, COUNT(id) as qtd FROM estrategias WHERE is_dinamico = true GROUP BY robo_dono_id');

        // UX-002/003: estatísticas cronológicas dos robôs para os cards e máximas de sequência.
        const [historicoRobos] = await dbPool.query(`
            SELECT
                id, robo_id, tipo_resultado, nivel, multiplicador,
                data_hora >= DATE_SUB(NOW(), INTERVAL 24 HOUR) AS is_24h,
                DATE(data_hora) = CURDATE() AS is_hoje,
                YEARWEEK(data_hora, 0) = YEARWEEK(CURDATE(), 0) AS is_semana,
                YEAR(data_hora) = YEAR(CURDATE()) AND MONTH(data_hora) = MONTH(CURDATE()) AS is_mes
            FROM historico_disparos_robos
            ORDER BY robo_id ASC, data_hora ASC, id ASC
        `);

        let mapRobos = {};
        let sequenciasRobos = {};
        const createEmptyPeriod = () => ({
            green_direto: 0,
            gale1: 0,
            gale2: 0,
            red: 0,
            ties: { direto:{}, gale1:{}, gale2:{} },
            max_green_seq: 0,
            max_red_seq: 0
        });
        const createEmptyStats = () => ({
            '24h': createEmptyPeriod(),
            hoje: createEmptyPeriod(),
            semana: createEmptyPeriod(),
            mes: createEmptyPeriod(),
            geral: createEmptyPeriod()
        });
        const createEmptyStreaks = () => ({
            '24h': { green: 0, red: 0 },
            hoje: { green: 0, red: 0 },
            semana: { green: 0, red: 0 },
            mes: { green: 0, red: 0 },
            geral: { green: 0, red: 0 }
        });

        linhas.forEach(r => {
            mapRobos[r.id] = createEmptyStats();
            sequenciasRobos[r.id] = createEmptyStreaks();
        });

        historicoRobos.forEach(row => {
            let rid = row.robo_id;
            if (!mapRobos[rid] || !sequenciasRobos[rid]) return;

            let levelKey = 'green_direto';
            let tieLevelKey = 'direto';
            if (row.nivel === 'GALE1') { levelKey = 'gale1'; tieLevelKey = 'gale1'; }
            if (row.nivel === 'GALE2') { levelKey = 'gale2'; tieLevelKey = 'gale2'; }

            const addStat = (period) => {
                const stats = mapRobos[rid][period];
                const streak = sequenciasRobos[rid][period];

                if (row.tipo_resultado === 'GREEN') {
                    stats[levelKey]++;
                } else if (row.tipo_resultado === 'RED') {
                    stats.red++;
                } else if (row.tipo_resultado === 'TIE') {
                    let m = row.multiplicador || '4x';
                    if (!stats.ties[tieLevelKey][m]) stats.ties[tieLevelKey][m] = 0;
                    stats.ties[tieLevelKey][m]++;
                }

                if (row.tipo_resultado === 'GREEN' || row.tipo_resultado === 'TIE') {
                    streak.green++;
                    streak.red = 0;
                    stats.max_green_seq = Math.max(stats.max_green_seq, streak.green);
                } else if (row.tipo_resultado === 'RED') {
                    streak.red++;
                    streak.green = 0;
                    stats.max_red_seq = Math.max(stats.max_red_seq, streak.red);
                } else {
                    streak.green = 0;
                    streak.red = 0;
                }
            };

            if (row.is_24h) addStat('24h');
            if (row.is_hoje) addStat('hoje');
            if (row.is_semana) addStat('semana');
            if (row.is_mes) addStat('mes');
            addStat('geral');
        });

        let robosSanitizados = linhas.map(r => {
            let confObj = { origens: [], avulsos: [], excecoes: [], mostrar_nome: true, mostrar_padrao: true, mostrar_assertividade: true, detalhar_empates: true, cabecalho: '', rodape: '', auto_tuning: { ativo: false }, cooldown: { ativo: false } };
            try { if (r.config_json) confObj = { ...confObj, ...JSON.parse(r.config_json) }; } catch(err){}
            let meusDestinatarios = destinatarios.filter(d => d.robo_id === r.id);
            let contagemIA = countDinamicos.find(d => d.robo_dono_id === r.id);
            let cState = estadoStandbyRobos[r.id];
            const { telegram_token: telegramTokenPrivado, ...roboPublico } = r;
            return {
                ...roboPublico,
                telegram_configurado: Boolean(String(telegramTokenPrivado || '').trim()),
                config: confObj,
                destinatarios: meusDestinatarios,
                qtd_padroes_ia: contagemIA ? contagemIA.qtd : 0,
                detalhes: mapRobos[r.id],
                em_standby_ate: cState ? cState.em_standby_ate : 0
            };
        });

        res.json(robosSanitizados);
    } catch(e) { console.error('❌ GET /api/robos falhou:', e.message); res.status(500).json([]); }
});'''

text = text[:start_robos] + novo_robos + text[end_robos:]

start_dash = text.index('app.get("/api/dashboard-stats", async (req, res) => {')
end_dash = text.index('\n\napp.get("/api/historico-giros", async (req, res) => {', start_dash)

novo_dash = r'''app.get("/api/dashboard-stats", async (req, res) => {
    try {
        const { robo_id, periodo = '24h', origem = 'TODAS' } = req.query;
        let queryWhere = "WHERE 1=1";
        let queryParams = [];

        if (periodo === '24h') queryWhere += " AND h.data_hora >= DATE_SUB(NOW(), INTERVAL 24 HOUR)";
        else if (periodo === 'hoje') queryWhere += " AND DATE(h.data_hora) = CURDATE()";
        else if (periodo === 'semana') queryWhere += " AND YEARWEEK(h.data_hora, 0) = YEARWEEK(CURDATE(), 0)";
        else if (periodo === 'mes') queryWhere += " AND YEAR(h.data_hora) = YEAR(CURDATE()) AND MONTH(h.data_hora) = MONTH(CURDATE())";

        if (robo_id && robo_id !== 'TODOS') { queryWhere += " AND h.robo_id = ?"; queryParams.push(robo_id); }
        if (origem && origem !== 'TODAS') { queryWhere += " AND h.estrategia_origem = ?"; queryParams.push(origem); }

        const [linhas] = await dbPool.query(`
            SELECT h.id, h.tipo_resultado, h.nivel, h.multiplicador, h.data_hora
            FROM historico_disparos_robos h
            LEFT JOIN estrategias e ON h.estrategia_id = e.id
            ${queryWhere}
            ORDER BY h.data_hora ASC, h.id ASC
        `, queryParams);

        let sinais = linhas.length;
        let greens = 0;
        let reds = 0;
        let ties = 0;
        let greenSeq = 0;
        let redSeq = 0;
        let maxGreenSeq = 0;
        let maxRedSeq = 0;

        linhas.forEach(row => {
            if (row.tipo_resultado === 'GREEN' || row.tipo_resultado === 'TIE') {
                greens++;
                if (row.tipo_resultado === 'TIE') ties++;
                greenSeq++;
                redSeq = 0;
                maxGreenSeq = Math.max(maxGreenSeq, greenSeq);
            } else if (row.tipo_resultado === 'RED') {
                reds++;
                redSeq++;
                greenSeq = 0;
                maxRedSeq = Math.max(maxRedSeq, redSeq);
            } else {
                greenSeq = 0;
                redSeq = 0;
            }
        });

        let assertividade = (sinais > 0) ? ((greens / sinais) * 100).toFixed(1) : 0;
        res.json({
            sinais,
            greens,
            reds,
            ties,
            max_green_seq: maxGreenSeq,
            max_red_seq: maxRedSeq,
            assertividade: assertividade + '%'
        });
    } catch (e) {
        console.error('❌ GET /api/dashboard-stats falhou:', e.message);
        res.status(500).json({
            sinais: 0,
            greens: 0,
            reds: 0,
            ties: 0,
            max_green_seq: 0,
            max_red_seq: 0,
            assertividade: '0%'
        });
    }
});'''

text = text[:start_dash] + novo_dash + text[end_dash:]
path.write_text(text, encoding='utf-8')
print('UX-002/003 aplicado em bot2_coletor.js')
