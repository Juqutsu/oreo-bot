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
  type          ENUM('warn','timeout','kick','ban','unban','untimeout','warn_removed','reason_edited','automod_hit','mute','unmute','softban') NOT NULL,
  source        ENUM('manual','automod','api','escalation','system') NOT NULL DEFAULT 'manual',
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
  permission  ENUM('supporter','moderator','owner') NOT NULL,
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

-- =========================================================
-- ALTER STATEMENTS (Stage 1.5 — case-management)
-- Run after CREATE TABLE. All idempotent.
-- =========================================================

-- Neue ENUM-Werte für Meta-Cases. MODIFY COLUMN ist idempotent —
-- MySQL setzt die Spalten-Definition auf den Soll-Zustand.
ALTER TABLE infractions MODIFY COLUMN type
  ENUM('warn','timeout','kick','ban','unban','untimeout','warn_removed','reason_edited','automod_hit','mute','unmute','softban') NOT NULL;

-- parent_case_number: Verbindung von Meta-Cases zum Original-Case.
-- ADD COLUMN ohne IF NOT EXISTS (MySQL unterstützt IF NOT EXISTS nicht);
-- src/schema.js ignoriert ER_DUP_FIELDNAME (1060) für Idempotenz.
ALTER TABLE infractions ADD COLUMN
  parent_case_number INT UNSIGNED NULL AFTER case_number;

-- =========================================================
-- ALTER STATEMENTS (Stage 2a — role-permissions tier rename)
-- helper → supporter, mod → moderator, admin → owner
-- Idempotent über 3-Schritt-Migration (expand → rename → shrink).
-- =========================================================

-- 1. ENUM temporär auf die Vereinigungsmenge erweitern (so dass UPDATEs unten
--    sowohl alte als auch neue Werte schreiben dürfen).
ALTER TABLE role_permissions MODIFY COLUMN permission
  ENUM('helper','mod','admin','supporter','moderator','owner') NOT NULL;

-- 2. Bestehende Rows auf neue Werte umstellen. No-op wenn schon migriert.
UPDATE role_permissions SET permission = 'supporter' WHERE permission = 'helper';
UPDATE role_permissions SET permission = 'moderator' WHERE permission = 'mod';
UPDATE role_permissions SET permission = 'owner'     WHERE permission = 'admin';

-- 3. ENUM auf die finale neue Menge reduzieren.
ALTER TABLE role_permissions MODIFY COLUMN permission
  ENUM('supporter','moderator','owner') NOT NULL;

-- =========================================================
-- ALTER STATEMENTS (Stage 2c — report system extensions)
-- =========================================================

-- resolution_case_number: verlinkt den gelösten Report mit dem automatisch
-- erstellten Infraction-Case.
-- ADD COLUMN ohne IF NOT EXISTS (MySQL 8.x unterstützt IF NOT EXISTS nicht);
-- src/schema.js ignoriert ER_DUP_FIELDNAME (1060) für Idempotenz.
ALTER TABLE reports ADD COLUMN resolution_case_number INT UNSIGNED NULL;

-- message_id: speichert die Discord-Embed-Message-ID für In-Place-Edits
-- bei Status-Übergängen.
ALTER TABLE reports ADD COLUMN message_id BIGINT UNSIGNED NULL;

-- idx_dup_check: macht den (guild_id, reporter, target, status)
-- Duplikat-Check zu einem Index-Lookup.
-- src/schema.js ignoriert ER_DUP_KEYNAME (1061) für Idempotenz.
ALTER TABLE reports ADD INDEX idx_dup_check (guild_id, reporter_id, reported_user_id, status);

-- ============================================================
-- Stage 2d Migration: /case Reverse-Lookup Index
-- ============================================================
-- Speedup für reports.getReportByCaseNumber(guildId, caseNumber).
-- Idempotent via schema-runner (errno 1061 swallowed in src/schema.js).

ALTER TABLE reports ADD INDEX idx_resolution_case (guild_id, resolution_case_number);

-- ============================================================
-- Stage 3 Migration: Escalation Source Tag
-- ============================================================
-- Erweitert infractions.source um 'escalation', damit Auto-
-- Eskalations-Cases von manuellen, automod-, und api-Cases
-- unterscheidbar sind. Additiv — bestehende Rows unverändert.

