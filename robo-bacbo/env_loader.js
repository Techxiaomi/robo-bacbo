const fs = require("fs");

function loadEnvFile(filePath) {
    if (!fs.existsSync(filePath)) return;
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

module.exports = { loadEnvFile };
