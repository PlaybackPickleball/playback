import type { DatabaseSync } from 'node:sqlite';
import { haversineKm, type LatLng } from '../geo.js';
import { recommendDoubles } from '../matchmaking.js';
import {
  applyTransition,
  createBooking,
  getBookingRow,
  guarded,
  playerClash,
  releaseExpiredHolds,
  type BookingRow,
} from './bookings.js';
import { recordAttribution } from './fillSchema.js';
import {
  DEFAULT_RADIUS_KM,
  DISCLAIMER,
  displayLevel,
  isProvisional,
  levelFits,
  levelFromPir,
  rankCandidates,
  rankMatches,
  slotFit,
  type AvailabilityWindow,
  type Candidate,
  type Format,
  type Reliability,
  type SearchContext,
  type StartPref,
  type Target,
} from './matching.js';
import type { InvitationStatus, MatchStatus } from './matchSchema.js';
import { queueSummary, sweepQueue } from './queue.js';
import { TIME_RE, fail, iso, newId, rowNum, venueLocal, validDate, type PlayConfig } from './util.js';

/** Singles is in the schema, but only doubles can be created and searched until the UI supports it. */
export const SUPPORTED_FORMATS: readonly Format[] = ['doubles'];
const PRICE_STEP_VND = 5000;
const MAX_SLOTS = 8;
const MAX_CANDIDATES = 5;

// ------------------------------------------------------------------ rows

type MatchRow = {
  id: string;
  booking_id: string;
  slot_id: string | null;
  facility_id: string;
  court_id: string;
  start: string;
  end: string;
  format: Format;
  capacity: number | bigint;
  price_per_player_vnd: number | bigint;
  min_level: number;
  max_level: number;
  host_player_id: string;
  status: MatchStatus;
  demo: number | bigint;
  created_at: string;
  updated_at: string;
};
type PlayerRow = {
  id: string;
  display_name: string;
  pir_rating: number | bigint;
  matches_played: number | bigint;
  latitude: number | null;
  longitude: number | null;
  home_facility_id: string | null;
};
type InvitationRow = {
  id: string;
  open_match_id: string;
  player_id: string;
  invited_by: string;
  status: InvitationStatus;
  created_at: string;
  expires_at: string;
  responded_at: string | null;
};

const getMatch = (db: DatabaseSync, id: string) =>
  db.prepare('SELECT * FROM open_matches WHERE id = ?').get(id) as MatchRow | undefined;
const getPlayer = (db: DatabaseSync, id: string) =>
  db.prepare('SELECT id, display_name, pir_rating, matches_played, latitude, longitude, home_facility_id FROM players WHERE id = ?').get(id) as
    | PlayerRow
    | undefined;
const nowLocalOf = (cfg: PlayConfig) => venueLocal(cfg.now());

// ---------------------------------------------------------- lifecycle sync

/**
 * Brings matches and invitations in line with their bookings. A held court that lapses, a cancelled booking
 * or a start time in the past ends the match, and its pending invitations expire with it (the seat is freed).
 */
export function syncMatches(db: DatabaseSync, cfg: PlayConfig): void {
  releaseExpiredHolds(db, cfg);
  const nowIso = iso(cfg.now());
  const nowLocal = nowLocalOf(cfg);
  const open = db
    .prepare(
      `SELECT m.id, m.booking_id, m.start, m.status, b.status AS booking_status FROM open_matches m
       JOIN bookings b ON b.id = m.booking_id WHERE m.status IN ('open', 'confirmed')`,
    )
    .all() as { id: string; booking_id: string; start: string; status: MatchStatus; booking_status: string }[];
  const touch = db.prepare('UPDATE open_matches SET status = ?, updated_at = ? WHERE id = ?');
  for (const row of open) {
    if (row.booking_status === 'cancelled') touch.run('cancelled', nowIso, row.id);
    else if (row.booking_status === 'expired') touch.run('expired', nowIso, row.id);
    else if (row.status === 'open' && row.start <= nowLocal) {
      const booking = getBookingRow(db, row.booking_id);
      if (booking && (booking.status === 'held' || booking.status === 'pending')) {
        applyTransition(db, cfg, booking, 'expired', { kind: 'system' });
      }
      touch.run('expired', nowIso, row.id);
    }
  }
  db.prepare(
    `UPDATE match_invitations SET status = 'expired', responded_at = ?
     WHERE status = 'pending' AND (expires_at <= ? OR open_match_id IN (SELECT id FROM open_matches WHERE status <> 'open'))`,
  ).run(nowIso, nowIso);
}

// -------------------------------------------------------------- reliability

