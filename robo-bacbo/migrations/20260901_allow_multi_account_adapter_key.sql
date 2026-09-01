SET @schema_name = DATABASE();

SET @drop_unique_sql = (
    SELECT IF(
        EXISTS(
            SELECT 1
            FROM information_schema.statistics
            WHERE table_schema = @schema_name
              AND table_name = 'betting_houses'
              AND index_name = 'uq_betting_houses_adapter_key'
        ),
        'ALTER TABLE betting_houses DROP INDEX uq_betting_houses_adapter_key',
        'SELECT 1'
    )
);
PREPARE stmt_drop_unique FROM @drop_unique_sql;
EXECUTE stmt_drop_unique;
DEALLOCATE PREPARE stmt_drop_unique;

SET @add_adapter_index_sql = (
    SELECT IF(
        EXISTS(
            SELECT 1
            FROM information_schema.statistics
            WHERE table_schema = @schema_name
              AND table_name = 'betting_houses'
              AND index_name = 'idx_betting_houses_adapter_key'
        ),
        'SELECT 1',
        'ALTER TABLE betting_houses ADD INDEX idx_betting_houses_adapter_key (adapter_key)'
    )
);
PREPARE stmt_add_adapter_index FROM @add_adapter_index_sql;
EXECUTE stmt_add_adapter_index;
DEALLOCATE PREPARE stmt_add_adapter_index;
