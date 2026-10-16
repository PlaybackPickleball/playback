import type { DatabaseSync } from 'node:sqlite';
import { createOpenMatch, joinOpenMatch, type PublicMatch } from './openMatches.js';
import { releaseExpiredHolds } from './bookings.js';
import { presentSlot, type PublicSlot } from './slots.js';
import { TIME_RE, fail, iso, newId, rowNum, tx, venueLocal, type PlayConfig } from './util.js';

/**
 * Owner-controlled court fill. Nothing here changes a price on its own.
 * A slot is offered at the facility's promo price only when Smart Fill is enabled,
 * the slot hour is inside the saved window, and the discount is within the saved cap.
 * Players are seated only by joinOpenMatch, and only after the facility approves the request.
 */

export type FillSettings = {
  facilityId: string;
  enabled: boolean;
  normalPriceVnd: number | null;
  promoPriceVnd: number | null;
  maxDiscountPercent: number | null;
  promotableStart: string | null;
  promotableEnd: string | null;
  demo: boolean;
  updatedAt: string | null;
};

type RuleRow = {
  facility_id: string;
  enabled: number | bigint;
  normal_price_vnd: number | bigint;
  promo_price_vnd: number | bigint;
  max_discount_percent: number | bigint;
  promotable_start: string;
  promotable_end: string;
  demo: number | bigint;
  updated_at: string;
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

type RequestRow = {
  id: string;
  facility_id: string;
  open_match_id: string;
  player_id: string;
  status: 'pending' | 'approved' | 'rejected';
  demo: number | bigint;
  created_at: string;
  updated_at: string;
};

const SLOT_SELECT = `SELECT a.*, c.number AS court_number FROM court_availability a JOIN courts c ON c.id = a.court_id`;

const facilityDemo = (db: DatabaseSync, facilityId: string) =>
  db.prepare('SELECT demo FROM facilities WHERE id = ?').get(facilityId) as { demo: number | bigint } | undefined;

const ruleRow = (db: DatabaseSync, facilityId: string) =>
  db.prepare('SELECT * FROM promotion_rules WHERE facility_id = ?').get(facilityId) as RuleRow | undefined;

const presentRule = (row: RuleRow): FillSettings => ({
  facilityId: row.facility_id,
  enabled: rowNum(row.enabled) === 1,
  normalPriceVnd: rowNum(row.normal_price_vnd),
  promoPriceVnd: rowNum(row.promo_price_vnd),
  maxDiscountPercent: rowNum(row.max_discount_percent),
  promotableStart: row.promotable_start,
  promotableEnd: row.promotable_end,
  demo: rowNum(row.demo) === 1,
  updatedAt: row.updated_at,
});

const blankSettings = (facilityId: string, demo: boolean): FillSettings => ({
  facilityId,
  enabled: false,
  normalPriceVnd: null,
  promoPriceVnd: null,
  maxDiscountPercent: null,
  promotableStart: null,
  promotableEnd: null,
  demo,
  updatedAt: null,
});

/** True when promo is below the reference by more than maxPercent. A discount equal to the cap is allowed. */
export function discountExceedsMax(referenceVnd: number, promoVnd: number, maxPercent: number): boolean {
  if (promoVnd >= referenceVnd) return false;
  return (referenceVnd - promoVnd) * 100 > referenceVnd * maxPercent;
}

function money(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 100_000_000) return fail(400, 'invalid_price');
  return value as number;
}

export function getFillSettings(db: DatabaseSync, facilityId: string): FillSettings {
  if (!facilityId) return fail(400, 'invalid_query');
  const facility = facilityDemo(db, facilityId);
  if (!facility) return fail(404, 'facility_not_found');
  const row = ruleRow(db, facilityId);
  return row ? presentRule(row) : blankSettings(facilityId, rowNum(facility.demo) === 1);
}