/** Share of completed games among completed plus no-show games. Null until there is a real record. */
function reliabilityOf(db: DatabaseSync, ids: string[]): Map<string, Reliability> {
  const out = new Map<string, Reliability>();
  if (ids.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT p.player_id AS id,
              SUM(CASE WHEN b.status = 'completed' THEN 1 ELSE 0 END) AS done,
              SUM(CASE WHEN b.status = 'no_show' THEN 1 ELSE 0 END) AS missed
       FROM booking_participants p JOIN bookings b ON b.id = p.booking_id
       WHERE p.status = 'joined' AND b.status IN ('completed', 'no_show') AND p.player_id IN (${ids.map(() => '?').join(',')})
       GROUP BY p.player_id`,
    )
    .all(...ids) as { id: string; done: number | bigint; missed: number | bigint }[];
  for (const row of rows) {
    const done = rowNum(row.done);
    const sample = done + rowNum(row.missed);
    out.set(row.id, sample > 0 ? { sample, rate: done / sample } : null);
  }
  return out;
}

// ------------------------------------------------------------- preferences

export function parseStart(value: unknown): StartPref | null {
  if (value == null || value === '' || value === 'asap') return { kind: 'asap' };
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(value) && validDate(value.slice(0, 10))) {
    return { kind: 'target', at: value };
  }
  if (typeof value === 'string' && value.startsWith('{')) {
    try {
      return parseStart(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (v.date != null && !validDate(v.date)) return null;
    for (const key of ['from', 'to']) if (v[key] != null && (typeof v[key] !== 'string' || !TIME_RE.test(v[key] as string))) return null;
    return { kind: 'window', date: v.date as string | undefined, from: v.from as string | undefined, to: v.to as string | undefined };
  }
  return null;
}
const startToText = (s: StartPref) => (s.kind === 'asap' ? 'asap' : s.kind === 'target' ? s.at : JSON.stringify(s));

export type Preferences = {
  radiusKm: number;
  format: Format;
  start: StartPref;
  notificationsOptIn: boolean;
  matchInviteOptIn: boolean;
  availability: { optedIn: boolean; windows: AvailabilityWindow[] };
};

function parseWindows(value: unknown): AvailabilityWindow[] {
  if (!Array.isArray(value) || value.length > 28) return fail(400, 'invalid_windows');
  return value.map((w) => {
    const v = w as Record<string, unknown>;
    if (!Number.isInteger(v.day) || (v.day as number) < 0 || (v.day as number) > 6) return fail(400, 'invalid_windows');
    if (typeof v.start !== 'string' || typeof v.end !== 'string' || !TIME_RE.test(v.start) || !TIME_RE.test(v.end) || v.end <= v.start) {
      return fail(400, 'invalid_windows');
    }
    return { day: v.day as number, start: v.start, end: v.end };
  });
}

export function getPreferences(db: DatabaseSync, playerId: string): Preferences {
  const pref = db.prepare('SELECT * FROM player_preferences WHERE player_id = ?').get(playerId) as
    | { radius_km: number; format: Format; start_pref: string; notifications_opt_in: number | bigint; match_invite_opt_in: number | bigint }
    | undefined;
  const avail = db.prepare('SELECT * FROM player_availability WHERE player_id = ?').get(playerId) as
    | { opted_in: number | bigint; windows_json: string }
    | undefined;
  return {
    radiusKm: pref?.radius_km ?? DEFAULT_RADIUS_KM,
    format: pref?.format ?? 'doubles',
    start: parseStart(pref?.start_pref ?? 'asap') ?? { kind: 'asap' },
    notificationsOptIn: pref ? rowNum(pref.notifications_opt_in) === 1 : false,
    matchInviteOptIn: pref ? rowNum(pref.match_invite_opt_in) === 1 : false,
    // No availability row means the player has not restricted anything.
    availability: {
      optedIn: avail ? rowNum(avail.opted_in) === 1 : true,
      windows: avail ? (JSON.parse(avail.windows_json) as AvailabilityWindow[]) : [],
    },
  };
}

export function setPreferences(db: DatabaseSync, cfg: PlayConfig, playerId: string, input: Record<string, unknown>): Preferences {
  const current = getPreferences(db, playerId);
  const radius = input.radiusKm === undefined ? current.radiusKm : Number(input.radiusKm);
  if (!Number.isFinite(radius) || radius < 0.5 || radius > 50) return fail(400, 'invalid_radius');
  const format = input.format === undefined ? current.format : input.format;
  if (typeof format !== 'string' || !SUPPORTED_FORMATS.includes(format as Format)) return fail(400, 'format_not_supported_yet');
  const start = input.start === undefined ? current.start : parseStart(input.start);
  if (!start) return fail(400, 'invalid_start');
  for (const key of ['notificationsOptIn', 'matchInviteOptIn']) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') return fail(400, 'invalid_body');
  }
  const availability = input.availability as Record<string, unknown> | undefined;
  if (availability !== undefined && (availability === null || typeof availability !== 'object')) return fail(400, 'invalid_body');
  if (availability?.optedIn !== undefined && typeof availability.optedIn !== 'boolean') return fail(400, 'invalid_body');
  const windows = availability?.windows === undefined ? current.availability.windows : parseWindows(availability.windows);
  const optedIn = availability?.optedIn === undefined ? current.availability.optedIn : (availability.optedIn as boolean);
  const stamp = iso(cfg.now());
  guarded(db, () => {
    db.prepare(
      `INSERT INTO player_preferences (player_id, radius_km, format, start_pref, notifications_opt_in, match_invite_opt_in, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(player_id) DO UPDATE SET radius_km = excluded.radius_km, format = excluded.format, start_pref = excluded.start_pref,
         notifications_opt_in = excluded.notifications_opt_in, match_invite_opt_in = excluded.match_invite_opt_in, updated_at = excluded.updated_at`,
    ).run(
      playerId,
      radius,
      format,
      startToText(start),
      (input.notificationsOptIn ?? current.notificationsOptIn) ? 1 : 0,
      (input.matchInviteOptIn ?? current.matchInviteOptIn) ? 1 : 0,
      stamp,
    );
    db.prepare(
      `INSERT INTO player_availability (player_id, opted_in, windows_json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(player_id) DO UPDATE SET opted_in = excluded.opted_in, windows_json = excluded.windows_json, updated_at = excluded.updated_at`,
    ).run(playerId, optedIn ? 1 : 0, JSON.stringify(windows), stamp);
  });
  return getPreferences(db, playerId);
}

// ------------------------------------------------------------- presenting

type PublicParticipant = { playerId: string; displayName: string; level: number; provisional: boolean; isHost: boolean };

function participantsOf(db: DatabaseSync, match: MatchRow): (PublicParticipant & { pir: number })[] {
  const rows = db
    .prepare(
      `SELECT pl.id, pl.display_name, pl.pir_rating, pl.matches_played FROM booking_participants p
       JOIN players pl ON pl.id = p.player_id WHERE p.booking_id = ? AND p.status = 'joined' ORDER BY pl.display_name, pl.id`,
    )
    .all(match.booking_id) as { id: string; display_name: string; pir_rating: number | bigint; matches_played: number | bigint }[];
  return rows.map((r) => ({
    playerId: r.id,
    displayName: r.display_name,
    level: displayLevel(rowNum(r.pir_rating)),
    provisional: isProvisional(rowNum(r.matches_played)),
    isHost: r.id === match.host_player_id,
    pir: rowNum(r.pir_rating),
  }));
}

const pendingCount = (db: DatabaseSync, matchId: string, exceptPlayer: string | null) =>
  rowNum(
    (db
      .prepare("SELECT COUNT(*) AS n FROM match_invitations WHERE open_match_id = ? AND status = 'pending' AND player_id <> ?")
      .get(matchId, exceptPlayer ?? '') as { n: number | bigint }).n,
  );

/** Three pairings, closest-average split recommended. Players appear by name and level, never by contact. */
function teamSplit(people: (PublicParticipant & { pir: number })[]) {
  const rec = recommendDoubles(people.map((p) => ({ id: p.playerId, displayName: p.displayName, rating: p.pir })));
  const level = new Map(people.map((p) => [p.playerId, p.level]));
  const side = (s: { id: string; displayName: string }) => ({ playerId: s.id, displayName: s.displayName, level: level.get(s.id)! });
  const pairings = rec.pairings.map((p) => ({
    teamA: p.teamA.map(side),
    teamB: p.teamB.map(side),
    strengthA: p.strengthA,
    strengthB: p.strengthB,
    gap: p.gap,
    gapLevel: Math.round((p.gap / 200) * 100) / 100,
  }));
  return {
    pairings,
    recommendedIndex: rec.recommendedIndex,
    recommended: pairings[rec.recommendedIndex],
    gap: rec.gap,
    gapLevel: pairings[rec.recommendedIndex].gapLevel,
    reason: rec.reason,
    note: 'A recommended split, not an assignment. Joining a game never changes anyone\'s rating.',
  };
}

export function presentMatch(db: DatabaseSync, cfg: PlayConfig, row: MatchRow, viewerId: string | null) {
  const people = participantsOf(db, row);
  const capacity = rowNum(row.capacity);
  const pending = pendingCount(db, row.id, null);
  const facility = db.prepare('SELECT name FROM facilities WHERE id = ?').get(row.facility_id) as { name: string } | undefined;
  const court = db.prepare('SELECT number FROM courts WHERE id = ?').get(row.court_id) as { number: number | bigint } | undefined;
  const booking = getBookingRow(db, row.booking_id);
  const hold = booking?.hold_id && booking.status === 'held'
    ? (db.prepare('SELECT expires_at FROM court_holds WHERE id = ?').get(booking.hold_id) as { expires_at: string } | undefined)
    : undefined;
  const mine = viewerId ? people.some((p) => p.playerId === viewerId) : false;
  const invitation = viewerId
    ? (db.prepare("SELECT id, status, expires_at FROM match_invitations WHERE open_match_id = ? AND player_id = ?").get(row.id, viewerId) as
        | { id: string; status: string; expires_at: string }
        | undefined)
    : undefined;
  return {
    id: row.id,
    status: row.status,
    demo: rowNum(row.demo) === 1,
    facilityId: row.facility_id,
    facilityName: facility?.name ?? row.facility_id,
    courtId: row.court_id,
    courtNumber: court ? rowNum(court.number) : null,
    start: row.start,
    end: row.end,
    format: row.format,
    capacity,
    joinedCount: people.length,
    pendingInvitations: pending,
    seatsOpen: row.status === 'open' ? Math.max(0, capacity - people.length - pending) : 0,
    pricePerPlayerVnd: rowNum(row.price_per_player_vnd),
    currency: 'VND' as const,
    payment: { method: 'pay_at_facility' as const, processed: false as const },
    levelRange: { min: row.min_level, max: row.max_level },
    hostPlayerId: row.host_player_id,
    participants: people.map(({ pir: _pir, ...rest }) => rest),
    bookingStatus: booking?.status ?? null,
    courtHeldUntil: hold?.expires_at ?? null,
    you: viewerId ? { joined: mine, isHost: row.host_player_id === viewerId, invitation: invitation ?? null } : null,
    teamSplit: people.length === 4 && row.format === 'doubles' ? teamSplit(people) : null,
    disclaimer: DISCLAIMER,
  };
}
export type PublicMatch = ReturnType<typeof presentMatch>;

const presentInvitation = (inv: InvitationRow) => ({
  id: inv.id,
  openMatchId: inv.open_match_id,
  playerId: inv.player_id,
  status: inv.status,
  createdAt: inv.created_at,
  expiresAt: inv.expires_at,
  respondedAt: inv.responded_at,
});

// ---------------------------------------------------------------- create

type SlotRowFull = {
  id: string;
  facility_id: string;
  court_id: string;
  date: string;
  start: string;
  end: string;
  price_vnd: number | bigint;
  status: string;
  updated_at: string;
};

const clampLevel = (n: number) => Math.min(8, Math.max(1, Math.round(n * 10) / 10));

export function createOpenMatch(
  db: DatabaseSync,
  cfg: PlayConfig,
  hostId: string,
  input: {
    slotId: unknown;
    format?: unknown;
    minLevel?: unknown;
    maxLevel?: unknown;
    idempotencyKey?: unknown;
    /** Court price for this game. Omitted means the slot's listed price. Smart Fill is the only caller that sets it. */
    courtPriceVnd?: number;
    /** Labels the match demo when the slot itself is demo inventory. */
    demo?: boolean;
  },
): { match: PublicMatch; replayed: boolean } {
  if (typeof input.slotId !== 'string' || !input.slotId) return fail(400, 'invalid_body');
  if (input.courtPriceVnd != null && (!Number.isInteger(input.courtPriceVnd) || input.courtPriceVnd < 0 || input.courtPriceVnd > 100_000_000)) {
    return fail(400, 'invalid_price');
  }
  const format = input.format ?? 'doubles';
  if (typeof format !== 'string' || !SUPPORTED_FORMATS.includes(format as Format)) return fail(400, 'format_not_supported_yet');
  const host = getPlayer(db, hostId);
  if (!host) return fail(401, 'player_required');
  const hostLevel = levelFromPir(rowNum(host.pir_rating));
  const minLevel = input.minLevel == null ? clampLevel(hostLevel - 0.5) : Number(input.minLevel);
  const maxLevel = input.maxLevel == null ? clampLevel(hostLevel + 0.5) : Number(input.maxLevel);
  if (!Number.isFinite(minLevel) || !Number.isFinite(maxLevel) || minLevel < 1 || maxLevel > 8 || minLevel > maxLevel) {
    return fail(400, 'invalid_level_range');
  }
  const capacity = 4;

  return guarded(db, () => {
    syncMatches(db, cfg);
    const slot = db.prepare('SELECT * FROM court_availability WHERE id = ?').get(input.slotId as string) as SlotRowFull | undefined;
    if (!slot) return fail(404, 'slot_not_found');
    let key = typeof input.idempotencyKey === 'string' ? input.idempotencyKey : null;
    if (input.idempotencyKey != null && !key) return fail(400, 'invalid_idempotency_key');
    if (!key) {
      const attempts = rowNum(
        (db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE slot_id = ? AND created_by_player = ? AND status IN ('cancelled', 'expired', 'no_show')").get(slot.id, hostId) as { n: number | bigint }).n,
      );
      key = `om-${slot.id}-${attempts}`.slice(0, 100);
    }
    const courtPrice = input.courtPriceVnd == null ? rowNum(slot.price_vnd) : input.courtPriceVnd;
    const { booking, replayed } = createBooking(db, cfg, hostId, { slotId: slot.id, idempotencyKey: key, priceVnd: courtPrice });
    const existing = db.prepare('SELECT * FROM open_matches WHERE booking_id = ?').get(booking.id) as MatchRow | undefined;
    if (existing) return { match: presentMatch(db, cfg, existing, hostId), replayed };
    if (replayed) return fail(409, 'idempotency_conflict');

    // The court stays held while players are found, longer than a plain checkout hold.
    const row = getBookingRow(db, booking.id)!;
    if (row.hold_id) {
      db.prepare("UPDATE court_holds SET expires_at = ? WHERE id = ? AND status = 'active'").run(
        iso(cfg.now() + cfg.openMatchHoldSeconds * 1000),
        row.hold_id,
      );
    }
    const price = Math.ceil(courtPrice / capacity / PRICE_STEP_VND) * PRICE_STEP_VND;
    const id = newId('om');
    const stamp = iso(cfg.now());
    db.prepare(
      `INSERT INTO open_matches (id, booking_id, slot_id, facility_id, court_id, start, end, format, capacity, price_per_player_vnd,
         min_level, max_level, host_player_id, status, demo, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
    ).run(id, booking.id, slot.id, slot.facility_id, slot.court_id, row.start, row.end, format, capacity, price, minLevel, maxLevel, hostId, input.demo ? 1 : 0, stamp, stamp);
    return { match: presentMatch(db, cfg, getMatch(db, id)!, hostId), replayed: false };
  });
}

// ------------------------------------------------------------ join / seats

/** Adds the player to the booking's participants and confirms the court once every seat is taken. */
function seatPlayer(db: DatabaseSync, cfg: PlayConfig, match: MatchRow, playerId: string): void {
  const stamp = iso(cfg.now());
  db.prepare(
    `INSERT INTO booking_participants (booking_id, player_id, status) VALUES (?, ?, 'joined')
     ON CONFLICT(booking_id, player_id) DO UPDATE SET status = 'joined'`,
  ).run(match.booking_id, playerId);
  const joined = participantsOf(db, match).length;
  if (joined >= rowNum(match.capacity)) {
    const booking = getBookingRow(db, match.booking_id) as BookingRow;
    if (booking.status !== 'confirmed') {
      applyTransition(db, cfg, booking, 'confirmed', { kind: 'player', playerId: match.host_player_id });
    }
    db.prepare("UPDATE open_matches SET status = 'confirmed', updated_at = ? WHERE id = ?").run(stamp, match.id);
    db.prepare("UPDATE match_invitations SET status = 'expired', responded_at = ? WHERE open_match_id = ? AND status = 'pending'").run(stamp, match.id);
  }
}

function isJoined(db: DatabaseSync, match: MatchRow, playerId: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM booking_participants WHERE booking_id = ? AND player_id = ? AND status = 'joined'").get(match.booking_id, playerId),
  );
}

