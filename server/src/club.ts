import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { RECORDING_COURT } from './config.js';
import {
  assignPlayer,
  confirmScore,
  initials,
  playerCheckInUrl,
  removePlayer,
  rosterStatus,
  verifyGuard,
  type MatchMode,
  type MatchStatus,
  type RosterSlot,
  type TeamId,
} from './lifecycle.js';
import { DEMO_FACILITY_ID, DEMO_FACILITY_NAME, ensureDemoSchema, seedDemoPlay } from './demoSeed.js';
import { seedPromotionRules } from './play/fillSchema.js';
import { recommendDoubles } from './matchmaking.js';
import { applyMatchResult, confidence, PIR_START, type PirPlayer } from './pir.js';
import { emptyVideoJob } from './videoJob.js';

export { DEMO_FACILITY_ID, DEMO_FACILITY_NAME };

const SIMULATED_ACTIVITY: Record<string, string> = {
  'court-2': 'idle',
  'court-3': 'in-use',
  'court-4': 'between-games',
  'court-5': 'idle',
  'court-6': 'in-use',
  'court-7': 'idle',
  'court-8': 'reserved',
};

type Seed = {
  id: string;
  displayName: string;
  language: 'en' | 'vi';
  skill: string | null;
  hand: 'left' | 'right' | 'either' | null;
  rating: number;
  equipment: string | null;
};

const SEED: Seed[] = [
  { id: 'demo-minh', displayName: 'Minh Trần', language: 'vi', skill: 'intermediate', hand: 'right', rating: 1520, equipment: null },
  { id: 'demo-lan', displayName: 'Lan Phạm', language: 'vi', skill: 'advanced', hand: 'right', rating: 1680, equipment: 'Demo paddle' },
  { id: 'demo-an', displayName: 'An Nguyễn', language: 'vi', skill: 'intermediate', hand: 'left', rating: 1410, equipment: null },
  { id: 'demo-khoa', displayName: 'Khoa Lê', language: 'vi', skill: 'intermediate', hand: 'right', rating: 1595, equipment: null },
  { id: 'demo-ha', displayName: 'Hà Vũ', language: 'vi', skill: 'beginner', hand: 'either', rating: 1550, equipment: null },
  { id: 'demo-quang', displayName: 'Quang Đỗ', language: 'vi', skill: 'advanced', hand: 'right', rating: 1710, equipment: null },
  { id: 'demo-mai', displayName: 'Mai Bùi', language: 'en', skill: 'beginner', hand: 'right', rating: 1380, equipment: null },
  { id: 'demo-tuan', displayName: 'Tuấn Hoàng', language: 'vi', skill: 'advanced', hand: 'left', rating: 1605, equipment: null },
];