export function putFillSettings(db: DatabaseSync, cfg: PlayConfig, input: Record<string, unknown>): FillSettings {
  const facilityId = input.facilityId;
  if (typeof facilityId !== 'string' || !facilityId) return fail(400, 'invalid_body');
  const facility = facilityDemo(db, facilityId);
  if (!facility) return fail(404, 'facility_not_found');
  if (typeof input.enabled !== 'boolean') return fail(400, 'invalid_body');
  const normalPriceVnd = money(input.normalPriceVnd);
  const promoPriceVnd = money(input.promoPriceVnd);
  const maxDiscountPercent = input.maxDiscountPercent;
  if (!Number.isInteger(maxDiscountPercent) || (maxDiscountPercent as number) < 0 || (maxDiscountPercent as number) > 100) {
    return fail(400, 'invalid_body');
  }
  const promotableStart = input.promotableStart;
  const promotableEnd = input.promotableEnd;
  if (typeof promotableStart !== 'string' || typeof promotableEnd !== 'string' || !TIME_RE.test(promotableStart) || !TIME_RE.test(promotableEnd) || promotableEnd <= promotableStart) {
    return fail(400, 'invalid_slot_time');
  }
  const stamp = iso(cfg.now());
  const demo = rowNum(facility.demo) === 1 ? 1 : 0;
  tx(db, () => {
    db.prepare(
      `INSERT INTO promotion_rules (
         facility_id, enabled, normal_price_vnd, promo_price_vnd, max_discount_percent,
         promotable_start, promotable_end, demo, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(facility_id) DO UPDATE SET
         enabled = excluded.enabled,
         normal_price_vnd = excluded.normal_price_vnd,
         promo_price_vnd = excluded.promo_price_vnd,
         max_discount_percent = excluded.max_discount_percent,
         promotable_start = excluded.promotable_start,
         promotable_end = excluded.promotable_end,
         updated_at = excluded.updated_at`,
    ).run(
      facilityId,
      input.enabled ? 1 : 0,
      normalPriceVnd,
      promoPriceVnd,
      maxDiscountPercent as number,
      promotableStart,
      promotableEnd,
      demo,
      stamp,
    );
  });
  return presentRule(ruleRow(db, facilityId)!);
}

export function disableFill(db: DatabaseSync, cfg: PlayConfig, facilityId: unknown): FillSettings {
  if (typeof facilityId !== 'string' || !facilityId) return fail(400, 'invalid_body');
  const facility = facilityDemo(db, facilityId);
  if (!facility) return fail(404, 'facility_not_found');
  const row = ruleRow(db, facilityId);
  if (!row) return blankSettings(facilityId, rowNum(facility.demo) === 1);
  db.prepare('UPDATE promotion_rules SET enabled = 0, updated_at = ? WHERE facility_id = ?').run(iso(cfg.now()), facilityId);
  return presentRule(ruleRow(db, facilityId)!);
}

/** Vacant demo inventory only: available, unbooked, still in the future, labeled demo. */
export function listVacantDemoSlots(db: DatabaseSync, cfg: PlayConfig, facilityId: string): PublicSlot[] {
  if (!facilityId) return fail(400, 'invalid_query');
  if (!facilityDemo(db, facilityId)) return fail(404, 'facility_not_found');
  releaseExpiredHolds(db, cfg);
  const rows = db
    .prepare(
      `${SLOT_SELECT} WHERE a.facility_id = ? AND a.demo = 1 AND a.status = 'available' AND a.booking_id IS NULL
       AND (a.date || 'T' || a.start) > ? ORDER BY a.date, a.start, c.number`,
    )
    .all(facilityId, venueLocal(cfg.now())) as Parameters<typeof presentSlot>[0][];
  return rows.map((row) => presentSlot(row, cfg));
}

function loadSlot(db: DatabaseSync, slotId: string): SlotRow {
  const slot = db.prepare('SELECT * FROM court_availability WHERE id = ?').get(slotId) as SlotRow | undefined;
  if (!slot) return fail(404, 'slot_not_found');
  return slot;
}

/**
 * Publishes one open game at the facility's promo price. The listed slot price is left unchanged.
 * Rejects when the feature is off, the hour is outside the window, or the discount is over the cap.
 */
