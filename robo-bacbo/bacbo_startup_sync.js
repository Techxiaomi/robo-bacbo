'use strict';

const ROAD_SNAPSHOT_KEY = 'robo_bacbo:last_road_snapshot';

async function sincronizarSnapshotRetido(processarBacbo) {
    if (typeof processarBacbo !== 'function') {
        throw new TypeError('processarBacbo ausente no startup sync');
    }

    const { createClient } = require('redis');
    const redisUrl = String(process.env.REDIS_URL || 'redis://127.0.0.1:6379').trim() || 'redis://127.0.0.1:6379';
    const cliente = createClient({
        url: redisUrl,
        socket: {
            connectTimeout: 3000,
            reconnectStrategy: () => false
        }
    });

    cliente.on('error', erro => {
        console.warn(`⚠️ Startup ROAD Redis: ${erro.message}`);
    });

    try {
        await cliente.connect();
        const bruto = await cliente.get(ROAD_SNAPSHOT_KEY);
        if (!bruto) {
            console.log('ℹ️ Startup ROAD: nenhum snapshot retido ainda; aguardando coletor publicar bacbo.road.');
            return false;
        }

        let snapshot;
        try {
            snapshot = JSON.parse(bruto);
        } catch (erro) {
            console.warn(`⚠️ Startup ROAD: snapshot retido inválido: ${erro.message}`);
            return false;
        }

        const history = Array.isArray(snapshot?.history) ? snapshot.history : [];
        console.log(`♻️ Startup ROAD: snapshot retido encontrado | ${history.length} registro(s).`);
        const processado = await processarBacbo(JSON.stringify(snapshot));
        if (processado) {
            console.log(`✅ Startup ROAD sincronizado com Node | ${history.length} registro(s).`);
        } else {
            console.warn(`⚠️ Startup ROAD encontrado, mas não foi aceito pelo runtime | ${history.length} registro(s).`);
        }
        return Boolean(processado);
    } catch (erro) {
        console.warn(`⚠️ Startup ROAD não pôde recuperar snapshot retido: ${erro.message}`);
        return false;
    } finally {
        try {
            if (cliente.isOpen) await cliente.quit();
        } catch (_) { }
    }
}

module.exports = { sincronizarSnapshotRetido };