/** Under this many matches a PIR rating is provisional. */
export const PROVISIONAL_BELOW = 5;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('en', 'vi')),
  skill TEXT,
  preferred_hand TEXT CHECK (preferred_hand IN ('left', 'right', 'either')),
  pir_rating INTEGER NOT NULL,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  matches_played INTEGER NOT NULL DEFAULT 0,
  equipment_json TEXT,
  equipment_consent_at TEXT,
  recording_consent_at TEXT,
  demo INTEGER NOT NULL DEFAULT 0,
  guest INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  court_id TEXT NOT NULL,
  facility_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('singles', 'doubles')),
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'ready', 'recording', 'completed', 'verified')),
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  duration_ms INTEGER,
  score_a INTEGER,
  score_b INTEGER,
  winner TEXT CHECK (winner IN ('A', 'B')),
  session_token TEXT,
  score_confirmed_at TEXT,
  verified_at TEXT,
  ratings_applied INTEGER NOT NULL DEFAULT 0,
  simulated INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS match_players (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(id),
  team TEXT NOT NULL CHECK (team IN ('A', 'B')),
  PRIMARY KEY (match_id, player_id)
);
CREATE TABLE IF NOT EXISTS rating_history (
  match_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  rating_before INTEGER NOT NULL,
  rating_after INTEGER NOT NULL,
  confidence_before REAL NOT NULL,
  confidence_after REAL NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (match_id, player_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS rating_history_once ON rating_history(match_id, player_id);
CREATE TABLE IF NOT EXISTS demo_analytics (
  id TEXT PRIMARY KEY,
  title_en TEXT NOT NULL,
  title_vi TEXT NOT NULL,
  body_en TEXT NOT NULL,
  body_vi TEXT NOT NULL
);
`;

export class ClubError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

type PlayerRow = {
  id: string;
  display_name: string;
  language: 'en' | 'vi';
  skill: string | null;
  preferred_hand: 'left' | 'right' | 'either' | null;
  pir_rating: number | bigint;
  wins: number | bigint;
  losses: number | bigint;
  matches_played: number | bigint;
  equipment_json: string | null;
  equipment_consent_at: string | null;
  recording_consent_at: string | null;
  demo: number | bigint;
  guest: number | bigint;
  latitude?: number | null;
  longitude?: number | null;
  home_facility_id?: string | null;
};

type MatchRow = {
  id: string;
  court_id: string;
  facility_id: string;
  mode: MatchMode;
  status: MatchStatus;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | bigint | null;
  score_a: number | bigint | null;
  score_b: number | bigint | null;
  winner: TeamId | null;
  session_token: string | null;
  score_confirmed_at: string | null;
  verified_at: string | null;
  ratings_applied: number | bigint;
  simulated: number | bigint;
  updated_at: string;
};

export type Equipment = { paddle?: string; shoes?: string; apparel?: string; notes?: string };

function n(value: number | bigint | null | undefined): number {
  return Number(value ?? 0);
}

function nullable(value: number | bigint | null | undefined): number | null {
  return value == null ? null : Number(value);
}

function equipmentOf(raw: string | null): Equipment | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Equipment;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function presentPlayer(row: PlayerRow, publicBaseUrl: string) {
  const played = n(row.matches_played);
  return {
    id: row.id,
    displayName: row.display_name,
    initials: initials(row.display_name),
    language: row.language,
    skill: row.skill,
    preferredHand: row.preferred_hand,
    rating: n(row.pir_rating),
    confidence: confidence(played),
    wins: n(row.wins),
    losses: n(row.losses),
    matchesPlayed: played,
    equipment: equipmentOf(row.equipment_json),
    equipmentConsentAt: row.equipment_consent_at,
    recordingConsentAt: row.recording_consent_at,
    demo: Number(row.demo) === 1 || row.id.startsWith('demo-'),
    guest: Number(row.guest) === 1,
    provisional: played < PROVISIONAL_BELOW,
    latitude: row.latitude ?? null,
    longitude: row.longitude ?? null,
    homeFacilityId: row.home_facility_id ?? null,
    checkInUrl: playerCheckInUrl(publicBaseUrl, row.id),
  };
}

function playerById(db: DatabaseSync, id: string): PlayerRow | undefined {
  return db.prepare('SELECT * FROM players WHERE id = ?').get(id) as PlayerRow | undefined;
}

function matchById(db: DatabaseSync, id: string): MatchRow | undefined {
  return db.prepare('SELECT * FROM matches WHERE id = ?').get(id) as MatchRow | undefined;
}

function requireMatch(db: DatabaseSync, id: string): MatchRow {
  const match = matchById(db, id);
  if (!match) throw new ClubError('not_found');
  return match;
}

function slotsOf(db: DatabaseSync, matchId: string): RosterSlot[] {
  const rows = db.prepare('SELECT player_id, team FROM match_players WHERE match_id = ? ORDER BY rowid').all(matchId) as {
    player_id: string;
    team: TeamId;
  }[];
  return rows.map((row) => ({ playerId: row.player_id, team: row.team }));
}

function writeSlots(db: DatabaseSync, matchId: string, slots: RosterSlot[]) {
  db.prepare('DELETE FROM match_players WHERE match_id = ?').run(matchId);
  const insert = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  for (const slot of slots) insert.run(matchId, slot.playerId, slot.team);
}

function presentMatch(db: DatabaseSync, match: MatchRow, publicBaseUrl: string) {
  const slots = slotsOf(db, match.id);
  const team = (side: TeamId) =>
    slots
      .filter((slot) => slot.team === side)
      .map((slot) => {
        const player = playerById(db, slot.playerId);
        return player ? presentPlayer(player, publicBaseUrl) : null;
      })
      .filter((player) => player !== null);
  const session = match.session_token
    ? (db.prepare('SELECT status FROM sessions WHERE public_token = ?').get(match.session_token) as { status: string } | undefined)
    : undefined;
  return {
    id: match.id,
    courtId: match.court_id,
    facilityId: match.facility_id,
    mode: match.mode,
    status: match.status,
    createdAt: match.created_at,
    startedAt: match.started_at,
    endedAt: match.ended_at,
    durationMs: nullable(match.duration_ms),
    scoreA: nullable(match.score_a),
    scoreB: nullable(match.score_b),
    winner: match.winner,
    sessionToken: match.session_token,
    sessionStatus: session?.status ?? null,
    simulated: Number(match.simulated) === 1,
    ratingsApplied: Number(match.ratings_applied) === 1,
    teams: { A: team('A'), B: team('B') },
  };
}

// Insert missing demo rows only. With reset, demo rows (demo = 1) go back to seed values; real rows are never touched.
function insertSeed(db: DatabaseSync, now: string, reset = false) {
  const insert = db.prepare(
    `INSERT INTO players (
      id, display_name, language, skill, preferred_hand, pir_rating, wins, losses, matches_played,
      equipment_json, equipment_consent_at, recording_consent_at, demo, guest, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, NULL, 1, 0, ?, ?)
    ON CONFLICT(id) DO ${
      reset
        ? `UPDATE SET display_name = excluded.display_name, language = excluded.language, skill = excluded.skill,
           preferred_hand = excluded.preferred_hand, pir_rating = excluded.pir_rating, wins = 0, losses = 0,
           matches_played = 0, equipment_json = excluded.equipment_json,
           equipment_consent_at = excluded.equipment_consent_at, updated_at = excluded.updated_at
           WHERE players.demo = 1`
        : 'NOTHING'
    }`,
  );
  for (const player of SEED) {
    const equipment = player.equipment ? JSON.stringify({ paddle: player.equipment }) : null;
    insert.run(
      player.id,
      player.displayName,
      player.language,
      player.skill,
      player.hand,
      player.rating,
      equipment,
      equipment ? now : null,
      now,
      now,
    );
  }
  db.prepare('INSERT OR IGNORE INTO demo_analytics (id, title_en, title_vi, body_en, body_vi) VALUES (?, ?, ?, ?, ?)').run(
    'brochure-hours',
    'Sample court time',
    'Giờ chơi mẫu',
    'A brochure sketch of busy hours. It is not calculated from matches on this computer.',
    'Bản phác giờ đông khách cho tờ giới thiệu. Không được tính từ các trận trên máy này.',
  );
}

function playerColumnNames(db: DatabaseSync): Set<string> {
  return new Set((db.prepare('PRAGMA table_info(players)').all() as { name: string }[]).map((column) => column.name));
}

/** Add columns an older players table lacks. Existing rows stay; the table is not rebuilt. */
function ensurePlayerColumns(db: DatabaseSync): void {
  const names = playerColumnNames(db);
  if (names.size === 0) return;
  const add = (name: string, definition: string) => {
    if (names.has(name)) return false;
    db.exec(`ALTER TABLE players ADD COLUMN ${name} ${definition}`);
    return true;
  };
  const addedDemo = add('demo', 'INTEGER NOT NULL DEFAULT 0');
  const addedGuest = add('guest', 'INTEGER NOT NULL DEFAULT 0');
  add('latitude', 'REAL');
  add('longitude', 'REAL');
  add('home_facility_id', 'TEXT');
  if (addedDemo && names.has('is_demo')) db.exec('UPDATE players SET demo = is_demo');
  if (addedGuest && names.has('is_guest')) db.exec('UPDATE players SET guest = is_guest');
}

export function ensureClubSchema(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(players)').all() as { name: string }[];
  if (columns.length > 0 && !columns.some((column) => column.name === 'pir_rating')) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(
      `DROP TABLE IF EXISTS rating_events;
       DROP TABLE IF EXISTS rating_history;
       DROP TABLE IF EXISTS video_jobs;
       DROP TABLE IF EXISTS match_players;
       DROP TABLE IF EXISTS equipment;
       DROP TABLE IF EXISTS matches;
       DROP TABLE IF EXISTS players;
       DROP TABLE IF EXISTS simulated_courts;
       DROP TABLE IF EXISTS demo_analytics;`,
    );
    db.exec('PRAGMA foreign_keys = ON');
  }
  db.exec(SCHEMA);
  ensurePlayerColumns(db);
  ensureDemoSchema(db);
  const now = new Date().toISOString();
  insertSeed(db, now);
  seedDemoPlay(db, now);
  db.prepare(`UPDATE players SET demo = 1, guest = 0 WHERE id LIKE 'demo-%' AND demo = 0`).run();
}

function openMatch(db: DatabaseSync, courtId: string): MatchRow | undefined {
  return db
    .prepare(
      `SELECT * FROM matches WHERE court_id = ? AND status IN ('scheduled', 'ready', 'recording') ORDER BY created_at DESC LIMIT 1`,
    )
    .get(courtId) as MatchRow | undefined;
}

function createMatch(db: DatabaseSync, courtId: string, now: string): MatchRow {
  const id = randomBytes(12).toString('base64url');
  db.prepare(
    `INSERT INTO matches (
      id, court_id, facility_id, mode, status, created_at, started_at, ended_at, duration_ms,
      score_a, score_b, winner, session_token, score_confirmed_at, verified_at, ratings_applied, simulated, updated_at
    ) VALUES (?, ?, ?, 'singles', 'scheduled', ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, ?)`,
  ).run(id, courtId, DEMO_FACILITY_ID, now, now);
  const row = matchById(db, id);
  if (!row) throw new ClubError('not_found');
  return row;
}

export function listPlayers(db: DatabaseSync, publicBaseUrl: string) {
  const rows = db.prepare('SELECT * FROM players ORDER BY display_name').all() as PlayerRow[];
  return rows.map((row) => presentPlayer(row, publicBaseUrl));
}

const ANALYTICS = {
  demo: true as const,
  titleEn: 'Sample court time',
  titleVi: 'Giờ chơi mẫu',
  bodyEn: 'A brochure sketch of busy hours. It is not calculated from matches on this computer.',
  bodyVi: 'Bản phác giờ đông khách cho tờ giới thiệu. Không được tính từ các trận trên máy này.',
};

export function getPlayer(db: DatabaseSync, id: string, publicBaseUrl: string) {
  const row = playerById(db, id);
  if (!row) throw new ClubError('not_found');
  const history = db
    .prepare(
      `SELECT match_id, rating_before, rating_after, confidence_before, confidence_after, created_at
       FROM rating_history WHERE player_id = ? ORDER BY created_at`,
    )
    .all(id) as {
    match_id: string;
    rating_before: number | bigint;
    rating_after: number | bigint;
    confidence_before: number;
    confidence_after: number;
    created_at: string;
  }[];
  const matches = db
    .prepare(
      `SELECT m.id, m.court_id, m.mode, m.status, mp.team, m.score_a, m.score_b, m.winner, m.created_at, m.simulated, m.session_token
       FROM match_players mp JOIN matches m ON m.id = mp.match_id
       WHERE mp.player_id = ? ORDER BY m.created_at DESC`,
    )
    .all(id) as {
    id: string;
    court_id: string;
    mode: MatchMode;
    status: MatchStatus;
    team: TeamId;
    score_a: number | bigint | null;
    score_b: number | bigint | null;
    winner: TeamId | null;
    created_at: string;
    simulated: number | bigint;
    session_token: string | null;
  }[];
  return {
    ...presentPlayer(row, publicBaseUrl),
    history: history.map((point) => ({
      matchId: point.match_id,
      ratingBefore: n(point.rating_before),
      ratingAfter: n(point.rating_after),
      confidenceBefore: point.confidence_before,
      confidenceAfter: point.confidence_after,
      at: point.created_at,
    })),
    matches: matches.map((match) => ({
      id: match.id,
      courtId: match.court_id,
      mode: match.mode,
      status: match.status,
      team: match.team,
      scoreA: nullable(match.score_a),
      scoreB: nullable(match.score_b),
      winner: match.winner,
      at: match.created_at,
      simulated: Number(match.simulated) === 1,
      sessionToken: match.session_token,
    })),
    unmeasured: { serveSpeed: null, shotPlacement: null, movement: null },
    simulatedAnalytics: ANALYTICS,
  };
}

export function createGuest(db: DatabaseSync, displayName: string, language: 'en' | 'vi', publicBaseUrl: string) {
  const now = new Date().toISOString();
  const id = `guest-${randomBytes(6).toString('base64url')}`;
  db.prepare(
    `INSERT INTO players (
      id, display_name, language, skill, preferred_hand, pir_rating, wins, losses, matches_played,
      equipment_json, equipment_consent_at, recording_consent_at, demo, guest, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, NULL, ?, 0, 0, 0, NULL, NULL, NULL, 0, 1, ?, ?)`,
  ).run(id, displayName, language, PIR_START, now, now);
  const row = playerById(db, id);
  if (!row) throw new ClubError('not_found');
  return presentPlayer(row, publicBaseUrl);
}

const LOCKED = new Set(['rating', 'pir', 'wins', 'losses', 'confidence', 'matchesPlayed', 'pirRating']);

export function updatePlayer(
  db: DatabaseSync,
  id: string,
  body: Record<string, unknown>,
  publicBaseUrl: string,
) {
  if (Object.keys(body).some((key) => LOCKED.has(key))) throw new ClubError('invalid_body');
  const row = playerById(db, id);
  if (!row) throw new ClubError('not_found');
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : row.display_name;
  if (!displayName || displayName.length > 40) throw new ClubError('invalid_body');
  const language = body.language === 'en' || body.language === 'vi' ? body.language : row.language;
  const skill = body.skill === undefined ? row.skill : body.skill === null || body.skill === '' ? null : String(body.skill);
  const hand = body.preferredHand === undefined ? row.preferred_hand : body.preferredHand;
  if (hand !== null && hand !== 'left' && hand !== 'right' && hand !== 'either') throw new ClubError('invalid_body');
  let equipment = row.equipment_json;
  let consentAt = row.equipment_consent_at;
  if (body.equipment !== undefined || body.equipmentConsent !== undefined) {
    // Equipment has its own consent, separate from recording consent. Withdrawing it removes the equipment.
    if (body.equipment === null || (body.equipment === undefined && body.equipmentConsent === false)) {
      equipment = null;
      consentAt = null;
    } else if (body.equipment && typeof body.equipment === 'object' && !Array.isArray(body.equipment)) {
      if (body.equipmentConsent === false || (body.equipmentConsent !== true && !consentAt)) {
        throw new ClubError('consent_required');
      }
      const clean: Record<string, string> = {};
      for (const key of ['paddle', 'shoes', 'apparel', 'notes'] as const) {
        const value = (body.equipment as Record<string, unknown>)[key];
        if (typeof value === 'string' && value.trim()) clean[key] = value.trim().slice(0, 80);
      }
      equipment = JSON.stringify(clean);
      consentAt = consentAt ?? new Date().toISOString();
    } else if (body.equipment === undefined && body.equipmentConsent === true) {
      consentAt = consentAt ?? new Date().toISOString();
    } else {
      throw new ClubError('invalid_body');
    }
  }
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE players SET display_name = ?, language = ?, skill = ?, preferred_hand = ?, equipment_json = ?, equipment_consent_at = ?, updated_at = ? WHERE id = ?`,
  ).run(displayName, language, skill, hand, equipment, consentAt, now, id);
  return presentPlayer(playerById(db, id)!, publicBaseUrl);
}

