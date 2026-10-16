import type { DatabaseSync } from 'node:sqlite';

export const ENTRY_STATUSES = ['waiting', 'offered', 'confirmed', 'assigned', 'cancelled', 'expired', 'declined'] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];
/** A player may hold at most one entry in these states, across all facilities. */
export const ACTIVE_ENTRY_STATUSES = ['waiting', 'offered', 'confirmed'] as const;
export const ENTRY_SOURCES = ['app', 'court_qr', 'staff'] as const;
export type EntrySource = (typeof ENTRY_SOURCES)[number];
export const OFFER_STATUSES = ['pending', 'accepted', 'declined', 'expired'] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

const list = (items: readonly string[]) => items.map((s) => `'${s}'`).join(', ');

/**
 * Additive only (CREATE ... IF NOT EXISTS). Timestamps are UTC ISO strings.
 * `confirmed` sits between offered and assigned: the player accepted, the rest of the group has not yet.
 * It counts as active so a player cannot queue twice while waiting for the others.
 */
export const QUEUE_SCHEMA = `
CREATE TABLE IF NOT EXISTS queue_settings (
  facility_id TEXT PRIMARY KEY REFERENCES facilities(id),
  mode TEXT NOT NULL DEFAULT 'hybrid' CHECK (mode IN ('fifo', 'skill', 'hybrid')),
  acceptance_window_seconds INTEGER NOT NULL DEFAULT 120 CHECK (acceptance_window_seconds BETWEEN 15 AND 900),
  skill_band REAL NOT NULL DEFAULT 0.5 CHECK (skill_band > 0),
  max_bypass INTEGER NOT NULL DEFAULT 3 CHECK (max_bypass >= 0),
  min_skill_gain REAL NOT NULL DEFAULT 0.3 CHECK (min_skill_gain >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS queue_entries (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id),
  facility_id TEXT NOT NULL REFERENCES facilities(id),
  court_id TEXT REFERENCES courts(id),
  joined_at TEXT NOT NULL,
  rating_snapshot INTEGER NOT NULL,
  party_size INTEGER NOT NULL DEFAULT 1 CHECK (party_size BETWEEN 1 AND 4),
  format TEXT NOT NULL DEFAULT 'doubles' CHECK (format IN ('doubles', 'singles')),
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN (${list(ENTRY_STATUSES)})),
  assigned_court_id TEXT,
  booking_id TEXT,
  offer_id TEXT,
  source TEXT NOT NULL DEFAULT 'app' CHECK (source IN (${list(ENTRY_SOURCES)})),
  idempotency_key TEXT,
  bypassed_count INTEGER NOT NULL DEFAULT 0,
  added_by TEXT,
  demo INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_queue_entries_facility ON queue_entries (facility_id, status, joined_at);
CREATE INDEX IF NOT EXISTS idx_queue_entries_player ON queue_entries (player_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_queue_entries_active_player
  ON queue_entries (player_id) WHERE status IN (${list(ACTIVE_ENTRY_STATUSES)});
CREATE UNIQUE INDEX IF NOT EXISTS uq_queue_entries_idempotency
  ON queue_entries (player_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS queue_offers (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facilities(id),
  court_id TEXT NOT NULL REFERENCES courts(id),
  slot_id TEXT NOT NULL REFERENCES court_availability(id),
  entry_ids TEXT NOT NULL,
  offered_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (${list(OFFER_STATUSES)})),
  mode TEXT NOT NULL,
  reason TEXT NOT NULL,
  slot_prev_status TEXT NOT NULL,
  booking_id TEXT,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_queue_offers_status ON queue_offers (status, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_queue_offers_pending_slot ON queue_offers (slot_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS queue_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  facility_id TEXT NOT NULL,
  entry_id TEXT,
  event TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  actor TEXT NOT NULL,
  at TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_queue_audit_facility ON queue_audit (facility_id, id);
CREATE INDEX IF NOT EXISTS idx_queue_audit_entry ON queue_audit (entry_id, id);
`;

export function ensureQueueSchema(db: DatabaseSync): void {
  db.exec(QUEUE_SCHEMA);
  // One settings row per facility with the documented defaults. Never overwrites a row a facility has set.
  db.prepare(
    `INSERT OR IGNORE INTO queue_settings (facility_id, updated_at) SELECT id, ? FROM facilities`,
  ).run(new Date().toISOString());
}
