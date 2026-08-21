(() => {
    'use strict';

    const CHART_JS_VERSION = '4.4.7';
    const CHART_JS_URL = `https://cdn.jsdelivr.net/npm/chart.js@${CHART_JS_VERSION}/dist/chart.umd.min.js`;
    const HTML2PDF_VERSION = '0.10.1';
    const HTML2PDF_URL = `https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/${HTML2PDF_VERSION}/html2pdf.bundle.min.js`;
    const promessasAssets = new Map();
    let audioContextSingleton = null;

    function carregarScriptUmaVez({ id, src, globalName }) {
        if (globalName && typeof window[globalName] !== 'undefined') {
            return Promise.resolve(window[globalName]);
        }
        if (promessasAssets.has(id)) return promessasAssets.get(id);

        const promessa = new Promise((resolve, reject) => {
            const existente = document.getElementById(id);
            if (existente) {
                existente.addEventListener('load', () => resolve(globalName ? window[globalName] : true), { once: true });
                existente.addEventListener('error', () => reject(new Error(`Falha ao carregar ${src}`)), { once: true });
                return;
            }

            const script = document.createElement('script');
            script.id = id;
            script.src = src;
            script.async = true;
            script.onload = () => {
                if (globalName && typeof window[globalName] === 'undefined') {
                    reject(new Error(`${globalName} não ficou disponível após carregar ${src}`));
                    return;
                }
                resolve(globalName ? window[globalName] : true);
            };
            script.onerror = () => reject(new Error(`Falha ao carregar ${src}`));
            document.head.appendChild(script);
        }).catch(error => {
            promessasAssets.delete(id);
            document.getElementById(id)?.remove();
            throw error;
        });

        promessasAssets.set(id, promessa);
        return promessa;
    }

    function carregarChartJsUI4() {
        return carregarScriptUmaVez({
            id: 'ui4-chartjs',
            src: CHART_JS_URL,
            globalName: 'Chart'
        });
    }

    function carregarHtml2PdfUI4() {
        return carregarScriptUmaVez({
            id: 'ui4-html2pdf',
            src: HTML2PDF_URL,
            globalName: 'html2pdf'
        });
    }

    function obterAudioContextSingleton() {
        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        if (typeof AudioContextCtor !== 'function') return null;
        if (!audioContextSingleton || audioContextSingleton.state === 'closed') {
            audioContextSingleton = new AudioContextCtor();
        }
        return audioContextSingleton;
    }

    function tocarSomSingletonUI4() {
        const ctx = obterAudioContextSingleton();
        if (!ctx) return;

        if (ctx.state === 'suspended') {
            void ctx.resume().catch(() => {});
        }

        const inicio = ctx.currentTime + 0.005;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(600, inicio);
        osc.frequency.exponentialRampToValueAtTime(1200, inicio + 0.1);
        gain.gain.setValueAtTime(0.4, inicio);
        gain.gain.exponentialRampToValueAtTime(0.001, inicio + 0.2);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(inicio);
        osc.stop(inicio + 0.2);
    }

    function substituirObrigatorio(codigo, original, substituto, rotulo) {
        if (!codigo.includes(original)) {
            throw new Error(`UI-4 não encontrou trecho obrigatório: ${rotulo}`);
        }
        return codigo.replace(original, substituto);
    }

    function otimizarScriptPrincipalUI4(codigoOriginal) {
        let codigo = String(codigoOriginal || '');

        const tocarSomOriginal = "function tocarSom() { if (!somAtivo) return; try { const ctx = new (window.AudioContext || window.webkitAudioContext)(); if (!ctx) return; const osc = ctx.createOscillator(); const gain = ctx.createGain(); osc.type = 'triangle'; osc.frequency.setValueAtTime(600, ctx.currentTime); osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.1); gain.gain.setValueAtTime(0.4, ctx.currentTime); gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2); osc.connect(gain); gain.connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + 0.2); } catch(e) {} }";
        const tocarSomOtimizado = "function tocarSom() { if (!somAtivo) return; try { window.tocarSomSingletonUI4(); } catch(e) {} }";
        codigo = substituirObrigatorio(codigo, tocarSomOriginal, tocarSomOtimizado, 'AudioContext singleton');

        codigo = substituirObrigatorio(
            codigo,
            'function trocarTabBacktest(tab) {',
            "function trocarTabBacktest(tab) { if (tab === 'fin') { void window.carregarChartJsUI4().catch(erro => console.error('❌ UI-4 | falha ao carregar Chart.js:', erro)); }",
            'lazy load Chart.js ao abrir simulação financeira'
        );

        codigo = substituirObrigatorio(
            codigo,
            'async function rodarSimulacaoBanca() {',
            "async function rodarSimulacaoBanca() { try { await window.carregarChartJsUI4(); } catch (erro) { console.error('❌ UI-4 | Chart.js indisponível:', erro); return alert('Não foi possível carregar o gráfico da simulação.'); }",
            'garantia Chart.js antes da simulação'
        );

        codigo = substituirObrigatorio(
            codigo,
            'async function gerarRelatorioPDF(traderId) {',
            "async function gerarRelatorioPDF(traderId) { try { await window.carregarHtml2PdfUI4(); } catch (erro) { console.error('❌ UI-4 | html2pdf indisponível:', erro); return alert('Não foi possível carregar o gerador de PDF.'); }",
            'lazy load html2pdf antes do relatório'
        );

        return codigo;
    }

    window.carregarChartJsUI4 = carregarChartJsUI4;
    window.carregarHtml2PdfUI4 = carregarHtml2PdfUI4;
    window.tocarSomSingletonUI4 = tocarSomSingletonUI4;
    window.otimizarScriptPrincipalUI4 = otimizarScriptPrincipalUI4;
    window.__resourceUi4Ready = true;
})();
