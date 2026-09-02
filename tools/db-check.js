'use strict';

const fs = require('fs');
const path = require('path');

function loadEnv(filePath) {
  const out = {};
  const content = fs.readFileSync(filePath, 'utf8');
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

async function main() {
  const root = process.argv[2];
  if (!root) throw new Error('ROOT_AUSENTE');

  const appDir = path.join(root, 'INT', 'robo-bacbo');
  const envPath = path.join(root, 'INT', '.env');
  if (!fs.existsSync(envPath)) throw new Error('ENV_AUSENTE');

  const env = loadEnv(envPath);
  for (const key of ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']) {
    if (!env[key]) throw new Error(`ENV_${key}_AUSENTE`);
  }

  const mysql = require(path.join(appDir, 'node_modules', 'mysql2', 'promise'));
  const pool = mysql.createPool({
    host: env.DB_HOST,
    port: Number(env.DB_PORT || 3306),
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 1,
    queueLimit: 0,
    connectTimeout: 10000
  });

  try {
    const [rows] = await pool.query('SELECT 1 AS ok');
    if (!Array.isArray(rows) || Number(rows[0]?.ok) !== 1) {
      throw new Error('SELECT_1_INVALIDO');
    }
    console.log('DB_OK');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('DB_FAIL:', err && err.message ? err.message : String(err));
  process.exit(2);
});
