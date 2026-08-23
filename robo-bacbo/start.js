'use strict';

const path = require('path');

require('./env_loader').loadEnvFile(path.join(__dirname, '..', '.env'));
require('./redis_runtime_v3').instalarRedisRuntimeV3();
require('./bot2_coletor');
