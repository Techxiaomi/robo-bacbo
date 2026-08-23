'use strict';

const path = require('path');

require('./env_loader').loadEnvFile(path.join(__dirname, '..', '.env'));
const redisRuntime = require('./redis_runtime_v3');
redisRuntime.instalarRedisRuntimeV3();
require('./bot2_coletor');

void require('./bacbo_startup_sync')
    .sincronizarSnapshotRetido(redisRuntime.processarBacbo)
    .catch(erro => console.warn(`⚠️ Startup ROAD inesperadamente falhou: ${erro.message}`));
