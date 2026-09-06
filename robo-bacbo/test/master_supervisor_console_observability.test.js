'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const BASE = fs.readFileSync(
    path.join(
        ROOT,
        'scripts',
        'master_supervisor.js'
    ),
    'utf8'
);

const FAST = fs.readFileSync(
    path.join(
        ROOT,
        'scripts',
        'master_supervisor_fast.js'
    ),
    'utf8'
);

test(
    'poll fallback permanece funcional',
    () => {
        assert.match(
            FAST,
            /POLL_FALLBACK/
        );

        assert.match(
            FAST,
            /reconcileIntervalMs/
        );
    }
);

test(
    'spam continuo de reconcile saiu do console',
    () => {
        assert.equal(
            BASE.includes(
                'MASTER_SUPERVISOR_RECONCILE desired='
            ),
            false
        );

        assert.equal(
            FAST.includes(
                'MASTER_SUPERVISOR_RECONCILE_COMPLETE reason='
            ),
            false
        );
    }
);

test(
    'reconcile detalhado vai para audit JSONL',
    () => {
        assert.match(
            FAST,
            /master-supervisor\.audit\.jsonl/
        );

        assert.match(
            FAST,
            /writeMasterSupervisorAudit/
        );

        assert.match(
            FAST,
            /MASTER_SUPERVISOR_RECONCILE_COMPLETE/
        );
    }
);

test(
    'console tem START READY STABLE HEALTH',
    () => {
        assert.match(
            BASE,
            /\[MASTER\] START/
        );

        assert.match(
            BASE,
            /\[MASTER\] READY/
        );

        assert.match(
            FAST,
            /\[MASTER\] STABLE/
        );

        assert.match(
            FAST,
            /\[MASTER\] HEALTH/
        );
    }
);

test(
    'heartbeat padrao e 60 segundos',
    () => {
        assert.match(
            FAST,
            /DEFAULT_HEALTH_INTERVAL_MS = 60000/
        );
    }
);

test(
    'wake event-driven permanece instalado',
    () => {
        assert.match(
            FAST,
            /watchSupervisorReconcileSignal/
        );
    }
);
