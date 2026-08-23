'use strict';

const path = require('path');

require('./env_loader').loadEnvFile(path.join(__dirname, '..', '.env'));
require('./redis_runtime').instalarRedisRuntime();
require('./bot2_coletor');