export function publishFillGame(
  db: DatabaseSync,
  cfg: PlayConfig,
  input: { slotId: unknown; hostPlayerId: unknown },
): { match: PublicMatch; promoPriceVnd: number; bookingId: string; replayed: boolean } {
  if (typeof input.slotId !== 'string' || !input.slotId) return fail(400, 'invalid_body');
  if (typeof input.hostPlayerId !== 'string' || !input.hostPlayerId) return fail(400, 'invalid_body');
  if (!db.prepare('SELECT 1 FROM players WHERE id = ?').get(input.hostPlayerId)) return fail(404, 'player_not_found');

  return tx(db, () => {
    const slot = loadSlot(db, input.slotId as string);
    if (slot.status !== 'available' || slot.booking_id) return fail(409, 'slot_not_vacant');
    const rules = ruleRow(db, slot.facility_id);
    if (!rules || rowNum(rules.enabled) !== 1) return fail(409, 'smart_fill_disabled');
    if (slot.start < rules.promotable_start || slot.start >= rules.promotable_end) return fail(409, 'outside_promotable_hours');
    const normal = rowNum(rules.normal_price_vnd);
    const promo = rowNum(rules.promo_price_vnd);
    const cap = rowNum(rules.max_discount_percent);
    const listed = rowNum(slot.price_vnd);
    // Both the owner's normal price and the slot's listed price are ceilings. Neither is rewritten here.
    if (discountExceedsMax(normal, promo, cap) || discountExceedsMax(listed, promo, cap)) return fail(409, 'discount_exceeds_max');

    const key = `fillpub-${slot.id}`.slice(0, 100);
    const created = createOpenMatch(db, cfg, input.hostPlayerId as string, {
      slotId: slot.id,
      format: 'doubles',
      minLevel: 1,
      maxLevel: 8,
      idempotencyKey: key,
      courtPriceVnd: promo,
      demo: rowNum(slot.demo) === 1,
    });
    const bookingId = (
      db.prepare('SELECT booking_id FROM open_matches WHERE id = ?').get(created.match.id) as { booking_id: string }
    ).booking_id;
    const already = db.prepare('SELECT 1 FROM fill_publications WHERE booking_id = ?').get(bookingId);
    if (!already) {
      db.prepare('UPDATE revenue_attributions SET incremental = 1 WHERE booking_id = ?').run(bookingId);
      db.prepare(
        `INSERT INTO fill_publications (
           id, facility_id, slot_id, open_match_id, booking_id, promo_price_vnd, normal_price_vnd, demo, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newId('fill'),
        slot.facility_id,
        slot.id,
        created.match.id,
        bookingId,
        promo,
        normal,
        rowNum(slot.demo) === 1 ? 1 : 0,
        iso(cfg.now()),
      );
    }
    return { match: created.match, promoPriceVnd: promo, bookingId, replayed: Boolean(already) || created.replayed };
  });
}

const presentRequest = (row: RequestRow) => ({
  id: row.id,
  facilityId: row.facility_id,
  openMatchId: row.open_match_id,
  playerId: row.player_id,
  status: row.status,
  demo: rowNum(row.demo) === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export function requestFillJoin(db: DatabaseSync, cfg: PlayConfig, playerId: string, openMatchId: unknown) {
  if (typeof openMatchId !== 'string' || !openMatchId) return fail(400, 'invalid_body');
  return tx(db, () => {
    const match = db.prepare('SELECT * FROM open_matches WHERE id = ?').get(openMatchId) as
      | { id: string; facility_id: string; booking_id: string; host_player_id: string; status: string }
      | undefined;
    if (!match) return fail(404, 'not_found');
    const published = db.prepare('SELECT 1 FROM fill_publications WHERE open_match_id = ?').get(match.id);
    if (!published) return fail(409, 'not_a_fill_game');
    const rules = ruleRow(db, match.facility_id);
    if (!rules || rowNum(rules.enabled) !== 1) return fail(409, 'smart_fill_disabled');
    if (match.status !== 'open') return fail(409, 'match_closed');
    if (match.host_player_id === playerId) return fail(409, 'already_joined');
    const seated = db
      .prepare("SELECT 1 FROM booking_participants WHERE booking_id = ? AND player_id = ? AND status = 'joined'")
      .get(match.booking_id, playerId);
    if (seated) return fail(409, 'already_joined');
    const prior = db.prepare('SELECT * FROM fill_requests WHERE open_match_id = ? AND player_id = ?').get(match.id, playerId) as RequestRow | undefined;
    if (prior && (prior.status === 'pending' || prior.status === 'approved')) return { request: presentRequest(prior), replayed: true };
    if (prior?.status === 'rejected') return fail(409, 'request_closed');
    const player = db.prepare('SELECT demo FROM players WHERE id = ?').get(playerId) as { demo: number | bigint };
    const stamp = iso(cfg.now());
    const id = newId('fr');
    db.prepare(
      `INSERT INTO fill_requests (id, facility_id, open_match_id, player_id, status, demo, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
    ).run(id, match.facility_id, match.id, playerId, rowNum(player.demo) === 1 ? 1 : 0, stamp, stamp);
    return { request: presentRequest(db.prepare('SELECT * FROM fill_requests WHERE id = ?').get(id) as RequestRow), replayed: false };
  });
}

export function approveFillRequest(db: DatabaseSync, cfg: PlayConfig, requestId: string) {
  return tx(db, () => {
    const request = db.prepare('SELECT * FROM fill_requests WHERE id = ?').get(requestId) as RequestRow | undefined;
    if (!request) return fail(404, 'not_found');
    if (request.status === 'rejected') return fail(409, 'request_closed');
    const rules = ruleRow(db, request.facility_id);
    if (!rules || rowNum(rules.enabled) !== 1) return fail(409, 'smart_fill_disabled');
    if (request.status !== 'approved') {
      db.prepare("UPDATE fill_requests SET status = 'approved', updated_at = ? WHERE id = ?").run(iso(cfg.now()), request.id);
    }
    // Seating goes through Play Now. This does not write a second booking and does not touch ratings.
    const joined = joinOpenMatch(db, cfg, request.player_id, request.open_match_id);
    const saved = db.prepare('SELECT * FROM fill_requests WHERE id = ?').get(request.id) as RequestRow;
    return { request: presentRequest(saved), match: joined.match, replayed: request.status === 'approved' || joined.replayed };
  });
}

export function rejectFillRequest(db: DatabaseSync, cfg: PlayConfig, requestId: string) {
  return tx(db, () => {
    const request = db.prepare('SELECT * FROM fill_requests WHERE id = ?').get(requestId) as RequestRow | undefined;
    if (!request) return fail(404, 'not_found');
    if (request.status === 'rejected') return { request: presentRequest(request), replayed: true };
    if (request.status !== 'pending') return fail(409, 'request_closed');
    db.prepare("UPDATE fill_requests SET status = 'rejected', updated_at = ? WHERE id = ?").run(iso(cfg.now()), request.id);
    return { request: presentRequest(db.prepare('SELECT * FROM fill_requests WHERE id = ?').get(request.id) as RequestRow), replayed: false };
  });
}

/** Sums stored attribution rows. Incremental is only the rows flagged incremental, never every Playback booking. */
export function fillRevenueSummary(db: DatabaseSync, facilityId: string) {
  if (!facilityId) return fail(400, 'invalid_query');
  if (!facilityDemo(db, facilityId)) return fail(404, 'facility_not_found');
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(amount_vnd), 0) AS gross,
         COALESCE(SUM(CASE WHEN origin = 'playback' THEN amount_vnd ELSE 0 END), 0) AS playback,
         COALESCE(SUM(CASE WHEN incremental = 1 THEN amount_vnd ELSE 0 END), 0) AS incremental
       FROM revenue_attributions WHERE facility_id = ?`,
    )
    .get(facilityId) as { gross: number | bigint; playback: number | bigint; incremental: number | bigint };
  return {
    facilityId,
    grossBookingValueVnd: rowNum(row.gross),
    playbackOriginatedVnd: rowNum(row.playback),
    estimatedIncrementalVnd: rowNum(row.incremental),
    currency: 'VND' as const,
  };
}
