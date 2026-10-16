import type { DatabaseSync } from 'node:sqlite';
import { haversineKm } from '../geo.js';
import { applyTransition, getBookingRow, guarded, playerClash } from './bookings.js';
import { recordAttribution } from './fillSchema.js';
import { displayLevel, levelFromPir } from './matching.js';
import {
  DEFAULT_MAX_BYPASS,
  DEFAULT_MIN_SKILL_GAIN,
  DEFAULT_MODE,
  DEFAULT_SKILL_BAND,
  QUEUE_MODES,
  selectGroup,
  type PolicyEntry,
  type PolicySettings,
  type QueueMode,
  type Selection,
} from './queuePolicy.js';
import {
  ENTRY_SOURCES,
  type EntrySource,
  type EntryStatus,
  type OfferStatus,
} from './queueSchema.js';
import { cleanKey, fail, iso, newId, rowNum, venueLocal, type PlayConfig } from './util.js';

export { selectGroup } from './queuePolicy.js';

const ACTIVE_SQL = "('waiting', 'offered', 'confirmed')";
/** Real wait data needed before any estimate is shown. */
export const MIN_ESTIMATE_SAMPLES = 5;
const ESTIMATE_WINDOW = 20;
const FORMAT_SEATS = { doubles: 4, singles: 2 } as const;
type Format = keyof typeof FORMAT_SEATS;

// ------------------------------------------------------------------ rows

type EntryRow = {
  id: string;
  player_id: string;
  facility_id: string;
  court_id: string | null;
  joined_at: string;
  rating_snapshot: number | bigint;
  party_size: number | bigint;
  format: Format;
  status: EntryStatus;
  assigned_court_id: string | null;
  booking_id: string | null;
  offer_id: string | null;
  source: EntrySource;
  idempotency_key: string | null;
  bypassed_count: number | bigint;
  added_by: string | null;
  demo: number | bigint;
  updated_at: string;
};

type OfferRow = {
  id: string;
  facility_id: string;
  court_id: string;
  slot_id: string;
  entry_ids: string;
  offered_at: string;
  expires_at: string;
  status: OfferStatus;
  mode: string;
  reason: string;
  slot_prev_status: string;
  booking_id: string | null;
  resolved_at: string | null;
};

type SlotRow = {
  id: string;
  facility_id: string;
  court_id: string;
  date: string;
  start: string;
  end: string;
  price_vnd: number | bigint;
  status: string;
  booking_id: string | null;
  demo: number | bigint;
};

export type Actor = { kind: 'player'; playerId: string } | { kind: 'admin' } | { kind: 'system' };
const actorLabel = (a: Actor) => (a.kind === 'player' ? `player:${a.playerId}` : a.kind);

const getEntry = (db: DatabaseSync, id: string) => db.prepare('SELECT * FROM queue_entries WHERE id = ?').get(id) as EntryRow | undefined;
const getOffer = (db: DatabaseSync, id: string) => db.prepare('SELECT * FROM queue_offers WHERE id = ?').get(id) as OfferRow | undefined;
const getSlotRow = (db: DatabaseSync, id: string) => db.prepare('SELECT * FROM court_availability WHERE id = ?').get(id) as SlotRow | undefined;
const offerEntryIds = (offer: OfferRow) => JSON.parse(offer.entry_ids) as string[];
const facilityExists = (db: DatabaseSync, id: string) => Boolean(db.prepare('SELECT 1 FROM facilities WHERE id = ?').get(id));

// ----------------------------------------------------------------- audit

function audit(
  db: DatabaseSync,
  cfg: PlayConfig,
  facilityId: string,
  entryId: string | null,
  event: string,
  from: string | null,
  to: string | null,
  actor: Actor,
  detail?: Record<string, unknown>,
): void {
  db.prepare(
    'INSERT INTO queue_audit (facility_id, entry_id, event, from_status, to_status, actor, at, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(facilityId, entryId, event, from, to, actorLabel(actor), iso(cfg.now()), detail ? JSON.stringify(detail) : null);
}

type EntryPatch = Partial<{ offer_id: string | null; assigned_court_id: string | null; booking_id: string | null; bypassed_count: number }>;

/** The single place an entry changes status. Every change is audited. */
function setEntry(
  db: DatabaseSync,
  cfg: PlayConfig,
  entry: EntryRow,
  to: EntryStatus,
  actor: Actor,
  event: string,
  patch: EntryPatch = {},
  detail?: Record<string, unknown>,
): void {
  const sets = ['status = ?', 'updated_at = ?'];
  const values: (string | number | null)[] = [to, iso(cfg.now())];
  for (const [column, value] of Object.entries(patch)) {
    sets.push(`${column} = ?`);
    values.push(value as string | number | null);
  }
  db.prepare(`UPDATE queue_entries SET ${sets.join(', ')} WHERE id = ?`).run(...values, entry.id);
  audit(db, cfg, entry.facility_id, entry.id, event, entry.status, to, actor, detail);
}

// -------------------------------------------------------------- settings

export type QueueSettings = {
  facilityId: string;
  mode: QueueMode;
  acceptanceWindowSeconds: number;
  skillBand: number;
  maxBypass: number;
  minSkillGain: number;
  updatedAt: string | null;
};

export function getSettings(db: DatabaseSync, facilityId: string): QueueSettings {
  const row = db.prepare('SELECT * FROM queue_settings WHERE facility_id = ?').get(facilityId) as
    | {
        mode: QueueMode;
        acceptance_window_seconds: number | bigint;
        skill_band: number;
        max_bypass: number | bigint;
        min_skill_gain: number;
        updated_at: string;
      }
    | undefined;
  return {
    facilityId,
    mode: row?.mode ?? DEFAULT_MODE,
    acceptanceWindowSeconds: row ? rowNum(row.acceptance_window_seconds) : 120,
    skillBand: row?.skill_band ?? DEFAULT_SKILL_BAND,
    maxBypass: row ? rowNum(row.max_bypass) : DEFAULT_MAX_BYPASS,
    minSkillGain: row?.min_skill_gain ?? DEFAULT_MIN_SKILL_GAIN,
    updatedAt: row?.updated_at ?? null,
  };
}

const policyOf = (s: QueueSettings): PolicySettings => ({ mode: s.mode, skillBand: s.skillBand, maxBypass: s.maxBypass, minSkillGain: s.minSkillGain });

function num(value: unknown, min: number, max: number, integer: boolean): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) return fail(400, 'invalid_settings');
  return n;
}

