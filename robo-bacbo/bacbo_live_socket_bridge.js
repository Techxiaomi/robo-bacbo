'use strict';

const liveBus = require('./bacbo_live_bus');
const { registrarSinalOperacional } = require('./operational_log_formatter');

let instalado = false;

function vincularLogSinais(server) {
    if (!server || typeof server.emit !== 'function' || server.__bacboOperationalSignalLog === true) return;

    const emitOriginal = server.emit.bind(server);
    server.emit = function emitComLogOperacional(evento, ...args) {
        if (evento === 'alerta_painel') {
            try { registrarSinalOperacional(args[0]); } catch (_) {}
        }
        return emitOriginal(evento, ...args);
    };

    Object.defineProperty(server, '__bacboOperationalSignalLog', {
        value: true,
        enumerable: false,
        configurable: false,
        writable: false
    });
}

function instalarBacboLiveSocketBridge() {
    if (instalado) return true;

    const socketIo = require('socket.io');
    const Server = socketIo?.Server;
    const proto = Server?.prototype;
    const attachOriginal = proto?.attach;

    if (!proto || typeof attachOriginal !== 'function') {
        throw new Error('Socket.IO Server.attach indisponível para o bridge live do mapa');
    }

    if (attachOriginal.__bacboLiveBridge === true) {
        instalado = true;
        return true;
    }

    function attachComBacboLive(...args) {
        const retorno = attachOriginal.apply(this, args);
        liveBus.vincularSocketServer(this);
        vincularLogSinais(this);
        return retorno;
    }

    Object.defineProperty(attachComBacboLive, '__bacboLiveBridge', {
        value: true,
        enumerable: false,
        configurable: false,
        writable: false
    });

    proto.attach = attachComBacboLive;
    instalado = true;
    return true;
}

module.exports = { instalarBacboLiveSocketBridge };
