'use strict';

const fs = require('fs');
const path = require('path');
const { aplicarPhase3AoPatchPhase1 } = require('./signal_cycle_phase3_patch');

const basePath = path.join(__dirname, 'bot2_coletor.phase1_base.js');
const source = aplicarPhase3AoPatchPhase1(fs.readFileSync(basePath, 'utf8'));

module._compile(source, __filename);
