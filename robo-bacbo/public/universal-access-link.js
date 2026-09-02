'use strict';

(() => {
    const ACCESS_URL = 'http://127.0.0.1:3010/accesses';

    function install() {
        const header = document.querySelector('.topo-header');
        const title = header?.querySelector('h1');
        if (!title) return false;
        if (document.getElementById('universal-access-link')) return true;

        const link = document.createElement('a');
        link.id = 'universal-access-link';
        link.href = ACCESS_URL;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = '🔐 Acessos';
        link.title = 'Abrir Casas, Contas e Processos de Traders em nova aba';
        link.setAttribute('aria-label', 'Abrir Acessos universais em nova aba');
        link.style.cssText = [
            'display:inline-flex',
            'align-items:center',
            'height:26px',
            'padding:0 7px',
            'margin-left:4px',
            'border:1px solid #3f3f3f',
            'border-radius:999px',
            'background:#181818',
            'color:#aaa',
            'font-size:10px',
            'font-weight:800',
            'text-decoration:none',
            'white-space:nowrap',
            'vertical-align:middle'
        ].join(';');

        const gear = title.querySelector('.gear-icon');
        const speaker = title.querySelector('.speaker-icon, .sound-icon, [title*="som" i], [aria-label*="som" i]');
        const anchor = gear || speaker;
        if (anchor?.nextSibling) {
            title.insertBefore(link, anchor.nextSibling);
        } else if (anchor) {
            title.appendChild(link);
        } else {
            title.appendChild(link);
        }
        return true;
    }

    window.__universalAccessLink = Object.freeze({ install, url: ACCESS_URL });
})();