export function putSettings(db: DatabaseSync, cfg: PlayConfig, facilityId: unknown, input: Record<string, unknown>): QueueSettings {
  if (typeof facilityId !== 'string' || !facilityExists(db, facilityId)) return fail(404, 'facility_not_found');
  return guarded(db, () => {
    const current = getSettings(db, facilityId);
    const mode = input.mode === undefined ? current.mode : input.mode;
    if (typeof mode !== 'string' || !(QUEUE_MODES as readonly string[]).includes(mode)) return fail(400, 'invalid_settings');
    const next = {
      mode: mode as QueueMode,
      acceptanceWindowSeconds: input.acceptanceWindowSeconds === undefined ? current.acceptanceWindowSeconds : num(input.acceptanceWindowSeconds, 15, 900, true),
      skillBand: input.skillBand === undefined ? current.skillBand : num(input.skillBand, 0.1, 3, false),
      maxBypass: input.maxBypass === undefined ? current.maxBypass : num(input.maxBypass, 0, 12, true),
      minSkillGain: input.minSkillGain === undefined ? current.minSkillGain : num(input.minSkillGain, 0, 3, false),
    };
    db.prepare(
      `INSERT INTO queue_settings (facility_id, mode, acceptance_window_seconds, skill_band, max_bypass, min_skill_gain, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(facility_id) DO UPDATE SET mode = excluded.mode, acceptance_window_seconds = excluded.acceptance_window_seconds,
         skill_band = excluded.skill_band, max_bypass = excluded.max_bypass, min_skill_gain = excluded.min_skill_gain, updated_at = excluded.updated_at`,
    ).run(facilityId, next.mode, next.acceptanceWindowSeconds, next.skillBand, next.maxBypass, next.minSkillGain, iso(cfg.now()));
    audit(db, cfg, facilityId, null, 'settings_changed', null, null, { kind: 'admin' }, { before: current, after: next });
    return getSettings(db, facilityId);
  });
}

const MODE_TEXT: Record<QueueMode, string> = {
  fifo: 'First come, first served: courts are offered strictly in join order.',
  skill: 'Closest ratings first: four players with similar ratings are grouped, whatever the join order.',
  hybrid:
    'Join order first. A group may skip ahead a little only when it gives a clearly better rating match, and nobody waits behind more than a few later arrivals.',
};

export const describeMode = (s: QueueSettings) => ({
  mode: s.mode,
  description: MODE_TEXT[s.mode],
  skillBandLevels: s.skillBand,
  ...(s.mode === 'hybrid' ? { maxLaterArrivalsAhead: s.maxBypass, minSkillGainLevels: s.minSkillGain } : {}),
});

// ----------------------------------------------------------- slot helpers

const slotStartLocal = (s: SlotRow) => `${s.date}T${s.start}`;
const slotEndLocal = (s: SlotRow) => `${s.date}T${s.end}`;

/** True when the slot is running now or starts within the lookahead window. */
function slotInWindow(cfg: PlayConfig, s: SlotRow): boolean {
  return slotEndLocal(s) > venueLocal(cfg.now()) && slotStartLocal(s) <= venueLocal(cfg.now() + cfg.queueLookaheadMinutes * 60_000);
}

function restoreSlot(db: DatabaseSync, cfg: PlayConfig, offer: OfferRow): void {
  if (offer.slot_prev_status === 'queue_managed') return;
  db.prepare("UPDATE court_availability SET status = ?, updated_at = ? WHERE id = ? AND status = 'queue_managed' AND booking_id IS NULL").run(
    offer.slot_prev_status,
    iso(cfg.now()),
    offer.slot_id,
  );
}

// ------------------------------------------------------------ offer logic

const SELECT_WAITING = "SELECT * FROM queue_entries WHERE facility_id = ? AND status = 'waiting' ORDER BY joined_at, rowid";

/**
 * Creates an offer on a free slot for the group the policy picks, or returns null when nobody can be offered.
 * The slot becomes `queue_managed` so nobody else can hold or book it while the group decides.
 */
