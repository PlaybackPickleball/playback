import type { DatabaseSync } from 'node:sqlite';

export const MATCH_STATUSES = ['open', 'confirmed', 'cancelled', 'expired'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];
export const INVITATION_STATUSES = ['pending', 'accepted', 'declined', 'expired'] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];
const list = (items: readonly string[]) => items.map((s) => `'${s}'`).join(', ');

/**
 * Additive only (IF NOT EXISTS). Players stay in `players`; joined players are the existing
 * `booking_participants` rows of the match's booking, so there is one source of truth for who is in a game.
 * `start`/`end` are venue-local YYYY-MM-DDTHH:MM like bookings. Timestamps are UTC ISO.
 */
export const MATCH_SCHEMA = `
CREATE TABLE IF NOT EXISTS open_matches (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  slot_id TEXT REFERENCES court_availability(id),
  facility_id TEXT NOT NULL REFERENCES facilities(id),
  court_id TEXT NOT NULL REFERENCES courts(id),
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'doubles' CHECK (format IN ('doubles', 'singles')),
  capacity INTEGER NOT NULL CHECK (capacity BETWEEN 2 AND 4),
  price_per_player_vnd INTEGER NOT NULL CHECK (price_per_player_vnd >= 0),
  min_level REAL NOT NULL,
  max_level REAL NOT NULL,
  host_player_id TEXT NOT NULL REFERENCES players(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN (${list(MATCH_STATUSES)})),
  demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (max_level >= min_level)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_open_matches_booking ON open_matches (booking_id);
CREATE INDEX IF NOT EXISTS idx_open_matches_status_start ON open_matches (status, start);
CREATE INDEX IF NOT EXISTS idx_open_matches_facility ON open_matches (facility_id, start);
CREATE INDEX IF NOT EXISTS idx_open_matches_host ON open_matches (host_player_id, status);

CREATE TABLE IF NOT EXISTS match_invitations (
  id TEXT PRIMARY KEY,
  open_match_id TEXT NOT NULL REFERENCES open_matches(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(id),
  invited_by TEXT NOT NULL REFERENCES players(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (${list(INVITATION_STATUSES)})),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  responded_at TEXT,
  UNIQUE (open_match_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_match_invitations_player ON match_invitations (player_id, status);
CREATE INDEX IF NOT EXISTS idx_match_invitations_status ON match_invitations (status, expires_at);

CREATE TABLE IF NOT EXISTS player_availability (
  player_id TEXT PRIMARY KEY REFERENCES players(id),
  opted_in INTEGER NOT NULL DEFAULT 0,
  windows_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS player_preferences (
  player_id TEXT PRIMARY KEY REFERENCES players(id),
  radius_km REAL NOT NULL DEFAULT 5,
  format TEXT NOT NULL DEFAULT 'doubles' CHECK (format IN ('doubles', 'singles')),
  start_pref TEXT NOT NULL DEFAULT 'asap',
  notifications_opt_in INTEGER NOT NULL DEFAULT 0,
  match_invite_opt_in INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
`;

export function ensureMatchSchema(db: DatabaseSync): void {
  db.exec(MATCH_SCHEMA);
}