export function courtMatch(db: DatabaseSync, courtId: string, publicBaseUrl: string) {
  const match = openMatch(db, courtId);
  return { match: match ? presentMatch(db, match, publicBaseUrl) : null };
}

export function joinCourt(db: DatabaseSync, courtId: string, playerId: string, team: TeamId, publicBaseUrl: string) {
  if (!playerById(db, playerId)) throw new ClubError('not_found');
  const now = new Date().toISOString();
  const existing = openMatch(db, courtId) ?? createMatch(db, courtId, now);
  if (existing.status === 'recording') throw new ClubError('match_in_progress');
  const busy = db
    .prepare(
      `SELECT m.id FROM match_players mp JOIN matches m ON m.id = mp.match_id
       WHERE mp.player_id = ? AND m.status IN ('scheduled', 'ready', 'recording') AND m.id != ?`,
    )
    .get(playerId, existing.id) as { id: string } | undefined;
  if (busy) throw new ClubError('duplicate_player');
  const placed = assignPlayer(existing.mode, slotsOf(db, existing.id), playerId, team);
  if (!placed.ok) throw new ClubError(placed.error);
  const status = rosterStatus(existing.mode, placed.slots);
  db.exec('BEGIN');
  try {
    writeSlots(db, existing.id, placed.slots);
    db.prepare('UPDATE matches SET status = ?, updated_at = ? WHERE id = ?').run(status, now, existing.id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return presentMatch(db, requireMatch(db, existing.id), publicBaseUrl);
}

export function leaveMatch(db: DatabaseSync, matchId: string, playerId: string, publicBaseUrl: string) {
  const match = requireMatch(db, matchId);
  if (match.status !== 'scheduled' && match.status !== 'ready') throw new ClubError('match_in_progress');
  const slots = removePlayer(slotsOf(db, match.id), playerId);
  const now = new Date().toISOString();
  writeSlots(db, match.id, slots);
  db.prepare('UPDATE matches SET status = ?, updated_at = ? WHERE id = ?').run(rosterStatus(match.mode, slots), now, match.id);
  return presentMatch(db, requireMatch(db, match.id), publicBaseUrl);
}

export function setMatchMode(db: DatabaseSync, matchId: string, mode: MatchMode, publicBaseUrl: string) {
  const match = requireMatch(db, matchId);
  if (match.status !== 'scheduled' && match.status !== 'ready') throw new ClubError('match_in_progress');
  const slots = slotsOf(db, match.id);
  const capacity = mode === 'singles' ? 1 : 2;
  if (slots.filter((slot) => slot.team === 'A').length > capacity || slots.filter((slot) => slot.team === 'B').length > capacity) {
    throw new ClubError('roster_too_large');
  }
  const now = new Date().toISOString();
  db.prepare('UPDATE matches SET mode = ?, status = ?, updated_at = ? WHERE id = ?').run(
    mode,
    rosterStatus(mode, slots),
    now,
    match.id,
  );
  return presentMatch(db, requireMatch(db, match.id), publicBaseUrl);
}

export function attachSession(db: DatabaseSync, matchId: string, token: string, publicBaseUrl: string) {
  const match = requireMatch(db, matchId);
  if (match.status !== 'ready' && match.status !== 'recording') throw new ClubError('not_ready');
  const session = db.prepare('SELECT public_token, court_id, status, consent_at FROM sessions WHERE public_token = ?').get(token) as
    | { public_token: string; court_id: string; status: string; consent_at: string }
    | undefined;
  if (!session || session.court_id !== match.court_id) throw new ClubError('not_found');
  if (session.court_id !== RECORDING_COURT) throw new ClubError('simulated_court');
  const now = new Date().toISOString();
  const recording = session.status === 'recording';
  db.prepare(
    `UPDATE matches SET session_token = ?, simulated = 0, status = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?`,
  ).run(token, recording ? 'recording' : 'ready', recording ? now : null, now, match.id);
  const stamp = db.prepare('UPDATE players SET recording_consent_at = COALESCE(recording_consent_at, ?), updated_at = ? WHERE id = ?');
  for (const slot of slotsOf(db, match.id)) stamp.run(session.consent_at, now, slot.playerId);
  return presentMatch(db, requireMatch(db, match.id), publicBaseUrl);
}

export function markMatchRecording(db: DatabaseSync, token: string, startedAt: string): void {
  db.prepare(
    `UPDATE matches SET status = 'recording', started_at = COALESCE(started_at, ?), simulated = 0, updated_at = ?
     WHERE session_token = ? AND status = 'ready'`,
  ).run(startedAt, startedAt, token);
}

export function releaseMatchRecording(db: DatabaseSync, token: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE matches SET status = 'ready', session_token = NULL, started_at = NULL, updated_at = ?
     WHERE session_token = ? AND status = 'recording' AND ratings_applied = 0 AND score_confirmed_at IS NULL`,
  ).run(now, token);
}

export function startSimulated(db: DatabaseSync, matchId: string, publicBaseUrl: string) {
  const match = requireMatch(db, matchId);
  if (match.court_id === RECORDING_COURT) throw new ClubError('use_laptop_camera');
  if (match.status !== 'ready') throw new ClubError('not_ready');
  const now = new Date().toISOString();
  const info = db
    .prepare(`UPDATE matches SET status = 'recording', simulated = 1, started_at = ?, updated_at = ? WHERE id = ? AND status = 'ready'`)
    .run(now, now, match.id);
  if (Number(info.changes) !== 1) throw new ClubError('not_ready');
  return presentMatch(db, requireMatch(db, match.id), publicBaseUrl);
}

export function confirmMatchScore(db: DatabaseSync, matchId: string, scoreA: number, scoreB: number, publicBaseUrl: string) {
  const decision = confirmScore(scoreA, scoreB);
  if (!decision.ok) throw new ClubError(decision.error);
  const match = requireMatch(db, matchId);
  if (match.status !== 'recording') throw new ClubError('not_recording');
  if (!Number(match.simulated)) {
    const session = match.session_token
      ? (db.prepare('SELECT status, duration_ms FROM sessions WHERE public_token = ?').get(match.session_token) as
          | { status: string; duration_ms: number | null }
          | undefined)
      : undefined;
    if (!session || session.status !== 'ready') throw new ClubError('recording_not_saved');
  }
  const now = new Date().toISOString();
  let duration: number | null = null;
  if (match.session_token) {
    const session = db.prepare('SELECT duration_ms FROM sessions WHERE public_token = ?').get(match.session_token) as
      | { duration_ms: number | null }
      | undefined;
    if (session?.duration_ms != null) duration = Number(session.duration_ms);
  }
  if (duration == null && match.started_at) duration = Math.max(0, Date.parse(now) - Date.parse(match.started_at));
  const info = db
    .prepare(
      `UPDATE matches SET status = 'completed', score_a = ?, score_b = ?, winner = ?, ended_at = ?, duration_ms = ?,
        score_confirmed_at = ?, updated_at = ? WHERE id = ? AND status = 'recording'`,
    )
    .run(scoreA, scoreB, decision.winner, now, duration, now, now, match.id);
  if (Number(info.changes) !== 1) throw new ClubError('not_recording');
  return presentMatch(db, requireMatch(db, match.id), publicBaseUrl);
}

export function verifyMatch(db: DatabaseSync, matchId: string, publicBaseUrl: string) {
  const match = requireMatch(db, matchId);
  const guard = verifyGuard(match.status, Number(match.ratings_applied) === 1);
  if (guard === 'already_applied') throw new ClubError('already_verified');
  if (guard === 'not_completed') throw new ClubError('not_completed');
  if (match.winner !== 'A' && match.winner !== 'B') throw new ClubError('not_completed');
  const slots = slotsOf(db, match.id);
  const load = (team: TeamId): PirPlayer[] =>
    slots
      .filter((slot) => slot.team === team)
      .map((slot) => {
        const player = playerById(db, slot.playerId);
        if (!player) throw new ClubError('not_found');
        return { id: player.id, rating: n(player.pir_rating), matchesPlayed: n(player.matches_played) };
      });
  const updates = applyMatchResult(load('A'), load('B'), match.winner);
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    const current = requireMatch(db, match.id);
    if (verifyGuard(current.status, Number(current.ratings_applied) === 1) !== 'ok') throw new ClubError('already_verified');
    const history = db.prepare(
      `INSERT INTO rating_history (match_id, player_id, rating_before, rating_after, confidence_before, confidence_after, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const apply = db.prepare(
      `UPDATE players SET pir_rating = ?, wins = wins + ?, losses = losses + ?, matches_played = ?, updated_at = ? WHERE id = ?`,
    );
    for (const update of updates) {
      history.run(match.id, update.id, update.ratingBefore, update.ratingAfter, update.confidenceBefore, update.confidenceAfter, now);
      apply.run(update.ratingAfter, update.won ? 1 : 0, update.won ? 0 : 1, update.matchesPlayed, now, update.id);
    }
    const info = db
      .prepare(`UPDATE matches SET status = 'verified', verified_at = ?, ratings_applied = 1, updated_at = ? WHERE id = ? AND status = 'completed' AND ratings_applied = 0`)
      .run(now, now, match.id);
    if (Number(info.changes) !== 1) throw new ClubError('already_verified');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return presentMatch(db, requireMatch(db, match.id), publicBaseUrl);
}

export function getMatch(db: DatabaseSync, matchId: string, publicBaseUrl: string) {
  return presentMatch(db, requireMatch(db, matchId), publicBaseUrl);
}

export function matchForSession(db: DatabaseSync, token: string, publicBaseUrl: string) {
  const match = db.prepare('SELECT * FROM matches WHERE session_token = ?').get(token) as MatchRow | undefined;
  return { match: match ? presentMatch(db, match, publicBaseUrl) : null };
}

export function videoJob(matchId: string) {
  if (!matchId) throw new ClubError('not_found');
  return emptyVideoJob(matchId);
}

export function recommendFromIds(db: DatabaseSync, ids: string[]) {
  const players = ids.map((id) => {
    const player = playerById(db, id);
    if (!player) throw new ClubError('not_found');
    return { id: player.id, displayName: player.display_name, rating: n(player.pir_rating) };
  });
  try {
    return recommendDoubles(players);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid_body';
    if (message === 'need_four_players' || message === 'duplicate_player') throw new ClubError(message);
    throw new ClubError('invalid_body');
  }
}

export function facilitySummary(db: DatabaseSync, publicBaseUrl: string) {
  const courts = ['court-1', 'court-2', 'court-3', 'court-4', 'court-5', 'court-6', 'court-7', 'court-8'].map((id) => {
    const number = Number(id.slice('court-'.length));
    const match = openMatch(db, id);
    return {
      id,
      number,
      records: id === RECORDING_COURT,
      simulated: id !== RECORDING_COURT,
      activity: match?.status ?? (id === RECORDING_COURT ? 'idle' : (SIMULATED_ACTIVITY[id] ?? 'idle')),
      match: match ? presentMatch(db, match, publicBaseUrl) : null,
    };
  });
  const active = db
    .prepare(`SELECT COUNT(*) AS n FROM matches WHERE status IN ('scheduled', 'ready', 'recording')`)
    .get() as { n: number | bigint };
  const completed = db
    .prepare(`SELECT COUNT(*) AS n FROM matches WHERE status IN ('completed', 'verified')`)
    .get() as { n: number | bigint };
  const players = db.prepare('SELECT COUNT(*) AS n FROM players').get() as { n: number | bigint };
  const time = db.prepare(`SELECT COALESCE(SUM(duration_ms), 0) AS n FROM sessions WHERE status = 'ready'`).get() as {
    n: number | bigint;
  };
  const participation = db
    .prepare(
      `SELECT COUNT(DISTINCT mp.player_id) AS n FROM match_players mp
       JOIN matches m ON m.id = mp.match_id WHERE m.status IN ('completed', 'verified')`,
    )
    .get() as { n: number | bigint };
  return {
    id: DEMO_FACILITY_ID,
    name: DEMO_FACILITY_NAME,
    demo: true as const,
    productionLogin: false as const,
    facilities: listFacilities(db),
    courts,
    activeSessions: n(active.n),
    completedMatches: n(completed.n),
    players: n(players.n),
    recordingTimeMs: n(time.n),
    participation: n(participation.n),
  };
}

export function listFacilities(db: DatabaseSync) {
  const rows = db
    .prepare(
      `SELECT f.id, f.name, f.latitude, f.longitude, f.demo, c.id AS court_id, c.number, c.records, c.simulated
       FROM facilities f LEFT JOIN courts c ON c.facility_id = f.id ORDER BY f.created_at, f.id, c.number`,
    )
    .all() as Record<string, string | number | bigint | null>[];
  type FacilityOut = { id: string; name: unknown; latitude: number; longitude: number; demo: boolean; courts: { id: unknown; number: number; records: boolean; simulated: boolean }[] };
  const byId = new Map<string, FacilityOut>();
  for (const row of rows) {
    const id = String(row.id);
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        name: row.name,
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        demo: Number(row.demo) === 1,
        courts: [],
      });
    }
    if (row.court_id) {
      byId.get(id)?.courts.push({
        id: row.court_id,
        number: Number(row.number),
        records: Number(row.records) === 1,
        simulated: Number(row.simulated) === 1,
      });
    }
  }
  return [...byId.values()];
}

