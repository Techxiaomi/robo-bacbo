CREATE TABLE IF NOT EXISTS system_configs (
    config_key VARCHAR(80) NOT NULL PRIMARY KEY,
    config_value VARCHAR(255) NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO system_configs (config_key, config_value) VALUES
    ('global_router_cap', '20.00'),
    ('per_bridge_cap', '5.00'),
    ('financial_dry_run', 'true');