ALTER TABLE infractions MODIFY COLUMN source
  ENUM('manual','automod','api','escalation','system') NOT NULL DEFAULT 'manual';

-- ============================================================
-- Stage 5 Migration: AutoMod Tables + automod_hit Case Type
-- ============================================================
-- Adds the 'automod_hit' meta-case type and two new tables for
-- per-filter state and custom wordlist. See:
-- docs/superpowers/specs/2026-06-04-stage5-automod-design.md §3

-- 1. Extend the case type enum.
ALTER TABLE infractions MODIFY COLUMN type
  ENUM('warn','timeout','kick','ban','unban','untimeout',
       'warn_removed','reason_edited','automod_hit','mute','unmute','softban') NOT NULL;

-- 2. Per-filter state. One row per (guild × filter).
CREATE TABLE IF NOT EXISTS automod_rules (
  guild_id         BIGINT UNSIGNED NOT NULL,
  filter_key       ENUM('spam','mention_spam','invite_links',
                        'keyword_preset','custom_wordlist') NOT NULL,
  discord_rule_id  BIGINT UNSIGNED NULL,
  enabled          TINYINT(1) NOT NULL DEFAULT 0,
  threshold        INT UNSIGNED NULL,
  preset_flags     TINYINT UNSIGNED NULL,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                                 ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (guild_id, filter_key),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
);

-- 3. Custom wordlist (one row per word per guild).
CREATE TABLE IF NOT EXISTS automod_wordlist (
  id          BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  guild_id    BIGINT UNSIGNED NOT NULL,
  word        VARCHAR(60) NOT NULL,
  added_by    BIGINT UNSIGNED NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE,
  UNIQUE KEY uq_word_per_guild (guild_id, word),
  INDEX idx_guild (guild_id)
);

-- ============================================================
-- Stage 8 Migration: Message Logging Channel
-- ============================================================
-- Adds a new column to store a dedicated channel for deleted
-- and edited message logs.
ALTER TABLE guilds ADD COLUMN msg_log_channel_id BIGINT UNSIGNED NULL AFTER mod_log_channel_id;

-- ============================================================
-- Stage 9 Migration: Account Age Check
-- ============================================================
-- Adds a column to configure the minimum account age for joins
ALTER TABLE guilds ADD COLUMN min_account_age_days INT UNSIGNED NOT NULL DEFAULT 0;

-- ============================================================
-- Stage 10 Migration: Temp-Bans, Soft-Bans, Warn Decay, Muted Role
-- ============================================================
ALTER TABLE guilds ADD COLUMN warn_decay_days INT UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE guilds ADD COLUMN muted_role_id BIGINT UNSIGNED NULL;

ALTER TABLE infractions MODIFY COLUMN type 
  ENUM('warn','timeout','kick','ban','unban','untimeout','warn_removed','reason_edited','automod_hit','mute','unmute','softban') NOT NULL;

ALTER TABLE infractions MODIFY COLUMN source
  ENUM('manual','automod','api','escalation','system') NOT NULL DEFAULT 'manual';

-- ============================================================
-- Stage 11 Migration: Captcha Verification & Toxicity Filter
-- ============================================================
ALTER TABLE guilds ADD COLUMN captcha_enabled TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE guilds ADD COLUMN verified_role_id BIGINT UNSIGNED NULL;
ALTER TABLE guilds ADD COLUMN toxicity_enabled TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE guilds ADD COLUMN toxicity_action ENUM('delete', 'warn', 'mute') NOT NULL DEFAULT 'warn';

CREATE TABLE IF NOT EXISTS bad_words (
  guild_id BIGINT UNSIGNED NOT NULL,
  word VARCHAR(64) NOT NULL,
  PRIMARY KEY (guild_id, word),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
);

-- ============================================================
-- Stage 12 Migration: Expiry & Decay Index Optimization
-- ============================================================
ALTER TABLE infractions ADD INDEX idx_active_type_expires (active, type, expires_at);
ALTER TABLE infractions ADD INDEX idx_active_type_created (active, type, created_at);

-- ============================================================
-- Stage 13 Migration: Global Captcha Verification Channel
-- ============================================================
ALTER TABLE guilds ADD COLUMN captcha_channel_id BIGINT UNSIGNED NULL;
