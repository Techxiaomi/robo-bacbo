'use strict';

(() => {
    const ACCESS_URL = 'http://127.0.0.1:3010/accesses';

    function normalizeHeaderTooltips(title) {
        const speaker = title.querySelector('#btn-som');
        if (speaker) {
            speaker.title = 'Áudio';
            speaker.setAttribute('aria-label', 'Áudio');
        }

        const gear = title.querySelector('.gear-icon.spin');
        if (gear) {
            gear.title = 'Configurações';
            gear.setAttribute('aria-label', 'Configurações');
        }

        return { speaker, gear };
    }

    function install() {
        const header = document.querySelector('.topo-header');
        const title = header?.querySelector('h1');
        if (!title) return false;

        const { gear } = normalizeHeaderTooltips(title);

        let link = document.getElementById('universal-access-link');
        if (!link) {
            link = document.createElement('a');
            link.id = 'universal-access-link';
            link.href = ACCESS_URL;
            link.target = '_blank';
            link.rel = 'noopener';
            link.className = 'gear-icon universal-access-icon';
            link.textContent = '🔒';
            link.title = 'Acessos';
            link.setAttribute('aria-label', 'Acessos');
            link.style.cssText = [
                'margin-left:12px',
                'color:#aaa',
                'text-decoration:none',
                'font-size:20px',
                'line-height:1',
                'cursor:pointer'
            ].join(';');
        }

        // Ordem visual obrigatória: alto-falante -> engrenagem -> cadeado.
        if (gear?.nextSibling) {
            title.insertBefore(link, gear.nextSibling);
        } else if (gear) {
            title.appendChild(link);
        } else {
            title.appendChild(link);
        }

        return true;
    }

    window.__universalAccessLink = Object.freeze({ install, url: ACCESS_URL });
})();
