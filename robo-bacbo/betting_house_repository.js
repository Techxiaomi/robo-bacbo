'use strict';

function assertDbPool(dbPool) {
    if (!dbPool || typeof dbPool.query !== 'function' || typeof dbPool.getConnection !== 'function') {
        throw new TypeError('BETTING_HOUSE_REPOSITORY_INVALID_DB_POOL');
    }
}

function mapHouseRow(row) {
    return {
        id: Number(row.id),
        name: String(row.name),
        adapter_key: String(row.adapter_key),
        home_url: String(row.home_url),
        username: row.username == null ? '' : String(row.username),
        has_password: Boolean(row.has_password),
        session_state_file: row.session_state_file == null ? '' : String(row.session_state_file),
        enabled: Boolean(row.enabled),
        created_at: row.created_at,
        updated_at: row.updated_at
    };
}

function mapTableRow(row) {
    return {
        id: Number(row.id),
        betting_house_id: Number(row.betting_house_id),
        table_key: String(row.table_key),
        display_name: String(row.display_name),
        game_url: String(row.game_url),
        enabled: Boolean(row.enabled),
        created_at: row.created_at,
        updated_at: row.updated_at
    };
}

function createBettingHouseRepository({ dbPool }) {
    assertDbPool(dbPool);

    const HOUSE_SELECT = `
        SELECT id, name, adapter_key, home_url, username,
               (password_encrypted IS NOT NULL AND password_encrypted <> '') AS has_password,
               session_state_file, enabled, created_at, updated_at
        FROM betting_houses
    `;

    async function listHouses({ includeDisabled = false } = {}) {
        const [rows] = await dbPool.query(
            `${HOUSE_SELECT}
             ${includeDisabled ? '' : 'WHERE enabled=true'}
             ORDER BY name ASC, id ASC`
        );

        const houses = [];
        for (const row of rows) {
            const house = mapHouseRow(row);
            house.tables = await listTables(house.id, { includeDisabled });
            houses.push(house);
        }
        return houses;
    }

    async function getHouseById(id, { includeDisabled = true } = {}) {
        const [rows] = await dbPool.query(
            `${HOUSE_SELECT}
             WHERE id=? ${includeDisabled ? '' : 'AND enabled=true'}
             LIMIT 1`,
            [id]
        );
        if (!rows.length) return null;

        const house = mapHouseRow(rows[0]);
        house.tables = await listTables(house.id, { includeDisabled });
        return house;
    }

    async function listTables(houseId, { includeDisabled = false } = {}) {
        const [rows] = await dbPool.query(
            `SELECT id, betting_house_id, table_key, display_name, game_url,
                    enabled, created_at, updated_at
             FROM betting_house_tables
             WHERE betting_house_id=? ${includeDisabled ? '' : 'AND enabled=true'}
             ORDER BY display_name ASC, id ASC`,
            [houseId]
        );
        return rows.map(mapTableRow);
    }

    async function createHouse(data) {
        const connection = await dbPool.getConnection();
        try {
            await connection.beginTransaction();
            const [result] = await connection.query(
                `INSERT INTO betting_houses
                    (name, adapter_key, home_url, username, password_encrypted,
                     session_state_file, enabled)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    data.name,
                    data.adapter_key,
                    data.home_url,
                    data.username || null,
                    data.password_encrypted || null,
                    data.session_state_file || null,
                    data.enabled !== false
                ]
            );

            const houseId = Number(result.insertId);
            for (const table of data.tables || []) {
                await connection.query(
                    `INSERT INTO betting_house_tables
                        (betting_house_id, table_key, display_name, game_url, enabled)
                     VALUES (?, ?, ?, ?, ?)`,
                    [
                        houseId,
                        table.table_key,
                        table.display_name,
                        table.game_url,
                        table.enabled !== false
                    ]
                );
            }

            await connection.commit();
            return getHouseById(houseId);
        } catch (error) {
            try { await connection.rollback(); } catch (_) {}
            throw error;
        } finally {
            connection.release();
        }
    }

    async function updateHouse(id, patch) {
        const assignments = [];
        const values = [];
        const fields = [
            'name',
            'adapter_key',
            'home_url',
            'username',
            'password_encrypted',
            'session_state_file',
            'enabled'
        ];

        for (const field of fields) {
            if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
            assignments.push(`${field}=?`);
            values.push(patch[field]);
        }

        if (!assignments.length) return getHouseById(id);

        const [result] = await dbPool.query(
            `UPDATE betting_houses SET ${assignments.join(', ')} WHERE id=?`,
            [...values, id]
        );
        if (Number(result.affectedRows) !== 1) return null;
        return getHouseById(id);
    }

    async function deactivateHouse(id) {
        const [result] = await dbPool.query(
            'UPDATE betting_houses SET enabled=false WHERE id=?',
            [id]
        );
        return Number(result.affectedRows) === 1;
    }

    async function createTable(houseId, table) {
        const [result] = await dbPool.query(
            `INSERT INTO betting_house_tables
                (betting_house_id, table_key, display_name, game_url, enabled)
             VALUES (?, ?, ?, ?, ?)`,
            [houseId, table.table_key, table.display_name, table.game_url, table.enabled !== false]
        );
        return getTableById(houseId, Number(result.insertId));
    }

    async function getTableById(houseId, tableId) {
        const [rows] = await dbPool.query(
            `SELECT id, betting_house_id, table_key, display_name, game_url,
                    enabled, created_at, updated_at
             FROM betting_house_tables
             WHERE betting_house_id=? AND id=?
             LIMIT 1`,
            [houseId, tableId]
        );
        return rows.length ? mapTableRow(rows[0]) : null;
    }

    async function updateTable(houseId, tableId, patch) {
        const assignments = [];
        const values = [];
        const fields = ['table_key', 'display_name', 'game_url', 'enabled'];

        for (const field of fields) {
            if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
            assignments.push(`${field}=?`);
            values.push(patch[field]);
        }

        if (!assignments.length) return getTableById(houseId, tableId);

        const [result] = await dbPool.query(
            `UPDATE betting_house_tables
             SET ${assignments.join(', ')}
             WHERE betting_house_id=? AND id=?`,
            [...values, houseId, tableId]
        );
        if (Number(result.affectedRows) !== 1) return null;
        return getTableById(houseId, tableId);
    }

    async function deactivateTable(houseId, tableId) {
        const [result] = await dbPool.query(
            `UPDATE betting_house_tables
             SET enabled=false
             WHERE betting_house_id=? AND id=?`,
            [houseId, tableId]
        );
        return Number(result.affectedRows) === 1;
    }

    async function getRuntimeSecretById(id) {
        const [rows] = await dbPool.query(
            `SELECT id, name, adapter_key, home_url, username,
                    password_encrypted, session_state_file, enabled
             FROM betting_houses
             WHERE id=?
             LIMIT 1`,
            [id]
        );
        if (!rows.length) return null;

        const row = rows[0];
        return {
            id: Number(row.id),
            name: String(row.name),
            adapter_key: String(row.adapter_key),
            home_url: String(row.home_url),
            username: row.username == null ? '' : String(row.username),
            password_encrypted: row.password_encrypted == null ? '' : String(row.password_encrypted),
            session_state_file: row.session_state_file == null ? '' : String(row.session_state_file),
            enabled: Boolean(row.enabled),
            tables: await listTables(Number(row.id), { includeDisabled: false })
        };
    }

    return Object.freeze({
        listHouses,
        getHouseById,
        createHouse,
        updateHouse,
        deactivateHouse,
        listTables,
        createTable,
        updateTable,
        deactivateTable,
        getRuntimeSecretById
    });
}

module.exports = {
    createBettingHouseRepository
};
