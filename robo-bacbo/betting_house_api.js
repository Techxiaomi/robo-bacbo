'use strict';

const express = require('express');
const { createBettingHouseService } = require('./betting_house_service');

function statusForError(error) {
    if (Number.isInteger(error?.statusCode)) return error.statusCode;
    if (error?.code === 'ER_DUP_ENTRY') return 409;
    if (String(error?.message || '').includes('BETTING_HOUSE_CREDENTIALS_KEY')) return 503;
    return 500;
}

function errorPayload(error) {
    const status = statusForError(error);
    if (status >= 500) {
        return { success: false, error: 'betting_house_backend_error' };
    }
    return { success: false, error: String(error.message || 'betting_house_request_failed') };
}

function createBettingHouseRouter({ dbPool, encryptionKey } = {}) {
    const router = express.Router();
    const service = createBettingHouseService({ dbPool, encryptionKey });

    const handle = handler => async (req, res) => {
        try {
            await handler(req, res);
        } catch (error) {
            const status = statusForError(error);
            if (status >= 500) {
                console.error('Betting House API failure:', error?.code || error?.message || error);
            }
            res.status(status).json(errorPayload(error));
        }
    };

    router.get('/', handle(async (req, res) => {
        const includeDisabled = String(req.query.include_disabled || '') === '1';
        res.json({ success: true, houses: await service.listHouses({ includeDisabled }) });
    }));

    router.get('/:id', handle(async (req, res) => {
        res.json({ success: true, house: await service.getHouse(req.params.id) });
    }));

    router.post('/', handle(async (req, res) => {
        const house = await service.createHouse(req.body || {});
        res.status(201).json({ success: true, house });
    }));

    router.put('/:id', handle(async (req, res) => {
        const house = await service.updateHouse(req.params.id, req.body || {});
        res.json({ success: true, house });
    }));

    router.delete('/:id', handle(async (req, res) => {
        await service.deactivateHouse(req.params.id);
        res.json({ success: true });
    }));

    router.post('/:id/tables', handle(async (req, res) => {
        const table = await service.createTable(req.params.id, req.body || {});
        res.status(201).json({ success: true, table });
    }));

    router.put('/:id/tables/:tableId', handle(async (req, res) => {
        const table = await service.updateTable(req.params.id, req.params.tableId, req.body || {});
        res.json({ success: true, table });
    }));

    router.delete('/:id/tables/:tableId', handle(async (req, res) => {
        await service.deactivateTable(req.params.id, req.params.tableId);
        res.json({ success: true });
    }));

    return router;
}

function installBettingHouseApi(app, options = {}) {
    if (!app || typeof app.use !== 'function') {
        throw new TypeError('BETTING_HOUSE_API_INVALID_EXPRESS_APP');
    }
    app.use('/api/betting-houses', createBettingHouseRouter(options));
    return app;
}

module.exports = {
    createBettingHouseRouter,
    installBettingHouseApi
};
