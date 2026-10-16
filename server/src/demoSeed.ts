import type { DatabaseSync } from 'node:sqlite';
import { RECORDING_COURT } from './config.js';

// Demo data for Play Now. Ratings are Playback Rating on the 2.0–5.0 scale (not DUPR).
// A legacy Elo integer still converts as 3.5 + (elo - 1500) / 200. Confidence is Low / Medium / High
// from verified matches, not a probability.

export const DEMO_FACILITY_ID = 'demo-facility';
export const DEMO_FACILITY_NAME = 'PlayBack Demo Club';
export const DEMO_RADIUS_KM = 5;

export type DemoFacility = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  courts: number;
  courtIds: string[];
};

const courtIds = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`);

export const DEMO_FACILITIES: DemoFacility[] = [
  {
    id: DEMO_FACILITY_ID,
    name: DEMO_FACILITY_NAME,
    latitude: 10.803,
    longitude: 106.741,
    courts: 8,
    courtIds: courtIds('court-', 8), // existing ids, match and session history keep working
  },
  {
    id: 'demo-facility-binh-thanh',
    name: 'Bình Thạnh Pickleball (Demo)',
    latitude: 10.791,
    longitude: 106.716, // about 3 km from the main facility
    courts: 5,
    courtIds: courtIds('demo-binh-thanh-court-', 5),
  },
  {
    id: 'demo-facility-quan-7',
    name: 'Quận 7 Pickleball (Demo)',
    latitude: 10.738,
    longitude: 106.71, // about 8 km from the main facility
    courts: 4,
    courtIds: courtIds('demo-quan-7-court-', 4),
  },
];

export const FACILITY_MIGRATION = `
CREATE TABLE IF NOT EXISTS facilities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS courts (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facilities(id),
  number INTEGER NOT NULL,
  records INTEGER NOT NULL DEFAULT 0,
  simulated INTEGER NOT NULL DEFAULT 1,
  demo INTEGER NOT NULL DEFAULT 0,
  UNIQUE (facility_id, number)
);
`;

export type DemoExtraPlayer = {
  id: string;
  displayName: string;
  language: 'en' | 'vi';
  skill: 'beginner' | 'intermediate' | 'advanced';
  hand: 'left' | 'right' | 'either';
  rating: number;
  matches: number;
  wins: number;
  latitude: number;
  longitude: number;
  homeFacilityId: string;
};

const MAIN = DEMO_FACILITY_ID;
const BT = 'demo-facility-binh-thanh';
const Q7 = 'demo-facility-quan-7';

// 12 players added to the 8 in club.ts. Four are brand new: provisional rating, zero matches.
export const DEMO_EXTRA_PLAYERS: DemoExtraPlayer[] = [
  { id: 'demo-linh', displayName: 'Linh Ngô', language: 'vi', skill: 'beginner', hand: 'right', rating: 2.5, matches: 4, wins: 1, latitude: 10.806, longitude: 106.738, homeFacilityId: MAIN },
  { id: 'demo-hung', displayName: 'Hùng Trịnh', language: 'vi', skill: 'beginner', hand: 'right', rating: 2.75, matches: 0, wins: 0, latitude: 10.8, longitude: 106.745, homeFacilityId: MAIN },
  { id: 'demo-thao', displayName: 'Thảo Đặng', language: 'vi', skill: 'beginner', hand: 'left', rating: 3.15, matches: 7, wins: 3, latitude: 10.795, longitude: 106.72, homeFacilityId: BT },
  { id: 'demo-nam', displayName: 'Nam Phan', language: 'vi', skill: 'intermediate', hand: 'right', rating: 3.35, matches: 12, wins: 6, latitude: 10.789, longitude: 106.713, homeFacilityId: BT },
  { id: 'demo-trang', displayName: 'Trang Dương', language: 'en', skill: 'intermediate', hand: 'either', rating: 3.5, matches: 0, wins: 0, latitude: 10.81, longitude: 106.735, homeFacilityId: MAIN },
  { id: 'demo-duc', displayName: 'Đức Lý', language: 'vi', skill: 'intermediate', hand: 'right', rating: 3.7, matches: 21, wins: 12, latitude: 10.741, longitude: 106.707, homeFacilityId: Q7 },
  { id: 'demo-phuong', displayName: 'Phương Hồ', language: 'vi', skill: 'intermediate', hand: 'left', rating: 3.85, matches: 30, wins: 17, latitude: 10.735, longitude: 106.714, homeFacilityId: Q7 },
  { id: 'demo-vy', displayName: 'Vy Cao', language: 'en', skill: 'beginner', hand: 'right', rating: 3.4, matches: 0, wins: 0, latitude: 10.792, longitude: 106.718, homeFacilityId: BT },
  { id: 'demo-bao', displayName: 'Bảo Tạ', language: 'vi', skill: 'advanced', hand: 'right', rating: 4.15, matches: 38, wins: 24, latitude: 10.802, longitude: 106.743, homeFacilityId: MAIN },
  { id: 'demo-chi', displayName: 'Chi Mai', language: 'vi', skill: 'advanced', hand: 'right', rating: 4.3, matches: 52, wins: 33, latitude: 10.798, longitude: 106.749, homeFacilityId: MAIN },
  { id: 'demo-dung', displayName: 'Dũng Châu', language: 'vi', skill: 'advanced', hand: 'left', rating: 4.5, matches: 64, wins: 44, latitude: 10.74, longitude: 106.705, homeFacilityId: Q7 },
  { id: 'demo-yen', displayName: 'Yến Thái', language: 'en', skill: 'advanced', hand: 'right', rating: 4.43, matches: 45, wins: 29, latitude: 10.787, longitude: 106.711, homeFacilityId: BT },
];

// Locations for the 8 original demo players from club.ts (their ratings and matches are untouched).
export const DEMO_ORIGINAL_LOCATIONS: Record<string, { latitude: number; longitude: number; homeFacilityId: string }> = {
  'demo-minh': { latitude: 10.804, longitude: 106.74, homeFacilityId: MAIN },
  'demo-lan': { latitude: 10.801, longitude: 106.744, homeFacilityId: MAIN },
  'demo-an': { latitude: 10.793, longitude: 106.719, homeFacilityId: BT },
  'demo-khoa': { latitude: 10.797, longitude: 106.747, homeFacilityId: MAIN },
  'demo-ha': { latitude: 10.79, longitude: 106.714, homeFacilityId: BT },
  'demo-quang': { latitude: 10.739, longitude: 106.709, homeFacilityId: Q7 },
  'demo-mai': { latitude: 10.807, longitude: 106.736, homeFacilityId: MAIN },
  'demo-tuan': { latitude: 10.736, longitude: 106.712, homeFacilityId: Q7 },
};

function ensureColumn(db: DatabaseSync, table: string, name: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((column) => column.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

/** Additive schema change: three nullable player columns plus the facilities and courts tables. */
export function ensureDemoSchema(db: DatabaseSync): void {
  ensureColumn(db, 'players', 'latitude', 'REAL');
  ensureColumn(db, 'players', 'longitude', 'REAL');
  ensureColumn(db, 'players', 'home_facility_id', 'TEXT');
  db.exec(FACILITY_MIGRATION);
}

/**
 * Idempotent. Default mode only inserts missing rows (INSERT OR IGNORE) and fills empty locations on
 * demo rows. Reset mode restores demo rows to seed values. Neither mode touches a row with demo = 0.
 */
export function seedDemoPlay(db: DatabaseSync, now: string, reset = false): void {
  const facility = db.prepare(
    'INSERT OR IGNORE INTO facilities (id, name, latitude, longitude, demo, created_at) VALUES (?, ?, ?, ?, 1, ?)',
  );
  const court = db.prepare(
    'INSERT OR IGNORE INTO courts (id, facility_id, number, records, simulated, demo) VALUES (?, ?, ?, ?, ?, 1)',
  );
  for (const item of DEMO_FACILITIES) {
    facility.run(item.id, item.name, item.latitude, item.longitude, now);
    item.courtIds.forEach((id, index) => {
      const records = id === RECORDING_COURT ? 1 : 0;
      court.run(id, item.id, index + 1, records, records ? 0 : 1);
    });
  }

  const upsert = db.prepare(
    `INSERT INTO players (
      id, display_name, language, skill, preferred_hand, pir_rating, wins, losses, matches_played,
      equipment_json, equipment_consent_at, recording_consent_at, demo, guest, created_at, updated_at,
      latitude, longitude, home_facility_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 1, 0, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO ${
      reset
        ? `UPDATE SET display_name = excluded.display_name, language = excluded.language, skill = excluded.skill,
           preferred_hand = excluded.preferred_hand, pir_rating = excluded.pir_rating, wins = excluded.wins,
           losses = excluded.losses, matches_played = excluded.matches_played, latitude = excluded.latitude,
           longitude = excluded.longitude, home_facility_id = excluded.home_facility_id, updated_at = excluded.updated_at
           WHERE players.demo = 1`
        : 'NOTHING'
    }`,
  );
  for (const p of DEMO_EXTRA_PLAYERS) {
    upsert.run(
      p.id, p.displayName, p.language, p.skill, p.hand, p.rating, p.wins, p.matches - p.wins, p.matches,
      now, now, p.latitude, p.longitude, p.homeFacilityId,
    );
  }

  const locate = db.prepare(
    `UPDATE players SET latitude = ?, longitude = ?, home_facility_id = ?
     WHERE id = ? AND demo = 1 AND (latitude IS NULL OR longitude IS NULL)`,
  );
  for (const [id, where] of Object.entries(DEMO_ORIGINAL_LOCATIONS)) {
    locate.run(where.latitude, where.longitude, where.homeFacilityId, id);
  }
}
