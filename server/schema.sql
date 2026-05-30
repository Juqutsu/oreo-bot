-- Oreo Discord Bot — Schema (Stage 1)
-- Idempotent: alle CREATE TABLE haben IF NOT EXISTS.
-- Spec: docs/superpowers/specs/2026-05-30-warn-cases-design.md

-- Per-Server-Konfiguration + Case-Counter
CREATE TABLE IF NOT EXISTS guilds (
  guild_id              BIGINT UNSIGNED PRIMARY KEY,
  report_channel_id     BIGINT UNSIGNED NULL,
  mod_log_channel_id    BIGINT UNSIGNED NULL,
  automod_enabled       TINYINT(1) NOT NULL DEFAULT 0,
  next_case_number      INT UNSIGNED NOT NULL DEFAULT 0,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- User-Profil pro (guild, user)
CREATE TABLE IF NOT EXISTS guild_users (
  guild_id    BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NOT NULL,
  username    VARCHAR(32) NULL,
  currency    INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (guild_id, user_id),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
);

-- Alle Mod-Aktionen (warn, ban, kick, timeout, unban, untimeout)
CREATE TABLE IF NOT EXISTS infractions (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  guild_id      BIGINT UNSIGNED NOT NULL,
  case_number   INT UNSIGNED NOT NULL,
  user_id       BIGINT UNSIGNED NOT NULL,
  moderator_id  BIGINT UNSIGNED NOT NULL,
  type          ENUM('warn','timeout','kick','ban','unban','untimeout') NOT NULL,
  source        ENUM('manual','automod','api') NOT NULL DEFAULT 'manual',
  reason        VARCHAR(512) NULL,
  duration_ms   BIGINT UNSIGNED NULL,
  expires_at    DATETIME NULL,
  active        TINYINT(1) NOT NULL DEFAULT 1,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE,
  UNIQUE KEY uq_case_per_guild (guild_id, case_number),
  INDEX idx_user_lookup (guild_id, user_id, type, active),
  INDEX idx_recent (guild_id, created_at DESC)
);

-- Stage 2: User-Reports (Tabelle vorbereitet, in Stage 1 leer)
CREATE TABLE IF NOT EXISTS reports (
  id                 BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  guild_id           BIGINT UNSIGNED NOT NULL,
  reporter_id        BIGINT UNSIGNED NOT NULL,
  reported_user_id   BIGINT UNSIGNED NOT NULL,
  reason             VARCHAR(512) NOT NULL,
  evidence_url       VARCHAR(512) NULL,
  status             ENUM('open','investigating','resolved','dismissed') NOT NULL DEFAULT 'open',
  assigned_mod_id    BIGINT UNSIGNED NULL,
  resolution_note    VARCHAR(512) NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at        DATETIME NULL,
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE,
  INDEX idx_open_per_guild (guild_id, status, created_at)
);

-- Stage 3: Eskalations-Regeln (Tabelle vorbereitet, in Stage 1 leer)
CREATE TABLE IF NOT EXISTS escalation_rules (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  guild_id          BIGINT UNSIGNED NOT NULL,
  warn_threshold    INT UNSIGNED NOT NULL,
  action            ENUM('timeout','kick','ban') NOT NULL,
  duration_minutes  INT UNSIGNED NULL,
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE,
  UNIQUE KEY uq_threshold_per_guild (guild_id, warn_threshold)
);

-- Stage 3: Custom Bot-Permissions pro Rolle (Tabelle vorbereitet, in Stage 1 leer)
CREATE TABLE IF NOT EXISTS role_permissions (
  guild_id    BIGINT UNSIGNED NOT NULL,
  role_id     BIGINT UNSIGNED NOT NULL,
  permission  ENUM('helper','mod','admin') NOT NULL,
  PRIMARY KEY (guild_id, role_id),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
);

-- Stage 4: Automod-Ausnahmen (Tabelle vorbereitet, in Stage 1 leer)
CREATE TABLE IF NOT EXISTS automod_exemptions (
  id           BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  guild_id     BIGINT UNSIGNED NOT NULL,
  target_type  ENUM('user','role','channel') NOT NULL,
  target_id    BIGINT UNSIGNED NOT NULL,
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE,
  UNIQUE KEY uq_exemption (guild_id, target_type, target_id)
);