export function offerSlot(db: DatabaseSync, cfg: PlayConfig, slotId: string, actor: Actor): OfferRow | null {
  return guarded(db, () => {
    const slot = getSlotRow(db, slotId);
    if (!slot || (slot.status !== 'available' && slot.status !== 'queue_managed') || slot.booking_id) return null;
    if (db.prepare("SELECT 1 FROM queue_offers WHERE slot_id = ? AND status = 'pending'").get(slotId)) return null;
    const waiting = (db.prepare(SELECT_WAITING).all(slot.facility_id) as EntryRow[]).filter(
      (e) => !playerClash(db, e.player_id, slotStartLocal(slot), slotEndLocal(slot), null, null),
    );
    if (waiting.length === 0) return null;
    const settings = getSettings(db, slot.facility_id);
    const formats: Format[] = [...new Set(waiting.map((e) => e.format))];
    let chosen: { sel: Selection; entries: EntryRow[] } | null = null;
    for (const format of formats) {
      const pool = waiting.filter((e) => e.format === format);
      const policyEntries: PolicyEntry[] = pool.map((e) => ({
        id: e.id,
        joinedAt: Date.parse(e.joined_at),
        level: levelFromPir(rowNum(e.rating_snapshot)),
        partySize: rowNum(e.party_size),
        bypassed: rowNum(e.bypassed_count),
      }));
      const sel = selectGroup(policyEntries, FORMAT_SEATS[format], policyOf(settings));
      if (sel) {
        chosen = { sel, entries: sel.entryIds.map((id) => pool.find((e) => e.id === id)!) };
        break;
      }
    }
    if (!chosen) return null;
    const { sel, entries } = chosen;

    const now = cfg.now();
    const id = newId('qo');
    db.prepare(
      `INSERT INTO queue_offers (id, facility_id, court_id, slot_id, entry_ids, offered_at, expires_at, status, mode, reason, slot_prev_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    ).run(
      id,
      slot.facility_id,
      slot.court_id,
      slot.id,
      JSON.stringify(sel.entryIds),
      iso(now),
      iso(now + settings.acceptanceWindowSeconds * 1000),
      settings.mode,
      sel.reason,
      slot.status,
    );
    db.prepare("UPDATE court_availability SET status = 'queue_managed', updated_at = ? WHERE id = ?").run(iso(now), slot.id);
    audit(db, cfg, slot.facility_id, null, 'offer_created', null, 'pending', actor, {
      offerId: id,
      courtId: slot.court_id,
      slotId: slot.id,
      entryIds: sel.entryIds,
      mode: sel.mode,
      reasonCode: sel.reasonCode,
      spreadLevels: sel.spread,
    });
    const passedBy = new Map(sel.passed.map((p) => [p.entryId, p.passedBy]));
    for (const e of waiting) {
      const n = passedBy.get(e.id);
      if (n && n > 0) {
        db.prepare('UPDATE queue_entries SET bypassed_count = bypassed_count + ?, updated_at = ? WHERE id = ?').run(n, iso(now), e.id);
        audit(db, cfg, e.facility_id, e.id, 'passed_by_later_players', e.status, e.status, actor, { offerId: id, laterPlayers: n, totalPassed: rowNum(e.bypassed_count) + n });
      }
    }
    for (const e of entries) setEntry(db, cfg, e, 'offered', actor, 'offered', { offer_id: id }, { offerId: id, courtId: slot.court_id, reason: sel.reasonCode });
    return getOffer(db, id)!;
  });
}

type Release = { kind: 'declined'; entryId: string } | { kind: 'cancelled'; entryId: string } | { kind: 'expired' };

/** Ends a pending offer: whoever caused it leaves, the rest go back to waiting with their place, the slot is freed. */
function releaseOffer(db: DatabaseSync, cfg: PlayConfig, offer: OfferRow, why: Release, actor: Actor): void {
  const status: OfferStatus = why.kind === 'expired' ? 'expired' : 'declined';
  db.prepare('UPDATE queue_offers SET status = ?, resolved_at = ? WHERE id = ?').run(status, iso(cfg.now()), offer.id);
  audit(db, cfg, offer.facility_id, null, why.kind === 'expired' ? 'offer_expired' : 'offer_declined', 'pending', status, actor, {
    offerId: offer.id,
    cause: why.kind,
  });
  for (const id of offerEntryIds(offer)) {
    const e = getEntry(db, id);
    if (!e || (e.status !== 'offered' && e.status !== 'confirmed')) continue;
    if (why.kind === 'expired' && e.status === 'offered') {
      setEntry(db, cfg, e, 'expired', actor, 'expired', {}, { offerId: offer.id, cause: 'did_not_respond_in_time' });
    } else if ((why.kind === 'declined' || why.kind === 'cancelled') && e.id === why.entryId) {
      setEntry(db, cfg, e, why.kind === 'declined' ? 'declined' : 'cancelled', actor, why.kind, {}, { offerId: offer.id });
    } else {
      setEntry(db, cfg, e, 'waiting', actor, 'returned_to_queue', { offer_id: null }, { offerId: offer.id, cause: why.kind });
    }
  }
  restoreSlot(db, cfg, offer);
  // Apply the policy again to whoever is left.
  offerSlot(db, cfg, offer.slot_id, { kind: 'system' });
}

/** Expires overdue offers and old waiting entries. Safe to call any time; runs before reads and on a timer. */
export function sweepQueue(db: DatabaseSync, cfg: PlayConfig): { offersExpired: number; entriesExpired: number } {
  const stamp = iso(cfg.now());
  const ttlCut = iso(cfg.now() - cfg.queueEntryTtlMinutes * 60_000);
  const dueOffers = db.prepare("SELECT 1 FROM queue_offers WHERE status = 'pending' AND expires_at <= ? LIMIT 1").get(stamp);
  const dueEntries = db.prepare("SELECT 1 FROM queue_entries WHERE status = 'waiting' AND demo = 0 AND joined_at <= ? LIMIT 1").get(ttlCut);
  if (!dueOffers && !dueEntries) return { offersExpired: 0, entriesExpired: 0 };
  return guarded(db, () => {
    let offersExpired = 0;
    const offers = db.prepare("SELECT * FROM queue_offers WHERE status = 'pending' AND expires_at <= ? ORDER BY expires_at, id").all(stamp) as OfferRow[];
    for (const offer of offers) {
      releaseOffer(db, cfg, offer, { kind: 'expired' }, { kind: 'system' });
      offersExpired += 1;
    }
    let entriesExpired = 0;
    const old = db.prepare("SELECT * FROM queue_entries WHERE status = 'waiting' AND demo = 0 AND joined_at <= ?").all(ttlCut) as EntryRow[];
    for (const e of old) {
      setEntry(db, cfg, e, 'expired', { kind: 'system' }, 'expired', {}, { cause: 'waited_too_long', maxMinutes: cfg.queueEntryTtlMinutes });
      entriesExpired += 1;
    }
    return { offersExpired, entriesExpired };
  });
}

/** Offers every `queue_managed` court at the facility that is idle and in the window (called after a join). */
function fillQueueManaged(db: DatabaseSync, cfg: PlayConfig, facilityId: string): void {
  const slots = db
    .prepare("SELECT * FROM court_availability WHERE facility_id = ? AND status = 'queue_managed' AND booking_id IS NULL ORDER BY date, start, court_id")
    .all(facilityId) as SlotRow[];
  for (const slot of slots) if (slotInWindow(cfg, slot)) offerSlot(db, cfg, slot.id, { kind: 'system' });
}

/** A court just became available (slot set to available, or a booking was cancelled). Offers it if it is current. */
export function onSlotFreed(db: DatabaseSync, cfg: PlayConfig, slotId: string): OfferRow | null {
  sweepQueue(db, cfg);
  const slot = getSlotRow(db, slotId);
  if (!slot || slot.status !== 'available' || !slotInWindow(cfg, slot)) return null;
  return offerSlot(db, cfg, slotId, { kind: 'system' });
}

/** Staff action: a court is ready now. Picks a slot (or uses the one given) and offers it to the next group. */
export function courtReady(
  db: DatabaseSync,
  cfg: PlayConfig,
  input: { facilityId?: unknown; courtId?: unknown; slotId?: unknown },
): { offer: PublicOffer | null; slotId: string | null; message: string } {
  sweepQueue(db, cfg);
  const { facilityId, courtId, slotId } = input;
  if (typeof facilityId !== 'string' || !facilityExists(db, facilityId)) return fail(404, 'facility_not_found');
  let slot: SlotRow | undefined;
  if (slotId != null) {
    if (typeof slotId !== 'string') return fail(400, 'invalid_body');
    slot = getSlotRow(db, slotId);
    if (!slot || slot.facility_id !== facilityId) return fail(404, 'slot_not_found');
  } else {
    if (typeof courtId !== 'string') return fail(400, 'invalid_body');
    const court = db.prepare('SELECT facility_id FROM courts WHERE id = ?').get(courtId) as { facility_id: string } | undefined;
    if (!court || court.facility_id !== facilityId) return fail(404, 'court_not_found');
    slot = db
      .prepare(
        `SELECT * FROM court_availability WHERE court_id = ? AND status IN ('available', 'queue_managed') AND booking_id IS NULL
           AND (date || 'T' || "end") > ? AND id NOT IN (SELECT slot_id FROM queue_offers WHERE status = 'pending')
         ORDER BY date, start LIMIT 1`,
      )
      .get(courtId, venueLocal(cfg.now())) as SlotRow | undefined;
    if (!slot) return fail(404, 'no_free_slot');
  }
  if (slot.status !== 'available' && slot.status !== 'queue_managed') return fail(409, 'slot_unavailable');
  if (db.prepare("SELECT 1 FROM queue_offers WHERE slot_id = ? AND status = 'pending'").get(slot.id)) return fail(409, 'offer_already_pending');
  audit(db, cfg, facilityId, null, 'court_ready', null, null, { kind: 'admin' }, { courtId: slot.court_id, slotId: slot.id });
  const offer = offerSlot(db, cfg, slot.id, { kind: 'admin' });
  if (!offer) return { offer: null, slotId: slot.id, message: 'Nobody can be offered this court yet: not enough players waiting for a full group.' };
  return { offer: presentOffer(db, cfg, offer, null), slotId: slot.id, message: 'Offer created.' };
}

// ------------------------------------------------------------------- join

export type JoinInput = {
  playerId: string;
  facilityId: unknown;
  courtId?: unknown;
  partySize?: unknown;
  format?: unknown;
  source?: unknown;
  idempotencyKey?: unknown;
  /** Staff screen: who added the player. Only the route sets this. */
  staff?: boolean;
};

export function joinQueue(db: DatabaseSync, cfg: PlayConfig, input: JoinInput): { entry: OwnEntry; replayed: boolean } {
  sweepQueue(db, cfg);
  const key = cleanKey(input.idempotencyKey);
  const { facilityId } = input;
  if (typeof facilityId !== 'string' || !facilityId) return fail(400, 'invalid_body');
  const party = input.partySize === undefined || input.partySize === null ? 1 : input.partySize;
  if (typeof party !== 'number' || !Number.isInteger(party) || party < 1 || party > 4) return fail(400, 'invalid_party_size');
  const format = input.format === undefined || input.format === null ? 'doubles' : input.format;
  if (format !== 'doubles' && format !== 'singles') return fail(400, 'invalid_format');
  if (party > FORMAT_SEATS[format]) return fail(400, 'invalid_party_size');
  let source: EntrySource = input.staff ? 'staff' : 'app';
  if (!input.staff && input.source != null) {
    if (input.source !== 'app' && input.source !== 'court_qr') return fail(400, 'invalid_source');
    source = input.source;
  }
  if (!(ENTRY_SOURCES as readonly string[]).includes(source)) return fail(400, 'invalid_source');
  const courtId = input.courtId == null ? null : input.courtId;
  if (courtId !== null && typeof courtId !== 'string') return fail(400, 'invalid_body');
  if (source === 'court_qr' && !courtId) return fail(400, 'court_required');

  return guarded(db, () => {
    if (!facilityExists(db, facilityId)) return fail(404, 'facility_not_found');
    if (courtId) {
      const court = db.prepare('SELECT facility_id FROM courts WHERE id = ?').get(courtId) as { facility_id: string } | undefined;
      if (!court || court.facility_id !== facilityId) return fail(404, 'court_not_found');
    }
    const player = db.prepare('SELECT pir_rating FROM players WHERE id = ?').get(input.playerId) as { pir_rating: number | bigint } | undefined;
    if (!player) return fail(404, 'player_not_found');

    if (key) {
      const prior = db.prepare('SELECT * FROM queue_entries WHERE player_id = ? AND idempotency_key = ?').get(input.playerId, key) as EntryRow | undefined;
      if (prior) {
        if (prior.facility_id !== facilityId) return fail(409, 'idempotency_conflict');
        return { entry: presentOwnEntry(db, cfg, prior), replayed: true };
      }
    }
    const active = db.prepare(`SELECT * FROM queue_entries WHERE player_id = ? AND status IN ${ACTIVE_SQL}`).get(input.playerId) as EntryRow | undefined;
    if (active) {
      if (active.facility_id === facilityId) return { entry: presentOwnEntry(db, cfg, active), replayed: true };
      return fail(409, 'already_in_queue');
    }

    const id = newId('qe');
    const now = iso(cfg.now());
    try {
      db.prepare(
        `INSERT INTO queue_entries (id, player_id, facility_id, court_id, joined_at, rating_snapshot, party_size, format, status, source,
           idempotency_key, added_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?)`,
      ).run(id, input.playerId, facilityId, courtId, now, rowNum(player.pir_rating), party, format, source, key, input.staff ? 'admin' : null, now);
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE')) return fail(409, 'already_in_queue');
      throw error;
    }
    audit(db, cfg, facilityId, id, 'joined', null, 'waiting', input.staff ? { kind: 'admin' } : { kind: 'player', playerId: input.playerId }, {
      source,
      courtId,
      partySize: party,
      format,
      ratingSnapshot: rowNum(player.pir_rating),
    });
    fillQueueManaged(db, cfg, facilityId);
    return { entry: presentOwnEntry(db, cfg, getEntry(db, id)!), replayed: false };
  });
}

// ----------------------------------------------------------------- cancel

export function cancelEntry(db: DatabaseSync, cfg: PlayConfig, actor: Actor, entryId: string): { entry: OwnEntry; replayed: boolean } {
  sweepQueue(db, cfg);
  return guarded(db, () => {
    const entry = getEntry(db, entryId);
    if (!entry) return fail(404, 'not_found');
    if (actor.kind === 'player' && entry.player_id !== actor.playerId) return fail(403, 'forbidden');
    if (entry.status === 'cancelled') return { entry: presentOwnEntry(db, cfg, entry), replayed: true };
    if (entry.status === 'assigned') return fail(409, 'already_assigned');
    if (entry.status !== 'waiting' && entry.status !== 'offered' && entry.status !== 'confirmed') return fail(409, 'entry_closed');
    const offer = entry.offer_id ? getOffer(db, entry.offer_id) : undefined;
    if (offer && offer.status === 'pending') {
      releaseOffer(db, cfg, offer, { kind: 'cancelled', entryId: entry.id }, actor);
    } else {
      setEntry(db, cfg, entry, 'cancelled', actor, 'cancelled', { offer_id: null });
    }
    return { entry: presentOwnEntry(db, cfg, getEntry(db, entryId)!), replayed: false };
  });
}

// ----------------------------------------------------------- accept/decline

function loadMine(db: DatabaseSync, playerId: string, offerId: string): { offer: OfferRow; entry: EntryRow } {
  const offer = getOffer(db, offerId);
  if (!offer) return fail(404, 'not_found');
  const mine = offerEntryIds(offer)
    .map((id) => getEntry(db, id))
    .find((e) => e && e.player_id === playerId);
  if (!mine) return fail(403, 'forbidden');
  return { offer, entry: mine };
}

/** Creates the one booking for an accepted group through the booking service's own transition. */
function finalizeOffer(db: DatabaseSync, cfg: PlayConfig, offer: OfferRow): string {
  const entries = offerEntryIds(offer).map((id) => getEntry(db, id)!);
  const slot = getSlotRow(db, offer.slot_id);
  if (!slot || slot.status !== 'queue_managed' || slot.booking_id) return fail(409, 'slot_unavailable');
  const start = slotStartLocal(slot);
  const end = slotEndLocal(slot);
  for (const e of entries) if (playerClash(db, e.player_id, start, end, null, null)) return fail(409, 'player_overlap');
  const lead = entries[0]!;
  const key = `queue-${offer.id}`;
  const prior = db.prepare('SELECT id FROM bookings WHERE created_by_player = ? AND idempotency_key = ?').get(lead.player_id, key) as { id: string } | undefined;
  if (prior) return prior.id;
  const bookingId = newId('bk');
  const now = iso(cfg.now());
  db.prepare(
    `INSERT INTO bookings (id, facility_id, court_id, slot_id, hold_id, start, end, status, price_vnd, created_by_player, origin, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, 'held', ?, ?, 'playback', ?, ?, ?)`,
  ).run(bookingId, slot.facility_id, slot.court_id, slot.id, start, end, rowNum(slot.price_vnd), lead.player_id, key, now, now);
  recordAttribution(db, {
    bookingId,
    facilityId: slot.facility_id,
    origin: 'playback',
    amountVnd: rowNum(slot.price_vnd),
    incremental: false,
    demo: rowNum(slot.demo) === 1,
    at: now,
  });
  for (const e of entries) {
    db.prepare("INSERT INTO booking_participants (booking_id, player_id, status) VALUES (?, ?, 'joined')").run(bookingId, e.player_id);
  }
  db.prepare('INSERT INTO booking_status_log (booking_id, from_status, to_status, at, actor) VALUES (?, NULL, ?, ?, ?)').run(bookingId, 'held', now, 'system');
  db.prepare('UPDATE court_availability SET booking_id = ?, updated_at = ? WHERE id = ?').run(bookingId, now, slot.id);
  applyTransition(db, cfg, getBookingRow(db, bookingId)!, 'confirmed', { kind: 'system' });
  return bookingId;
}

export function acceptOffer(db: DatabaseSync, cfg: PlayConfig, playerId: string, offerId: string): { offer: PublicOffer; replayed: boolean } {
  sweepQueue(db, cfg);
  return guarded(db, () => {
    const { offer, entry } = loadMine(db, playerId, offerId);
    const actor: Actor = { kind: 'player', playerId };
    if (offer.status === 'accepted' && entry.status === 'assigned') return { offer: presentOffer(db, cfg, offer, playerId), replayed: true };
    if (offer.status !== 'pending') return fail(409, offer.status === 'expired' ? 'offer_expired' : 'offer_closed');
    if (entry.status === 'confirmed') return { offer: presentOffer(db, cfg, offer, playerId), replayed: true };
    if (entry.status !== 'offered') return fail(409, 'offer_closed');
    setEntry(db, cfg, entry, 'confirmed', actor, 'accepted', {}, { offerId });
    const entries = offerEntryIds(offer).map((id) => getEntry(db, id)!);
    if (entries.every((e) => e.status === 'confirmed')) {
      const bookingId = finalizeOffer(db, cfg, offer);
      for (const e of entries) {
        setEntry(db, cfg, e, 'assigned', actor, 'assigned', { assigned_court_id: offer.court_id, booking_id: bookingId }, { offerId, bookingId, courtId: offer.court_id });
      }
      db.prepare("UPDATE queue_offers SET status = 'accepted', booking_id = ?, resolved_at = ? WHERE id = ?").run(bookingId, iso(cfg.now()), offerId);
      audit(db, cfg, offer.facility_id, null, 'offer_accepted', 'pending', 'accepted', actor, { offerId, bookingId, courtId: offer.court_id });
    }
    return { offer: presentOffer(db, cfg, getOffer(db, offerId)!, playerId), replayed: false };
  });
}

export function declineOffer(db: DatabaseSync, cfg: PlayConfig, playerId: string, offerId: string): { offer: PublicOffer; replayed: boolean } {
  sweepQueue(db, cfg);
  return guarded(db, () => {
    const { offer, entry } = loadMine(db, playerId, offerId);
    if (entry.status === 'declined') return { offer: presentOffer(db, cfg, offer, playerId), replayed: true };
    if (offer.status !== 'pending' || (entry.status !== 'offered' && entry.status !== 'confirmed')) return fail(409, offer.status === 'expired' ? 'offer_expired' : 'offer_closed');
    releaseOffer(db, cfg, offer, { kind: 'declined', entryId: entry.id }, { kind: 'player', playerId });
    return { offer: presentOffer(db, cfg, getOffer(db, offerId)!, playerId), replayed: false };
  });
}

// ------------------------------------------------------------------ views

const entryOrder = (db: DatabaseSync, entry: EntryRow): { position: number; ahead: number } => {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(party_size), 0) AS players FROM queue_entries
       WHERE facility_id = ? AND status IN ${ACTIVE_SQL}
         AND (joined_at < ? OR (joined_at = ? AND rowid < (SELECT rowid FROM queue_entries WHERE id = ?)))`,
    )
    .get(entry.facility_id, entry.joined_at, entry.joined_at, entry.id) as { n: number | bigint; players: number | bigint };
  return { position: rowNum(row.n) + 1, ahead: rowNum(row.players) };
};

const STATE_TEXT: Record<string, string> = {
  waiting: 'You are in the queue. Your place is by join time; a better rating match can move a group up only a little.',
  court_ready: 'A court is ready for your group. Accept before the time runs out.',
  waiting_for_group: 'You accepted. Waiting for the rest of your group to accept.',
  court_assigned: 'Your court is assigned.',
  declined: 'You declined the court and left the queue.',
  expired: 'Your place expired and was released.',
  cancelled: 'You left the queue.',
};

function stateOf(status: EntryStatus): string {
  if (status === 'offered') return 'court_ready';
  if (status === 'confirmed') return 'waiting_for_group';
  if (status === 'assigned') return 'court_assigned';
  return status;
}

const facilityName = (db: DatabaseSync, id: string) => (db.prepare('SELECT name FROM facilities WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? id;
const courtNumber = (db: DatabaseSync, id: string) => {
  const row = db.prepare('SELECT number FROM courts WHERE id = ?').get(id) as { number: number | bigint } | undefined;
  return row ? rowNum(row.number) : null;
};

export type PublicOffer = ReturnType<typeof presentOffer>;

function presentOffer(db: DatabaseSync, cfg: PlayConfig, offer: OfferRow, viewerId: string | null) {
  const entries = offerEntryIds(offer).map((id) => getEntry(db, id)!);
  const names = new Map(
    (db.prepare(`SELECT id, display_name FROM players WHERE id IN (${entries.map(() => '?').join(',')})`).all(...entries.map((e) => e.player_id)) as { id: string; display_name: string }[]).map((p) => [p.id, p.display_name]),
  );
  const slot = getSlotRow(db, offer.slot_id);
  const mine = viewerId ? entries.find((e) => e.player_id === viewerId) : undefined;
  const left = Math.max(0, Math.ceil((Date.parse(offer.expires_at) - cfg.now()) / 1000));
  return {
    id: offer.id,
    facilityId: offer.facility_id,
    courtId: offer.court_id,
    courtNumber: courtNumber(db, offer.court_id),
    slotId: offer.slot_id,
    start: slot ? slotStartLocal(slot) : null,
    end: slot ? slotEndLocal(slot) : null,
    status: offer.status,
    offeredAt: offer.offered_at,
    expiresAt: offer.expires_at,
    secondsLeft: offer.status === 'pending' ? left : 0,
    mode: offer.mode,
    /** Why this group was chosen, in plain words. */
    reason: offer.reason,
    bookingId: offer.status === 'accepted' ? offer.booking_id : null,
    group: entries.map((e) => ({
      displayName: names.get(e.player_id) ?? 'Player',
      level: displayLevel(rowNum(e.rating_snapshot)),
      partySize: rowNum(e.party_size),
      accepted: e.status === 'confirmed' || e.status === 'assigned',
    })),
    ...(mine ? { yourEntryId: mine.id, yourStatus: mine.status } : {}),
  };
}

export type OwnEntry = ReturnType<typeof presentOwnEntry>;

function presentOwnEntry(db: DatabaseSync, cfg: PlayConfig, entry: EntryRow) {
  const active = entry.status === 'waiting' || entry.status === 'offered' || entry.status === 'confirmed';
  const state = stateOf(entry.status);
  const offer = entry.offer_id ? getOffer(db, entry.offer_id) : undefined;
  const order = active ? entryOrder(db, entry) : null;
  return {
    id: entry.id,
    facilityId: entry.facility_id,
    facilityName: facilityName(db, entry.facility_id),
    courtId: entry.court_id,
    source: entry.source,
    status: entry.status,
    /** What the app should show: waiting, court_ready, waiting_for_group, court_assigned, or a closed state. */
    state,
    message: STATE_TEXT[state] ?? '',
    courtReady: entry.status === 'offered' || entry.status === 'confirmed',
    partySize: rowNum(entry.party_size),
    format: entry.format,
    level: displayLevel(rowNum(entry.rating_snapshot)),
    joinedAt: entry.joined_at,
    position: order?.position ?? null,
    playersAhead: order?.ahead ?? null,
    positionNote: active
      ? 'Position is by join time. Under the hybrid rule a group can move up a little for a better match, but nobody waits behind more than a few later arrivals.'
      : null,
    assignedCourtId: entry.assigned_court_id,
    bookingId: entry.booking_id,
    offer: offer && (offer.status === 'pending' || entry.status === 'assigned') ? presentOffer(db, cfg, offer, entry.player_id) : null,
  };
}

export function myQueue(db: DatabaseSync, cfg: PlayConfig, playerId: string) {
  sweepQueue(db, cfg);
  const entry =
    (db.prepare(`SELECT * FROM queue_entries WHERE player_id = ? AND status IN ${ACTIVE_SQL}`).get(playerId) as EntryRow | undefined) ??
    (db.prepare('SELECT * FROM queue_entries WHERE player_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1').get(playerId) as EntryRow | undefined);
  return { entry: entry ? presentOwnEntry(db, cfg, entry) : null };
}

/**
 * Typical wait, shown only after MIN_ESTIMATE_SAMPLES real (non-demo) assignments at the facility.
 * It is a range of recent waits, never a promise, and never a single exact number.
 */
export function waitEstimate(db: DatabaseSync, facilityId: string) {
  const rows = db
    .prepare(
      `SELECT joined_at, updated_at FROM queue_entries WHERE facility_id = ? AND status = 'assigned' AND demo = 0
       ORDER BY updated_at DESC, rowid DESC LIMIT ${ESTIMATE_WINDOW}`,
    )
    .all(facilityId) as { joined_at: string; updated_at: string }[];
  if (rows.length < MIN_ESTIMATE_SAMPLES) {
    return {
      status: 'not_available_yet' as const,
      waitMinutes: null,
      note: 'Not enough completed waits here yet to estimate. We will not guess.',
    };
  }
  const waits = rows.map((r) => Math.max(0, (Date.parse(r.updated_at) - Date.parse(r.joined_at)) / 60_000)).sort((a, b) => a - b);
  const at = (q: number) => waits[Math.min(waits.length - 1, Math.floor(q * (waits.length - 1) + 0.5))]!;
  const low = Math.floor(at(0.25));
  const high = Math.max(low + 1, Math.ceil(at(0.75)));
  return {
    status: 'estimated' as const,
    waitMinutes: null,
    typicalMinutes: { low, high },
    sampleSize: rows.length,
    note: `Recent groups waited roughly ${low} to ${high} minutes. This is a typical range from ${rows.length} recent waits, not a promise.`,
  };
}

const waitingPlayers = (db: DatabaseSync, facilityId: string) =>
  rowNum(
    (db.prepare(`SELECT COALESCE(SUM(party_size), 0) AS n FROM queue_entries WHERE facility_id = ? AND status IN ${ACTIVE_SQL}`).get(facilityId) as { n: number | bigint }).n,
  );

function freeCourts(db: DatabaseSync, cfg: PlayConfig, facilityId: string): number {
  const slots = db
    .prepare("SELECT * FROM court_availability WHERE facility_id = ? AND status IN ('available', 'queue_managed') AND booking_id IS NULL")
    .all(facilityId) as SlotRow[];
  return new Set(slots.filter((s) => slotInWindow(cfg, s)).map((s) => s.court_id)).size;
}

/** Queue length, estimate and nearby facilities with shorter queues. Used by the status route and Play Now search. */
export function queueSummary(db: DatabaseSync, cfg: PlayConfig, facilityId: string, radiusKm = 10) {
  const here = db.prepare('SELECT id, name, latitude, longitude FROM facilities WHERE id = ?').get(facilityId) as
    | { id: string; name: string; latitude: number; longitude: number }
    | undefined;
  if (!here) return fail(404, 'facility_not_found');
  const players = waitingPlayers(db, facilityId);
  const others = db.prepare('SELECT id, name, latitude, longitude FROM facilities WHERE id <> ? ORDER BY id').all(facilityId) as typeof here[];
  const alternatives = others
    .map((f) => ({ f, km: haversineKm(here, f), waiting: waitingPlayers(db, f.id) }))
    .filter(({ km, waiting }) => km <= radiusKm + 1e-9 && waiting < players)
    .sort((a, b) => a.waiting - b.waiting || a.km - b.km || (a.f.id < b.f.id ? -1 : 1))
    .map(({ f, km, waiting }) => ({
      facilityId: f.id,
      facilityName: f.name,
      distanceKm: Math.round(km * 100) / 100,
      waitingPlayers: waiting,
      courtsFreeSoon: freeCourts(db, cfg, f.id),
      why: waiting === 0 ? 'Nobody is waiting there.' : `${players - waiting} fewer players waiting than here.`,
    }));
  return {
    facilityId,
    facilityName: here.name,
    waitingPlayers: players,
    waitingEntries: rowNum((db.prepare(`SELECT COUNT(*) AS n FROM queue_entries WHERE facility_id = ? AND status IN ${ACTIVE_SQL}`).get(facilityId) as { n: number | bigint }).n),
    courtsFreeSoon: freeCourts(db, cfg, facilityId),
    estimate: waitEstimate(db, facilityId),
    alternatives,
  };
}

/** Public view: display name, rating level, party size and place only. No ids, no contact details. */
export function publicStatus(db: DatabaseSync, cfg: PlayConfig, facilityId: unknown, radiusKm: unknown, viewerId: string | null) {
  if (typeof facilityId !== 'string' || !facilityId) return fail(400, 'invalid_query');
  sweepQueue(db, cfg);
  let radius = 10;
  if (radiusKm !== undefined) {
    radius = Number(radiusKm);
    if (!Number.isFinite(radius) || radius < 0.5 || radius > 50) return fail(400, 'invalid_radius');
  }
  const summary = queueSummary(db, cfg, facilityId, radius);
  const settings = getSettings(db, facilityId);
  const rows = db
    .prepare(
      `SELECT e.*, p.display_name AS name FROM queue_entries e JOIN players p ON p.id = e.player_id
       WHERE e.facility_id = ? AND e.status IN ${ACTIVE_SQL} ORDER BY e.joined_at, e.rowid LIMIT 50`,
    )
    .all(facilityId) as (EntryRow & { name: string })[];
  const mine = viewerId
    ? (db.prepare(`SELECT * FROM queue_entries WHERE player_id = ? AND status IN ${ACTIVE_SQL}`).get(viewerId) as EntryRow | undefined)
    : undefined;
  return {
    ...summary,
    queue: rows.map((e, i) => ({
      position: i + 1,
      displayName: e.name,
      level: displayLevel(rowNum(e.rating_snapshot)),
      partySize: rowNum(e.party_size),
      state: e.status === 'waiting' ? 'waiting' : 'court_ready',
    })),
    policy: describeMode(settings),
    acceptanceWindowSeconds: settings.acceptanceWindowSeconds,
    ...(mine ? { you: presentOwnEntry(db, cfg, mine) } : {}),
  };
}

// ------------------------------------------------------------------ admin

export function adminQueue(db: DatabaseSync, cfg: PlayConfig, facilityId: unknown) {
  if (typeof facilityId !== 'string' || !facilityExists(db, facilityId)) return fail(404, 'facility_not_found');
  sweepQueue(db, cfg);
  const rows = db
    .prepare(
      `SELECT e.*, p.display_name AS name FROM queue_entries e JOIN players p ON p.id = e.player_id
       WHERE e.facility_id = ? AND e.status IN ${ACTIVE_SQL} ORDER BY e.joined_at, e.rowid`,
    )
    .all(facilityId) as (EntryRow & { name: string })[];
  const offers = (db.prepare("SELECT * FROM queue_offers WHERE facility_id = ? AND status = 'pending' ORDER BY offered_at").all(facilityId) as OfferRow[]).map((o) =>
    presentOffer(db, cfg, o, null),
  );
  return {
    settings: getSettings(db, facilityId),
    entries: rows.map((e, i) => ({
      id: e.id,
      position: i + 1,
      playerId: e.player_id,
      displayName: e.name,
      level: displayLevel(rowNum(e.rating_snapshot)),
      partySize: rowNum(e.party_size),
      format: e.format,
      status: e.status,
      source: e.source,
      courtId: e.court_id,
      joinedAt: e.joined_at,
      bypassedCount: rowNum(e.bypassed_count),
      demo: Boolean(rowNum(e.demo)),
    })),
    offers,
  };
}

export function listAudit(db: DatabaseSync, facilityId: unknown, entryId: unknown, limit: unknown) {
  if (typeof facilityId !== 'string' || !facilityId) return fail(400, 'invalid_query');
  let n = 100;
  if (limit !== undefined) {
    n = Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 500) return fail(400, 'invalid_query');
  }
  const rows = (
    typeof entryId === 'string'
      ? db.prepare('SELECT * FROM queue_audit WHERE facility_id = ? AND entry_id = ? ORDER BY id DESC LIMIT ?').all(facilityId, entryId, n)
      : db.prepare('SELECT * FROM queue_audit WHERE facility_id = ? ORDER BY id DESC LIMIT ?').all(facilityId, n)
  ) as {
    id: number | bigint;
    facility_id: string;
    entry_id: string | null;
    event: string;
    from_status: string | null;
    to_status: string | null;
    actor: string;
    at: string;
    detail: string | null;
  }[];
  return {
    audit: rows.reverse().map((r) => ({
      id: rowNum(r.id),
      facilityId: r.facility_id,
      entryId: r.entry_id,
      event: r.event,
      from: r.from_status,
      to: r.to_status,
      actor: r.actor,
      at: r.at,
      detail: r.detail ? (JSON.parse(r.detail) as unknown) : null,
    })),
  };
}

// ------------------------------------------------------------------- demo

const DEMO_QUEUE_FACILITY = 'demo-facility';
const DEMO_QUEUE = [
  { key: 'bao', player: 'demo-bao', minutesAgo: 24, party: 1 },
  { key: 'linh', player: 'demo-linh', minutesAgo: 20, party: 1 },
  { key: 'chi', player: 'demo-chi', minutesAgo: 16, party: 1 },
  { key: 'hung', player: 'demo-hung', minutesAgo: 12, party: 1 },
  { key: 'yen', player: 'demo-yen', minutesAgo: 8, party: 1 },
  { key: 'trang', player: 'demo-trang', minutesAgo: 4, party: 1 },
] as const;

/**
 * Idempotent. Deterministic ids per venue day, flagged demo = 1. A demo player already in a queue is left alone,
 * and an entry that was since served, cancelled or expired is not re-created that day.
 */
export function seedDemoQueue(db: DatabaseSync, cfg: PlayConfig): number {
  if (!facilityExists(db, DEMO_QUEUE_FACILITY)) return 0;
  const date = venueLocal(cfg.now()).slice(0, 10);
  return guarded(db, () => {
    let added = 0;
    for (const demo of DEMO_QUEUE) {
      const id = `demo-qe-${demo.key}-${date}`;
      if (getEntry(db, id)) continue;
      const player = db.prepare('SELECT pir_rating FROM players WHERE id = ? AND demo = 1').get(demo.player) as { pir_rating: number | bigint } | undefined;
      if (!player) continue;
      if (db.prepare(`SELECT 1 FROM queue_entries WHERE player_id = ? AND status IN ${ACTIVE_SQL}`).get(demo.player)) continue;
      const joined = iso(cfg.now() - demo.minutesAgo * 60_000);
      db.prepare(
        `INSERT INTO queue_entries (id, player_id, facility_id, joined_at, rating_snapshot, party_size, format, status, source, demo, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'doubles', 'waiting', 'app', 1, ?)`,
      ).run(id, demo.player, DEMO_QUEUE_FACILITY, joined, rowNum(player.pir_rating), demo.party, joined);
      audit(db, cfg, DEMO_QUEUE_FACILITY, id, 'joined', null, 'waiting', { kind: 'system' }, { source: 'app', demo: true });
      added += 1;
    }
    return added;
  });
}
