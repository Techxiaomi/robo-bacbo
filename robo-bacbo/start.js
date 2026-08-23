'use strict';

const path = require('path');

require('./env_loader').loadEnvFile(path.join(__dirname, '..', '.env'));
const redisRuntime = require('./redis_runtime_v3');
redisRuntime.instalarRedisRuntimeV3();
void require('./tipminer_history_sync')
    .instalarTipMinerHistorySync(redisRuntime.processarBacbo)
    .catch(erro => console.error(`⚠️ Adaptador TipMiner HISTORY_SYNC não iniciou: ${erro.message}`));
require('./bot2_coletor');