function assertCanSeat(db: DatabaseSync, match: MatchRow, player: PlayerRow): void {
  if (!levelFits(rowNum(player.pir_rating), rowNum(player.matches_played), match.min_level, match.max_level)) {
    fail(409, 'level_outside_range');
  }
  if (playerClash(db, player.id, match.start, match.end, null, null)) fail(409, 'player_overlap');
  // The player's own pending invitation is not counted: it is the seat being taken.
  const taken = participantsOf(db, match).length + pendingCount(db, match.id, player.id);
  if (taken >= rowNum(match.capacity)) fail(409, 'match_full');
}

/** A Smart Fill game stays closed until the facility has approved this player. Ordinary games are unchanged. */
function fillSeatNeedsApproval(db: DatabaseSync, match: MatchRow, playerId: string): boolean {
  if (playerId === match.host_player_id) return false;
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'fill_publications'").get();
  if (!table) return false;
  const published = db.prepare('SELECT 1 FROM fill_publications WHERE open_match_id = ?').get(match.id);
  if (!published) return false;
  const approved = db
    .prepare("SELECT 1 FROM fill_requests WHERE open_match_id = ? AND player_id = ? AND status = 'approved'")
    .get(match.id, playerId);
  return !approved;
}

export function joinOpenMatch(db: DatabaseSync, cfg: PlayConfig, playerId: string, matchId: string): { match: PublicMatch; replayed: boolean } {
  return guarded(db, () => {
    syncMatches(db, cfg);
    const match = getMatch(db, matchId);
    if (!match) return fail(404, 'not_found');
    const player = getPlayer(db, playerId);
    if (!player) return fail(401, 'player_required');
    if (isJoined(db, match, playerId)) return { match: presentMatch(db, cfg, match, playerId), replayed: true };
    if (match.status !== 'open') return fail(409, 'match_closed');
    if (match.start <= nowLocalOf(cfg)) return fail(409, 'match_closed');
    if (fillSeatNeedsApproval(db, match, playerId)) return fail(409, 'approval_required');
    assertCanSeat(db, match, player);
    // An invitation of the player's own is consumed by joining directly.
    db.prepare("UPDATE match_invitations SET status = 'accepted', responded_at = ? WHERE open_match_id = ? AND player_id = ? AND status = 'pending'").run(
      iso(cfg.now()),
      match.id,
      playerId,
    );
    seatPlayer(db, cfg, match, playerId);
    return { match: presentMatch(db, cfg, getMatch(db, matchId)!, playerId), replayed: false };
  });
}

