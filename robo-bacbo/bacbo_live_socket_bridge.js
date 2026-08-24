'use strict';

const liveBus = require('./bacbo_live_bus');

let instalado = false;

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
