'use strict';

const path = require('path');

require('./env_loader').loadEnvFile(path.join(__dirname, '..', '.env'));
require('./redis_executor_bridge').instalarRedisExecutorBridge();
require('./bot2_coletor');
