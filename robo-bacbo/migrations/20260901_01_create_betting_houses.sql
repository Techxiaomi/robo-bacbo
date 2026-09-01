CREATE TABLE IF NOT EXISTS betting_houses (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    adapter_key VARCHAR(80) NOT NULL,
    home_url TEXT NOT NULL,
    username VARCHAR(190) DEFAULT NULL,
    password_encrypted TEXT DEFAULT NULL,
    session_state_file VARCHAR(500) DEFAULT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_betting_houses_adapter_key (adapter_key),
    INDEX idx_betting_houses_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS betting_house_tables (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    betting_house_id BIGINT UNSIGNED NOT NULL,
    table_key VARCHAR(80) NOT NULL,
    display_name VARCHAR(120) NOT NULL,
    game_url TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_betting_house_tables_house
        FOREIGN KEY (betting_house_id)
        REFERENCES betting_houses(id)
        ON DELETE CASCADE,
    UNIQUE KEY uq_betting_house_tables_house_key (betting_house_id, table_key),
    INDEX idx_betting_house_tables_house_enabled (betting_house_id, enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
