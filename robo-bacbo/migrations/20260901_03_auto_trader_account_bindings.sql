CREATE TABLE IF NOT EXISTS auto_trader_account_bindings (
    auto_trader_id INT NOT NULL,
    betting_house_id BIGINT UNSIGNED NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (auto_trader_id, betting_house_id),
    INDEX idx_atab_house (betting_house_id),
    CONSTRAINT fk_atab_betting_house
        FOREIGN KEY (betting_house_id)
        REFERENCES betting_houses(id)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
