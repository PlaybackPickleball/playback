import type { DatabaseSync } from 'node:sqlite';

export const SLOT_STATUSES = ['available', 'held', 'booked', 'in_play', 'queue_managed', 'unavailable'] as const;
export type SlotStatus = (typeof SLOT_STATUSES)[number];

export const BOOKING_STATUSES = [
  'open',
  'pending',
  'held',
  'confirmed',
  'checked_in',
  'completed',
  'cancelled',
  'expired',
  'no_show',
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** Statuses that occupy a court. Two of these may never overlap on one court. */
export const BLOCKING_STATUSES = ['pending', 'held', 'confirmed', 'checked_in'] as const;
const BLOCKING_SQL = BLOCKING_STATUSES.map((s) => `'${s}'`).join(', ');
const list = (items: readonly string[]) => items.map((s) => `'${s}'`).join(', ');

/**
 * Additive only: new tables, indexes and triggers, all IF NOT EXISTS. No existing table is altered.
 * Times: `date` is YYYY-MM-DD and `start`/`end` on a slot are HH:MM in venue local time (Asia/Ho_Chi_Minh).
 * Booking `start`/`end` are YYYY-MM-DDTHH:MM in the same local time, so they compare as plain strings.
 * `updated_at`, `created_at` and `expires_at` are UTC ISO timestamps.
 */
export const PLAY_SCHEMA = `
CREATE TABLE IF NOT EXISTS court_availability (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facilities(id),
  court_id TEXT NOT NULL REFERENCES courts(id),
  date TEXT NOT NULL,
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  price_vnd INTEGER NOT NULL CHECK (price_vnd >= 0),
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN (${list(SLOT_STATUSES)})),
  source TEXT NOT NULL DEFAULT 'facility' CHECK (source IN ('demo', 'facility')),
  booking_id TEXT,
  demo INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE (court_id, date, start)
);
CREATE INDEX IF NOT EXISTS idx_court_availability_court_time ON court_availability (court_id, date, start);
CREATE INDEX IF NOT EXISTS idx_court_availability_facility_date ON court_availability (facility_id, date, status);
CREATE INDEX IF NOT EXISTS idx_court_availability_status ON court_availability (status);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facilities(id),
  court_id TEXT NOT NULL REFERENCES courts(id),
  slot_id TEXT REFERENCES court_availability(id),
  hold_id TEXT,
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (${list(BOOKING_STATUSES)})),
  price_vnd INTEGER NOT NULL CHECK (price_vnd >= 0),
  created_by_player TEXT NOT NULL REFERENCES players(id),
  origin TEXT NOT NULL DEFAULT 'playback' CHECK (origin IN ('playback', 'facility')),
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (end > start)
);
CREATE INDEX IF NOT EXISTS idx_bookings_court_time ON bookings (court_id, start, end);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings (status);
CREATE INDEX IF NOT EXISTS idx_bookings_player ON bookings (created_by_player, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_idempotency
  ON bookings (created_by_player, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_active_court_start
  ON bookings (court_id, start) WHERE status IN (${BLOCKING_SQL});
CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_active_slot
  ON bookings (slot_id) WHERE slot_id IS NOT NULL AND status IN (${BLOCKING_SQL});

CREATE TRIGGER IF NOT EXISTS trg_bookings_no_overlap_insert
BEFORE INSERT ON bookings
WHEN NEW.status IN (${BLOCKING_SQL})
BEGIN
  SELECT RAISE(ABORT, 'court_overlap')
  WHERE EXISTS (
    SELECT 1 FROM bookings b
    WHERE b.court_id = NEW.court_id AND b.id <> NEW.id AND b.status IN (${BLOCKING_SQL})
      AND b.start < NEW.end AND b.end > NEW.start
  );
END;
CREATE TRIGGER IF NOT EXISTS trg_bookings_no_overlap_update
BEFORE UPDATE OF status, start, end, court_id ON bookings
WHEN NEW.status IN (${BLOCKING_SQL})
BEGIN
  SELECT RAISE(ABORT, 'court_overlap')
  WHERE EXISTS (
    SELECT 1 FROM bookings b
    WHERE b.court_id = NEW.court_id AND b.id <> NEW.id AND b.status IN (${BLOCKING_SQL})
      AND b.start < NEW.end AND b.end > NEW.start
  );
END;

CREATE TABLE IF NOT EXISTS court_holds (
  id TEXT PRIMARY KEY,
  slot_id TEXT NOT NULL REFERENCES court_availability(id),
  court_id TEXT NOT NULL REFERENCES courts(id),
  player_id TEXT NOT NULL REFERENCES players(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'converted', 'released', 'expired')),
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_court_holds_court_time ON court_holds (court_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_court_holds_status ON court_holds (status, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_court_holds_active_slot ON court_holds (slot_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS uq_court_holds_idempotency
  ON court_holds (player_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS booking_participants (
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(id),
  status TEXT NOT NULL DEFAULT 'joined' CHECK (status IN ('invited', 'joined', 'declined', 'left')),
  PRIMARY KEY (booking_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_booking_participants_player ON booking_participants (player_id, status);

CREATE TABLE IF NOT EXISTS booking_status_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  at TEXT NOT NULL,
  actor TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_booking_status_log_booking ON booking_status_log (booking_id, id);
`;

export function ensurePlaySchema(db: DatabaseSync): void {
  db.exec(PLAY_SCHEMA);
}