export function resetDemo(db: DatabaseSync): { ok: true; recordingsKept: true } {
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    // Only demo-only matches go. A match with a real player stays, and so do sessions and recordings.
    const demoOnly = `SELECT m.id FROM matches m WHERE NOT EXISTS (
      SELECT 1 FROM match_players mp JOIN players p ON p.id = mp.player_id WHERE mp.match_id = m.id AND p.demo = 0)`;
    // Players that Play Now tables point at (bookings, holds, open matches, invitations, preferences) stay: they are restored below.
    const playRefs = [
      ['booking_participants', 'player_id'],
      ['bookings', 'created_by_player'],
      ['court_holds', 'player_id'],
      ['open_matches', 'host_player_id'],
      ['match_invitations', 'player_id'],
      ['match_invitations', 'invited_by'],
      ['player_preferences', 'player_id'],
      ['player_availability', 'player_id'],
      ['queue_entries', 'player_id'],
      ['fill_requests', 'player_id'],
    ]
      .filter(([table]) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
      .map(([table, column]) => ` AND id NOT IN (SELECT ${column} FROM ${table})`)
      .join('');
    const freeDemoPlayers = `SELECT id FROM players WHERE demo = 1 AND id NOT IN (
      SELECT player_id FROM match_players WHERE match_id NOT IN (${demoOnly}))${playRefs}`;
    db.exec(`DELETE FROM rating_history WHERE match_id IN (${demoOnly}) OR player_id IN (${freeDemoPlayers})`);
    db.exec(`DELETE FROM match_players WHERE match_id IN (${demoOnly})`);
    db.exec(`DELETE FROM matches WHERE id IN (${demoOnly})`);
    db.exec(`DELETE FROM players WHERE id IN (${freeDemoPlayers})`);
    db.exec('DELETE FROM demo_analytics');
    insertSeed(db, now, true);
    seedDemoPlay(db, now, true);
    // Restores labeled demo promotion rules. Does not delete bookings.
    seedPromotionRules(db, now, true);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { ok: true, recordingsKept: true };
}
