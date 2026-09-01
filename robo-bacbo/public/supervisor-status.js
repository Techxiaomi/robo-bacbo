'use strict';

const POLL_MS = 4000;

function $(id) {
    return document.getElementById(id);
}

function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
}

function text(value, fallback = '—') {
    const normalized = String(value ?? '').trim();
    return normalized || fallback;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function renderWorker(worker) {
    const status = text(worker.status, 'STOPPED').toUpperCase();
    const allowed = new Set(['STARTING', 'READY', 'BACKOFF', 'STOPPING', 'STOPPED', 'ERROR']);
    const safeStatus = allowed.has(status) ? status : 'ERROR';
    return `
        <tr>
            <td class="session">${escapeHtml(text(worker.session_id))}</td>
            <td>${escapeHtml(text(worker.account_name))}<div class="muted">#${escapeHtml(text(worker.account_id))}</div></td>
            <td>${escapeHtml(text(worker.table_name))}<div class="muted">${escapeHtml(text(worker.table_key))}</div></td>
            <td>${escapeHtml(text(worker.pid))}</td>
            <td><span class="badge ${safeStatus}">${safeStatus}</span></td>
            <td>${escapeHtml(formatDuration(worker.uptime_ms))}</td>
            <td>${escapeHtml(String(Number(worker.restart_attempts || 0)))}</td>
            <td>${worker.desired ? 'Sim' : 'Não'}</td>
            <td class="erro-texto">${escapeHtml(text(worker.last_error, ''))}</td>
        </tr>
    `;
}

function render(snapshot) {
    const workers = Array.isArray(snapshot.workers) ? snapshot.workers : [];
    const ready = workers.filter(item => item.status === 'READY').length;
    const problems = workers.filter(item => item.status === 'BACKOFF' || item.status === 'ERROR').length;

    $('total-workers').textContent = String(workers.length);
    $('total-ready').textContent = String(ready);
    $('total-problemas').textContent = String(problems);
    $('supervisor-pid').textContent = text(snapshot.supervisor?.pid);

    const healthy = snapshot.healthy === true;
    $('health-dot').className = `dot ${healthy ? 'ok' : 'erro'}`;
    if (healthy) {
        $('health-text').textContent = 'Supervisor online e telemetria atualizada';
    } else if (snapshot.stale) {
        $('health-text').textContent = 'Telemetria desatualizada ou Supervisor offline';
    } else {
        $('health-text').textContent = 'Supervisor indisponível';
    }

    $('updated-at').textContent = snapshot.generated_at
        ? `Atualizado: ${new Date(snapshot.generated_at).toLocaleString('pt-BR')}`
        : 'Sem snapshot disponível';

    $('workers-body').innerHTML = workers.map(renderWorker).join('');
    $('empty-state').hidden = workers.length !== 0;
}

async function refresh() {
    try {
        const response = await fetch('/api/supervisor/status', { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        render(await response.json());
    } catch (error) {
        $('health-dot').className = 'dot erro';
        $('health-text').textContent = `Falha ao consultar telemetria: ${error?.message || error}`;
    }
}

void refresh();
setInterval(() => void refresh(), POLL_MS);