// ---------------------------------------------------------------- invite

export function inviteToMatch(
  db: DatabaseSync,
  cfg: PlayConfig,
  hostId: string,
  matchId: string,
  inviteeId: unknown,
): { invitation: ReturnType<typeof presentInvitation>; replayed: boolean } {
  if (typeof inviteeId !== 'string' || !inviteeId) return fail(400, 'invalid_body');
  return guarded(db, () => {
    syncMatches(db, cfg);
    const match = getMatch(db, matchId);
    if (!match) return fail(404, 'not_found');
    if (match.host_player_id !== hostId) return fail(403, 'forbidden');
    if (match.status !== 'open') return fail(409, 'match_closed');
    if (inviteeId === hostId) return fail(400, 'invalid_body');
    const invitee = getPlayer(db, inviteeId);
    if (!invitee) return fail(404, 'player_not_found');
    const prior = db.prepare('SELECT * FROM match_invitations WHERE open_match_id = ? AND player_id = ?').get(match.id, inviteeId) as InvitationRow | undefined;
    if (prior && (prior.status === 'pending' || prior.status === 'accepted')) return { invitation: presentInvitation(prior), replayed: true };
    if (isJoined(db, match, inviteeId)) return fail(409, 'already_joined');

    const prefs = getPreferences(db, inviteeId);
    // One generic answer: the host learns nothing about why someone cannot be invited.
    if (!prefs.matchInviteOptIn || !prefs.availability.optedIn) return fail(409, 'player_not_available');
    if (playerClash(db, inviteeId, match.start, match.end, null, null)) return fail(409, 'player_not_available');
    if (!levelFits(rowNum(invitee.pir_rating), rowNum(invitee.matches_played), match.min_level, match.max_level)) {
      return fail(409, 'level_outside_range');
    }
    if (participantsOf(db, match).length + pendingCount(db, match.id, null) >= rowNum(match.capacity)) return fail(409, 'match_full');

    const stamp = iso(cfg.now());
    const expires = iso(cfg.now() + cfg.inviteTtlSeconds * 1000);
    let id = prior?.id;
    if (prior) {
      db.prepare("UPDATE match_invitations SET status = 'pending', created_at = ?, expires_at = ?, responded_at = NULL, invited_by = ? WHERE id = ?").run(stamp, expires, hostId, prior.id);
    } else {
      id = newId('inv');
      db.prepare(
        `INSERT INTO match_invitations (id, open_match_id, player_id, invited_by, status, created_at, expires_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(id, match.id, inviteeId, hostId, stamp, expires);
    }
    return { invitation: presentInvitation(db.prepare('SELECT * FROM match_invitations WHERE id = ?').get(id!) as InvitationRow), replayed: false };
  });
}

function loadInvitationFor(db: DatabaseSync, id: string, playerId: string): InvitationRow {
  const inv = db.prepare('SELECT * FROM match_invitations WHERE id = ?').get(id) as InvitationRow | undefined;
  if (!inv) return fail(404, 'not_found');
  if (inv.player_id !== playerId) return fail(403, 'forbidden');
  return inv;
}

export function acceptInvitation(db: DatabaseSync, cfg: PlayConfig, playerId: string, id: string) {
  return guarded(db, () => {
    syncMatches(db, cfg);
    const inv = loadInvitationFor(db, id, playerId);
    const match = getMatch(db, inv.open_match_id)!;
    if (inv.status === 'accepted') {
      return { invitation: presentInvitation(inv), match: presentMatch(db, cfg, match, playerId), replayed: true };
    }
    if (inv.status === 'declined') return fail(409, 'invalid_transition');
    if (inv.status === 'expired' || match.status !== 'open') return fail(409, 'invitation_expired');
    const player = getPlayer(db, playerId)!;
    assertCanSeat(db, match, player);
    db.prepare("UPDATE match_invitations SET status = 'accepted', responded_at = ? WHERE id = ?").run(iso(cfg.now()), id);
    seatPlayer(db, cfg, match, playerId);
    return {
      invitation: presentInvitation(db.prepare('SELECT * FROM match_invitations WHERE id = ?').get(id) as InvitationRow),
      match: presentMatch(db, cfg, getMatch(db, match.id)!, playerId),
      replayed: false,
    };
  });
}

export function declineInvitation(db: DatabaseSync, cfg: PlayConfig, playerId: string, id: string) {
  return guarded(db, () => {
    syncMatches(db, cfg);
    const inv = loadInvitationFor(db, id, playerId);
    const match = getMatch(db, inv.open_match_id)!;
    if (inv.status === 'declined') return { invitation: presentInvitation(inv), match: presentMatch(db, cfg, match, playerId), replayed: true };
    if (inv.status !== 'pending') return fail(409, 'invalid_transition');
    db.prepare("UPDATE match_invitations SET status = 'declined', responded_at = ? WHERE id = ?").run(iso(cfg.now()), id);
    return {
      invitation: presentInvitation(db.prepare('SELECT * FROM match_invitations WHERE id = ?').get(id) as InvitationRow),
      match: presentMatch(db, cfg, getMatch(db, match.id)!, playerId),
      replayed: false,
    };
  });
}

// --------------------------------------------------------------- my games

export function myGames(db: DatabaseSync, cfg: PlayConfig, playerId: string) {
  syncMatches(db, cfg);
  const rows = db
    .prepare(
      `SELECT DISTINCT m.* FROM open_matches m
       LEFT JOIN booking_participants p ON p.booking_id = m.booking_id AND p.player_id = ? AND p.status = 'joined'
       WHERE m.host_player_id = ? OR p.player_id IS NOT NULL ORDER BY m.start DESC, m.id LIMIT 50`,
    )
    .all(playerId, playerId) as MatchRow[];
  const pending = db
    .prepare("SELECT * FROM match_invitations WHERE player_id = ? AND status = 'pending' ORDER BY created_at, id")
    .all(playerId) as InvitationRow[];
  return {
    games: rows.map((row) => presentMatch(db, cfg, row, playerId)),
    invitations: pending.map((inv) => ({ ...presentInvitation(inv), match: presentMatch(db, cfg, getMatch(db, inv.open_match_id)!, playerId) })),
  };
}

export function listMatchesForFacility(db: DatabaseSync, cfg: PlayConfig, facilityId: string | undefined) {
  syncMatches(db, cfg);
  const rows = (facilityId
    ? db.prepare('SELECT * FROM open_matches WHERE facility_id = ? ORDER BY start DESC, id LIMIT 200').all(facilityId)
    : db.prepare('SELECT * FROM open_matches ORDER BY start DESC, id LIMIT 200').all()) as MatchRow[];
  return rows.map((row) => presentMatch(db, cfg, row, null));
}

// ----------------------------------------------------------------- search

export type SearchInput = {
  format?: unknown;
  start?: unknown;
  radiusKm?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  candidateLimit?: unknown;
};

function locationOf(db: DatabaseSync, player: PlayerRow, input: SearchInput): LatLng {
  if (input.latitude != null || input.longitude != null) {
    const latitude = Number(input.latitude);
    const longitude = Number(input.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      return fail(400, 'invalid_location');
    }
    return { latitude, longitude };
  }
  if (player.latitude != null && player.longitude != null) return { latitude: player.latitude, longitude: player.longitude };
  const home = player.home_facility_id
    ? (db.prepare('SELECT latitude, longitude FROM facilities WHERE id = ?').get(player.home_facility_id) as LatLng | undefined)
    : undefined;
  return home ?? fail(400, 'location_required');
}

type MatchJoinRow = MatchRow & {
  flat: number;
  flng: number;
  fname: string;
  court_number: number | bigint;
  booking_status: string;
  slot_status: string | null;
  slot_booking_id: string | null;
  slot_updated_at: string | null;
};

export function searchPlayNow(db: DatabaseSync, cfg: PlayConfig, playerId: string, input: SearchInput) {
  const player = getPlayer(db, playerId);
  if (!player) return fail(401, 'player_required');
  const prefs = getPreferences(db, playerId);
  const format = input.format === undefined ? prefs.format : input.format;
  if (typeof format !== 'string' || !SUPPORTED_FORMATS.includes(format as Format)) return fail(400, 'format_not_supported_yet');
  const radiusKm = input.radiusKm === undefined ? prefs.radiusKm : Number(input.radiusKm);
  if (!Number.isFinite(radiusKm) || radiusKm < 0.5 || radiusKm > 50) return fail(400, 'invalid_radius');
  const start = input.start === undefined ? prefs.start : parseStart(input.start);
  if (!start) return fail(400, 'invalid_start');
  const location = locationOf(db, player, input);
  const limit = input.candidateLimit === undefined ? MAX_CANDIDATES : Number(input.candidateLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) return fail(400, 'invalid_candidate_limit');

  syncMatches(db, cfg);
  const ctx: SearchContext = { nowLocal: nowLocalOf(cfg), radiusKm, format: format as Format, start };
  const pir = rowNum(player.pir_rating);
  const matchesPlayed = rowNum(player.matches_played);
  const seeker = { id: playerId, pir, matchesPlayed, location };
  const verified = (updatedAt: string | null) => updatedAt != null && cfg.now() - Date.parse(updatedAt) <= cfg.staleMinutes * 60_000;
  const filteredOut: Record<string, number> = {};
  const bump = (reason: string, by = 1) => (filteredOut[reason] = (filteredOut[reason] ?? 0) + by);

  // ---- join_existing
  const matchRows = db
    .prepare(
      `SELECT m.*, f.latitude AS flat, f.longitude AS flng, f.name AS fname, c.number AS court_number, b.status AS booking_status,
              a.status AS slot_status, a.booking_id AS slot_booking_id, a.updated_at AS slot_updated_at
       FROM open_matches m JOIN facilities f ON f.id = m.facility_id JOIN courts c ON c.id = m.court_id
       JOIN bookings b ON b.id = m.booking_id LEFT JOIN court_availability a ON a.id = m.slot_id
       WHERE m.status = 'open' ORDER BY m.start, m.id`,
    )
    .all() as MatchJoinRow[];
  const hostRel = reliabilityOf(db, [...new Set(matchRows.map((m) => m.host_player_id))]);
  const byId = new Map<string, MatchJoinRow>();
  const candidatesForMatch: (Target & { busy: boolean; hostReliability: Reliability })[] = [];
  for (const m of matchRows) {
    if (isJoined(db, m, playerId)) {
      bump('already_joined');
      continue;
    }
    byId.set(m.id, m);
    const courtHeld = (m.booking_status === 'held' || m.booking_status === 'pending') && (m.slot_id == null || (m.slot_status === 'held' && m.slot_booking_id === m.booking_id));
    candidatesForMatch.push({
      id: m.id,
      start: m.start,
      end: m.end,
      location: { latitude: m.flat, longitude: m.flng },
      slotAvailable: courtHeld,
      verified: verified(m.slot_updated_at),
      format: m.format,
      openSeats: Math.max(0, rowNum(m.capacity) - participantsOf(db, m).length - pendingCount(db, m.id, playerId)),
      minLevel: m.min_level,
      maxLevel: m.max_level,
      busy: playerClash(db, playerId, m.start, m.end, null, null),
      hostReliability: hostRel.get(m.host_player_id) ?? null,
    });
  }
  const matchOutcome = rankMatches(seeker, candidatesForMatch, ctx);
  for (const [reason, n] of Object.entries(matchOutcome.excluded)) bump(reason, n);
  const joinExisting = matchOutcome.ranked.map(({ item, result }) => ({
    match: presentMatch(db, cfg, byId.get(item.id)!, playerId),
    distanceKm: result.distanceKm,
    score: result.score,
    factors: result.factors,
    warnings: result.warnings,
    explanation: result.explanation,
  }));

  // ---- build_my_game
  const hostLevel = levelFromPir(pir);
  const range = { minLevel: clampLevel(hostLevel - 0.5), maxLevel: clampLevel(hostLevel + 0.5) };
  const slotRows = db
    .prepare(
      `SELECT a.*, c.number AS court_number, f.latitude AS flat, f.longitude AS flng, f.name AS fname
       FROM court_availability a JOIN courts c ON c.id = a.court_id JOIN facilities f ON f.id = a.facility_id
       WHERE a.status = 'available' AND (a.date || 'T' || a.start) > ? ORDER BY a.date, a.start, a.id`,
    )
    .all(ctx.nowLocal) as (SlotRowFull & { court_number: number | bigint; flat: number; flng: number; fname: string })[];
  const slotTargets: { row: (typeof slotRows)[number]; target: Target; fit: number; distanceKm: number }[] = [];
  for (const row of slotRows) {
    const target: Target = {
      id: row.id,
      start: `${row.date}T${row.start}`,
      end: `${row.date}T${row.end}`,
      location: { latitude: row.flat, longitude: row.flng },
      slotAvailable: row.status === 'available',
      verified: verified(row.updated_at),
      format: ctx.format,
      openSeats: 3,
      ...range,
    };
    const fit = slotFit(target, seeker, ctx);
    if ('excluded' in fit) {
      bump(fit.excluded);
      continue;
    }
    if (playerClash(db, playerId, target.start, target.end, null, null)) {
      bump('busy');
      continue;
    }
    slotTargets.push({ row, target, fit: fit.fit, distanceKm: fit.distanceKm });
  }
  slotTargets.sort((a, b) => b.fit - a.fit || (a.target.id < b.target.id ? -1 : 1));
  const top = slotTargets.slice(0, MAX_SLOTS);

  const pool = db
    .prepare(
      `SELECT pl.id, pl.pir_rating, pl.matches_played, COALESCE(pl.latitude, hf.latitude) AS lat, COALESCE(pl.longitude, hf.longitude) AS lng
       FROM players pl JOIN player_preferences pp ON pp.player_id = pl.id LEFT JOIN facilities hf ON hf.id = pl.home_facility_id
       WHERE pl.id <> ? AND pl.guest = 0 AND pp.match_invite_opt_in = 1 ORDER BY pl.id`,
    )
    .all(playerId) as { id: string; pir_rating: number | bigint; matches_played: number | bigint; lat: number | null; lng: number | null }[];
  const poolRel = reliabilityOf(db, pool.map((p) => p.id));
  const poolNames = new Map(
    (db.prepare('SELECT id, display_name FROM players').all() as { id: string; display_name: string }[]).map((r) => [r.id, r.display_name]),
  );
  const buildMyGame = top.map(({ row, target, fit, distanceKm }) => {
    const candidates: Candidate[] = pool.map((p) => {
      const pr = getPreferences(db, p.id);
      return {
        id: p.id,
        pir: rowNum(p.pir_rating),
        matchesPlayed: rowNum(p.matches_played),
        location: p.lat != null && p.lng != null ? { latitude: p.lat, longitude: p.lng } : null,
        matchInviteOptIn: pr.matchInviteOptIn,
        availabilityOptedIn: pr.availability.optedIn,
        radiusKm: pr.radiusKm,
        format: pr.format,
        windows: pr.availability.windows,
        busy: playerClash(db, p.id, target.start, target.end, null, null),
        reliability: poolRel.get(p.id) ?? null,
      };
    });
    const outcome = rankCandidates(candidates, target, ctx);
    return {
      slot: {
        id: row.id,
        facilityId: row.facility_id,
        facilityName: row.fname,
        courtId: row.court_id,
        courtNumber: rowNum(row.court_number),
        start: target.start,
        end: target.end,
        priceVnd: rowNum(row.price_vnd),
        currency: 'VND' as const,
        availabilityVerified: target.verified,
      },
      distanceKm,
      fitScore: fit,
      warnings: target.verified ? [] : ['Availability not verified recently. Check with the facility before travelling.'],
      suggestedMatch: {
        format: ctx.format,
        capacity: 4,
        seatsToFill: 3,
        pricePerPlayerVnd: Math.ceil(rowNum(row.price_vnd) / 4 / PRICE_STEP_VND) * PRICE_STEP_VND,
        levelRange: { min: range.minLevel, max: range.maxLevel },
      },
      candidates: outcome.ranked.slice(0, limit).map(({ item, result }) => {
        const c = pool.find((p) => p.id === item.id)!;
        return {
          playerId: item.id,
          displayName: poolNames.get(item.id) ?? item.id,
          level: displayLevel(rowNum(c.pir_rating)),
          provisional: isProvisional(rowNum(c.matches_played)),
          distanceKm: result.distanceKm,
          score: result.score,
          factors: result.factors,
          warnings: result.warnings,
          explanation: result.explanation,
        };
      }),
      candidatesConsidered: candidates.length,
    };
  });

  // ---- join_queue: real queue lengths and shorter-queue alternatives (Smart Queue). Wait stays 'not_available_yet' without data.
  sweepQueue(db, cfg);
  const facilities = db.prepare('SELECT id, name, latitude, longitude FROM facilities ORDER BY id').all() as {
    id: string;
    name: string;
    latitude: number;
    longitude: number;
  }[];
  const joinQueue = facilities
    .map((f) => ({ f, km: haversineKm(location, f) }))
    .filter(({ km }) => km <= radiusKm + 1e-9)
    .sort((a, b) => a.km - b.km || (a.f.id < b.f.id ? -1 : 1))
    .map(({ f, km }) => ({
      facilityId: f.id,
      facilityName: f.name,
      distanceKm: Math.round(km * 100) / 100,
      ...queueFacts(db, cfg, f.id, radiusKm),
      queueManagedCourts: rowNum(
        (db.prepare("SELECT COUNT(DISTINCT court_id) AS n FROM court_availability WHERE facility_id = ? AND status = 'queue_managed'").get(f.id) as { n: number | bigint }).n,
      ),
    }));

  return {
    query: { playerId, format, radiusKm, start, location, nowLocal: ctx.nowLocal },
    categories: { join_existing: joinExisting, build_my_game: buildMyGame, join_queue: joinQueue },
    filteredOut,
    disclaimer: DISCLAIMER,
  };
}

function queueFacts(db: DatabaseSync, cfg: PlayConfig, facilityId: string, radiusKm: number) {
  const q = queueSummary(db, cfg, facilityId, radiusKm);
  return { activeQueueLength: q.waitingPlayers, estimate: q.estimate, alternatives: q.alternatives };
}

// ------------------------------------------------------------------ demo

const DEMO_MATCHES = [
  { key: 'bt', day: 1, hour: 18, court: 'demo-binh-thanh-court-1', host: 'demo-nam', others: ['demo-thao', 'demo-an'], min: 3.0, max: 3.5 },
  { key: 'main', day: 1, hour: 19, court: 'court-1', host: 'demo-trang', others: ['demo-vy'], min: 3.0, max: 3.5 },
  { key: 'q7', day: 2, hour: 18, court: 'demo-quan-7-court-1', host: 'demo-duc', others: ['demo-phuong'], min: 3.5, max: 4.5 },
] as const;

/**
 * Idempotent. Everything is flagged demo = 1. Matches use deterministic ids, existing demo slots and existing demo
 * players; a match is created once and never rewritten. Demo players are opted in to Play Now invitations.
 */
export function seedDemoOpenMatches(db: DatabaseSync, cfg: PlayConfig): number {
  const stamp = iso(cfg.now());
  return guarded(db, () => {
    db.prepare(
      `INSERT OR IGNORE INTO player_preferences (player_id, radius_km, format, start_pref, notifications_opt_in, match_invite_opt_in, updated_at)
       SELECT id, 5, 'doubles', 'asap', 1, 1, ? FROM players WHERE demo = 1`,
    ).run(stamp);
    db.prepare("INSERT OR IGNORE INTO player_availability (player_id, opted_in, windows_json, updated_at) SELECT id, 1, '[]', ? FROM players WHERE demo = 1").run(stamp);

    let added = 0;
    for (const demo of DEMO_MATCHES) {
      const date = venueLocal(cfg.now() + demo.day * 86_400_000).slice(0, 10);
      const start = `${String(demo.hour).padStart(2, '0')}:00`;
      const id = `demo-om-${demo.key}-${date}`;
      if (db.prepare('SELECT 1 FROM open_matches WHERE id = ?').get(id)) continue;
      const slot = db.prepare('SELECT * FROM court_availability WHERE court_id = ? AND date = ? AND start = ?').get(demo.court, date, start) as SlotRowFull | undefined;
      if (!slot || slot.status !== 'available' || !slot.id.startsWith('demo-slot-')) continue;
      const people = [demo.host, ...demo.others];
      const found = db.prepare(`SELECT id FROM players WHERE demo = 1 AND id IN (${people.map(() => '?').join(',')})`).all(...people) as { id: string }[];
      if (found.length !== people.length) continue;
      if (people.some((p) => playerClash(db, p, `${date}T${start}`, `${date}T${slot.end}`, null, null))) continue;
      const bookingId = `demo-bk-${demo.key}-${date}`;
      db.prepare(
        `INSERT INTO bookings (id, facility_id, court_id, slot_id, hold_id, start, end, status, price_vnd, created_by_player, origin, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, 'held', ?, ?, 'playback', ?, ?)`,
      ).run(bookingId, slot.facility_id, slot.court_id, slot.id, `${date}T${start}`, `${date}T${slot.end}`, rowNum(slot.price_vnd), demo.host, stamp, stamp);
      recordAttribution(db, {
        bookingId,
        facilityId: slot.facility_id,
        origin: 'playback',
        amountVnd: rowNum(slot.price_vnd),
        incremental: false,
        demo: true,
        at: stamp,
      });
      for (const p of people) db.prepare("INSERT INTO booking_participants (booking_id, player_id, status) VALUES (?, ?, 'joined')").run(bookingId, p);
      db.prepare('INSERT INTO booking_status_log (booking_id, from_status, to_status, at, actor) VALUES (?, NULL, ?, ?, ?)').run(bookingId, 'held', stamp, 'system');
      db.prepare("UPDATE court_availability SET status = 'held', booking_id = ?, updated_at = ? WHERE id = ?").run(bookingId, stamp, slot.id);
      const price = Math.ceil(rowNum(slot.price_vnd) / 4 / PRICE_STEP_VND) * PRICE_STEP_VND;
      db.prepare(
        `INSERT INTO open_matches (id, booking_id, slot_id, facility_id, court_id, start, end, format, capacity, price_per_player_vnd,
           min_level, max_level, host_player_id, status, demo, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'doubles', 4, ?, ?, ?, ?, 'open', 1, ?, ?)`,
      ).run(id, bookingId, slot.id, slot.facility_id, slot.court_id, `${date}T${start}`, `${date}T${slot.end}`, price, demo.min, demo.max, demo.host, stamp, stamp);
      added += 1;
    }
    return added;
  });
}
