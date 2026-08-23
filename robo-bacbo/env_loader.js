const fs = require("fs");
const path = require("path");

function loadEnvFile(filePath) {
    if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf8");

        for (const rawLine of content.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line || line.startsWith("#")) continue;

            const separator = line.indexOf("=");
            if (separator <= 0) continue;

            const key = line.slice(0, separator).trim();
            let value = line.slice(separator + 1).trim();

            if ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }

            if (process.env[key] === undefined) process.env[key] = value;
        }
    }

    const baseDir = path.dirname(filePath);

    // OBS-001F: instala o sink estruturado somente depois de carregar o .env,
    // para que caminho, limites e redaction usem a configuracao local real.
    const { instalarLoggingEstruturado } = require("./logger");
    instalarLoggingEstruturado({ baseDir });

    // OBS-001G: snapshot de saude do processo em arquivo JSON atomico.
    // O timer usa unref(), nao segura o processo aberto e independe do sink JSONL.
    const { instalarMetricasRuntime } = require("./metrics");
    instalarMetricasRuntime({ baseDir });

    // OBS-001H: telemetria operacional local sem dependencias externas.
    // Instrumenta HTTP inbound e fetch outbound antes do app.listen(), sem tocar no motor principal.
    const { instalarMetricasOperacionais } = require("./operations_metrics");
    instalarMetricasOperacionais({ baseDir });

    // O executor Python nao expoe mais Flask. O transporte legado fetch() do motor
    // e redirecionado localmente para Redis Pub/Sub, preservando o processamento
    // existente de sinais/webhooks e o callback financeiro do Node.
    const { instalarRedisExecutorBridge } = require("./redis_executor_bridge");
    instalarRedisExecutorBridge();
}

module.exports = { loadEnvFile };
