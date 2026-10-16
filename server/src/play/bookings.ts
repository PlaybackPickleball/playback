import type { DatabaseSync } from 'node:sqlite';
import { recordAttribution } from './fillSchema.js';
import { BLOCKING_STATUSES, BOOKING_STATUSES, type BookingStatus } from './schema.js';
import { PlayError, cleanKey, fail, iso, newId, rowNum, tx, validDate, venueLocal, type PlayConfig } from './util.js';

/** Allowed booking transitions. Anything not listed is rejected with 409 invalid_transition. */
export const TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
  open: ['pending', 'held', 'cancelled', 'expired'],
  pending: ['held', 'confirmed', 'cancelled', 'expired'],
  held: ['confirmed', 'cancelled', 'expired'],
  confirmed: ['checked_in', 'cancelled', 'no_show'],
  checked_in: ['completed'],
  completed: [],
  cancelled: [],
  expired: [],
  no_show: [],
};

export const canTransition = (from: BookingStatus, to: BookingStatus) => TRANSITIONS[from].includes(to);
const BLOCKING_SQL = BLOCKING_STATUSES.map((s) => `'${s}'`).join(', ');

export type Actor = { kind: 'player'; playerId: string } | { kind: 'admin' } | { kind: 'system' };
const actorLabel = (actor: Actor) => (actor.kind === 'player' ? `player:${actor.playerId}` : actor.kind);

export type BookingRow = {
  id: string;
  facility_id: string;
  court_id: string;
  slot_id: string | null;
  hold_id: string | null;
  start: string;
  end: string;
  status: BookingStatus;
  price_vnd: number | bigint;
  created_by_player: string;
  origin: 'playback' | 'facility';
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
};
type HoldRow = {
  id: string;
  slot_id: string;
  court_id: string;
  player_id: string;
  status: 'active' | 'converted' | 'released' | 'expired';
  created_at: string;
  expires_at: string;
};
type SlotLite = {
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

export const getBookingRow = (db: DatabaseSync, id: string) =>
  db.prepare('SELECT * FROM bookings WHERE id = ?').get(id) as BookingRow | undefined;
const getSlotLite = (db: DatabaseSync, id: string) =>
  db.prepare('SELECT * FROM court_availability WHERE id = ?').get(id) as SlotLite | undefined;
const getHoldRow = (db: DatabaseSync, id: string) =>
  db.prepare('SELECT * FROM court_holds WHERE id = ?').get(id) as HoldRow | undefined;

function constraintToConflict(error: unknown): never {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('court_overlap')) return fail(409, 'court_overlap');
  if (message.includes('UNIQUE')) return fail(409, 'slot_unavailable');
  throw error;
}

export function guarded<T>(db: DatabaseSync, fn: () => T): T {
  try {
    return tx(db, fn);
  } catch (error) {
    if (error instanceof PlayError) throw error;
    return constraintToConflict(error);
  }
}

// ---------------------------------------------------------------- holds

/** Releases every active hold past its expiry. Safe to call any time, and called before reads and on a timer. */
export function releaseExpiredHolds(db: DatabaseSync, cfg: PlayConfig): number {
  const stamp = iso(cfg.now());
  const due = db.prepare("SELECT id FROM court_holds WHERE status = 'active' AND expires_at <= ?").all(stamp) as { id: string }[];
  if (due.length === 0) return 0;
  return tx(db, () => {
    let released = 0;
    const rows = db.prepare("SELECT * FROM court_holds WHERE status = 'active' AND expires_at <= ?").all(stamp) as HoldRow[];
    for (const hold of rows) {
      db.prepare("UPDATE court_holds SET status = 'expired' WHERE id = ?").run(hold.id);
      const booking = db.prepare("SELECT * FROM bookings WHERE hold_id = ? AND status IN ('pending', 'held', 'open')").get(hold.id) as
        | BookingRow
        | undefined;
      if (booking) applyTransition(db, cfg, booking, 'expired', { kind: 'system' });
      db.prepare(
        "UPDATE court_availability SET status = 'available', booking_id = NULL, updated_at = ? WHERE id = ? AND status = 'held'",
      ).run(stamp, hold.slot_id);
      released += 1;
    }
    return released;
  });
}

export function playerClash(
  db: DatabaseSync,
  playerId: string,
  start: string,
  end: string,
  excludeBooking: string | null,
  excludeHold: string | null,
): boolean {
  const booked = db
    .prepare(
      `SELECT 1 FROM bookings b JOIN booking_participants p ON p.booking_id = b.id
       WHERE p.player_id = ? AND p.status = 'joined' AND b.status IN (${BLOCKING_SQL})
         AND b.id <> ? AND b.start < ? AND b.end > ? LIMIT 1`,
    )
    .get(playerId, excludeBooking ?? '', end, start);
  if (booked) return true;
  const held = db
    .prepare(
      `SELECT 1 FROM court_holds h JOIN court_availability a ON a.id = h.slot_id
       WHERE h.player_id = ? AND h.status = 'active' AND h.id <> ?
         AND (a.date || 'T' || a.start) < ? AND (a.date || 'T' || a.end) > ? LIMIT 1`,
    )
    .get(playerId, excludeHold ?? '', end, start);
  return Boolean(held);
}

export type PublicHold = {
  id: string;
  slotId: string;
  courtId: string;
  status: HoldRow['status'];
  createdAt: string;
  expiresAt: string;
};
const presentHold = (hold: HoldRow): PublicHold => ({
  id: hold.id,
  slotId: hold.slot_id,
  courtId: hold.court_id,
  status: hold.status,
  createdAt: hold.created_at,
  expiresAt: hold.expires_at,
});

function insertHold(db: DatabaseSync, cfg: PlayConfig, playerId: string, slotId: string, key: string | null): HoldRow {
  const slot = getSlotLite(db, slotId);
  if (!slot) return fail(404, 'slot_not_found');
  if (slot.status !== 'available') return fail(409, 'slot_unavailable');
  const start = `${slot.date}T${slot.start}`;
  const end = `${slot.date}T${slot.end}`;
  if (start <= venueLocal(cfg.now())) return fail(409, 'slot_in_past');
  if (playerClash(db, playerId, start, end, null, null)) return fail(409, 'player_overlap');
  const id = newId('hold');
  const now = cfg.now();
  db.prepare(
    `INSERT INTO court_holds (id, slot_id, court_id, player_id, status, idempotency_key, created_at, expires_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
  ).run(id, slotId, slot.court_id, playerId, key, iso(now), iso(now + cfg.holdTtlSeconds * 1000));
  db.prepare("UPDATE court_availability SET status = 'held', updated_at = ? WHERE id = ?").run(iso(now), slotId);
  return getHoldRow(db, id)!;
}

export function createHold(
  db: DatabaseSync,
  cfg: PlayConfig,
  playerId: string,
  input: { slotId: unknown; idempotencyKey: unknown },
): { hold: PublicHold; replayed: boolean } {
  if (typeof input.slotId !== 'string' || !input.slotId) return fail(400, 'invalid_body');
  const key = cleanKey(input.idempotencyKey);
  return guarded(db, () => {
    releaseExpiredHolds(db, cfg);
    if (key) {
      const prior = db.prepare('SELECT * FROM court_holds WHERE player_id = ? AND idempotency_key = ?').get(playerId, key) as
        | HoldRow
        | undefined;
      if (prior) {
        if (prior.slot_id !== input.slotId) return fail(409, 'idempotency_conflict');
        return { hold: presentHold(prior), replayed: true };
      }
    }
    return { hold: presentHold(insertHold(db, cfg, playerId, input.slotId as string, key)), replayed: false };
  });
}

// ------------------------------------------------------- transitions

function releaseSlot(db: DatabaseSync, cfg: PlayConfig, booking: BookingRow): void {
  if (!booking.slot_id) return;
  db.prepare(
    `UPDATE court_availability SET status = 'available', booking_id = NULL, updated_at = ?
     WHERE id = ? AND booking_id = ? AND status IN ('held', 'booked', 'in_play')`,
  ).run(iso(cfg.now()), booking.slot_id, booking.id);
}

/** The single place a booking changes status. Validates, updates the row, the slot and the hold, and logs. */
export function applyTransition(db: DatabaseSync, cfg: PlayConfig, booking: BookingRow, to: BookingStatus, actor: Actor): BookingRow {
  if (!canTransition(booking.status, to)) return fail(409, 'invalid_transition');
  const now = iso(cfg.now());
  const slotTouch = (status: string) =>
    booking.slot_id &&
    db
      .prepare('UPDATE court_availability SET status = ?, booking_id = ?, updated_at = ? WHERE id = ?')
      .run(status, booking.id, now, booking.slot_id);

  if ((to === 'held' || to === 'pending' || to === 'confirmed') && booking.status === 'open') {
    // An open game takes a court only now: the slot must still be free.
    const slot = booking.slot_id ? getSlotLite(db, booking.slot_id) : undefined;
    if (!slot || slot.status !== 'available') return fail(409, 'slot_unavailable');
  }
  if (to === 'confirmed' && playerClash(db, booking.created_by_player, booking.start, booking.end, booking.id, booking.hold_id)) {
    return fail(409, 'player_overlap');
  }

  db.prepare('UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?').run(to, now, booking.id);
  db.prepare('INSERT INTO booking_status_log (booking_id, from_status, to_status, at, actor) VALUES (?, ?, ?, ?, ?)').run(
    booking.id,
    booking.status,
    to,
    now,
    actorLabel(actor),
  );

  if (to === 'cancelled' || to === 'expired') {
    releaseSlot(db, cfg, booking);
    if (booking.hold_id) {
      db.prepare("UPDATE court_holds SET status = ? WHERE id = ? AND status = 'active'").run(
        to === 'expired' ? 'expired' : 'released',
        booking.hold_id,
      );
    }
  } else if (to === 'held' || to === 'pending') {
    slotTouch('held');
  } else if (to === 'confirmed') {
    slotTouch('booked');
    if (booking.hold_id) db.prepare("UPDATE court_holds SET status = 'converted' WHERE id = ? AND status = 'active'").run(booking.hold_id);
  } else if (to === 'checked_in') {
    slotTouch('in_play');
  } else if (to === 'completed' || to === 'no_show') {
    slotTouch('booked'); // the time has passed: keep the slot linked to its booking as history
  }
  return getBookingRow(db, booking.id)!;
}

// ------------------------------------------------------------ views

export type PublicBooking = {
  id: string;
  facilityId: string;
  courtId: string;
  slotId: string | null;
  start: string;
  end: string;
  status: BookingStatus;
  priceVnd: number;
  currency: 'VND';
  origin: 'playback' | 'facility';
  /** Pay at Facility only. PlayBack takes no payment, so nothing here ever says one was processed. */
  payment: { method: 'pay_at_facility'; processed: false; note: string };
  holdExpiresAt: string | null;
  participants: { playerId: string; displayName: string; status: string }[];
  history: { from: string | null; to: string; at: string }[];
  createdAt: string;
  updatedAt: string;
};

function presentBooking(db: DatabaseSync, row: BookingRow): PublicBooking {
  const participants = db
    .prepare(
      `SELECT p.player_id AS playerId, pl.display_name AS displayName, p.status AS status
       FROM booking_participants p JOIN players pl ON pl.id = p.player_id WHERE p.booking_id = ? ORDER BY pl.display_name`,
    )
    .all(row.id) as { playerId: string; displayName: string; status: string }[];
  const history = db
    .prepare('SELECT from_status AS "from", to_status AS "to", at FROM booking_status_log WHERE booking_id = ? ORDER BY id')
    .all(row.id) as { from: string | null; to: string; at: string }[];
  const hold = row.hold_id && row.status === 'held' ? getHoldRow(db, row.hold_id) : undefined;
  return {
    id: row.id,
    facilityId: row.facility_id,
    courtId: row.court_id,
    slotId: row.slot_id,
    start: row.start,
    end: row.end,
    status: row.status,
    priceVnd: rowNum(row.price_vnd),
    currency: 'VND',
    origin: row.origin,
    payment: { method: 'pay_at_facility', processed: false, note: 'Pay at the facility. PlayBack does not take payment.' },
    holdExpiresAt: hold?.expires_at ?? null,
    participants,
    history,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function canView(db: DatabaseSync, row: BookingRow, actor: Actor): boolean {
  if (actor.kind === 'admin' || actor.kind === 'system') return true;
  if (row.created_by_player === actor.playerId) return true;
  return Boolean(
    db
      .prepare("SELECT 1 FROM booking_participants WHERE booking_id = ? AND player_id = ? AND status IN ('invited', 'joined')")
      .get(row.id, actor.playerId),
  );
}

function ownerOrAdmin(row: BookingRow, actor: Actor): void {
  if (actor.kind === 'player' && row.created_by_player !== actor.playerId) fail(403, 'forbidden');
}

// ---------------------------------------------------------- bookings

export function createBooking(
  db: DatabaseSync,
  cfg: PlayConfig,
  playerId: string,
  input: { slotId?: unknown; holdId?: unknown; idempotencyKey: unknown; priceVnd?: number },
): { booking: PublicBooking; replayed: boolean } {
  const key = cleanKey(input.idempotencyKey);
  if (!key) return fail(400, 'idempotency_key_required');
  if (input.slotId != null && typeof input.slotId !== 'string') return fail(400, 'invalid_body');
  if (input.holdId != null && typeof input.holdId !== 'string') return fail(400, 'invalid_body');
  if (!input.slotId && !input.holdId) return fail(400, 'invalid_body');

  return guarded(db, () => {
    releaseExpiredHolds(db, cfg);
    const prior = db
      .prepare('SELECT * FROM bookings WHERE created_by_player = ? AND idempotency_key = ?')
      .get(playerId, key) as BookingRow | undefined;
    if (prior) {
      const sameTarget =
        (!input.slotId || prior.slot_id === input.slotId) && (!input.holdId || prior.hold_id === input.holdId);
      if (!sameTarget) return fail(409, 'idempotency_conflict');
      return { booking: presentBooking(db, prior), replayed: true };
    }

    let hold: HoldRow;
    if (input.holdId) {
      const found = getHoldRow(db, input.holdId as string);
      if (!found) return fail(404, 'hold_not_found');
      if (found.player_id !== playerId) return fail(403, 'forbidden');
      if (found.status !== 'active') return fail(409, 'hold_expired');
      if (input.slotId && input.slotId !== found.slot_id) return fail(400, 'invalid_body');
      hold = found;
    } else {
      hold = insertHold(db, cfg, playerId, input.slotId as string, null);
    }
    const slot = getSlotLite(db, hold.slot_id)!;
    const start = `${slot.date}T${slot.start}`;
    const end = `${slot.date}T${slot.end}`;
    if (input.holdId && playerClash(db, playerId, start, end, null, hold.id)) return fail(409, 'player_overlap');
    const listed = rowNum(slot.price_vnd);
    const price = input.priceVnd == null ? listed : input.priceVnd;
    if (!Number.isInteger(price) || price < 0 || price > 100_000_000) return fail(400, 'invalid_price');
    const id = newId('bk');
    const now = iso(cfg.now());
    db.prepare(
      `INSERT INTO bookings (id, facility_id, court_id, slot_id, hold_id, start, end, status, price_vnd,
         created_by_player, origin, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'held', ?, ?, 'playback', ?, ?, ?)`,
    ).run(id, slot.facility_id, slot.court_id, slot.id, hold.id, start, end, price, playerId, key, now, now);
    recordAttribution(db, {
      bookingId: id,
      facilityId: slot.facility_id,
      origin: 'playback',
      amountVnd: price,
      incremental: false,
      demo: rowNum(slot.demo) === 1,
      at: now,
    });
    db.prepare("INSERT INTO booking_participants (booking_id, player_id, status) VALUES (?, ?, 'joined')").run(id, playerId);
    db.prepare('INSERT INTO booking_status_log (booking_id, from_status, to_status, at, actor) VALUES (?, NULL, ?, ?, ?)').run(
      id,
      'held',
      now,
      `player:${playerId}`,
    );
    db.prepare('UPDATE court_availability SET booking_id = ?, updated_at = ? WHERE id = ?').run(id, now, slot.id);
    return { booking: presentBooking(db, getBookingRow(db, id)!), replayed: false };
  });
}

export function confirmBooking(
  db: DatabaseSync,
  cfg: PlayConfig,
  playerId: string,
  id: string,
): { booking: PublicBooking; replayed: boolean } {
  return guarded(db, () => {
    releaseExpiredHolds(db, cfg);
    const row = getBookingRow(db, id);
    if (!row) return fail(404, 'not_found');
    ownerOrAdmin(row, { kind: 'player', playerId });
    if (row.status === 'confirmed') return { booking: presentBooking(db, row), replayed: true };
    if (row.status === 'expired') return fail(409, 'hold_expired');
    const next = applyTransition(db, cfg, row, 'confirmed', { kind: 'player', playerId });
    return { booking: presentBooking(db, next), replayed: false };
  });
}

export function cancelBooking(
  db: DatabaseSync,
  cfg: PlayConfig,
  actor: Actor,
  id: string,
): { booking: PublicBooking; replayed: boolean } {
  return guarded(db, () => {
    releaseExpiredHolds(db, cfg);
    const row = getBookingRow(db, id);
    if (!row) return fail(404, 'not_found');
    ownerOrAdmin(row, actor);
    if (row.status === 'cancelled') return { booking: presentBooking(db, row), replayed: true };
    const next = applyTransition(db, cfg, row, 'cancelled', actor);
    return { booking: presentBooking(db, next), replayed: false };
  });
}

/** Facility action: move a booking to any valid next state (check in, complete, no show, force cancel). */
export function adminTransition(db: DatabaseSync, cfg: PlayConfig, id: string, to: unknown): PublicBooking {
  if (typeof to !== 'string' || !(BOOKING_STATUSES as readonly string[]).includes(to)) return fail(400, 'invalid_status');
  return guarded(db, () => {
    releaseExpiredHolds(db, cfg);
    const row = getBookingRow(db, id);
    if (!row) return fail(404, 'not_found');
    return presentBooking(db, applyTransition(db, cfg, row, to as BookingStatus, { kind: 'admin' }));
  });
}

export function getBooking(db: DatabaseSync, cfg: PlayConfig, actor: Actor, id: string): PublicBooking {
  releaseExpiredHolds(db, cfg);
  const row = getBookingRow(db, id);
  if (!row) return fail(404, 'not_found');
  if (!canView(db, row, actor)) return fail(403, 'forbidden');
  return presentBooking(db, row);
}

export function listMyBookings(db: DatabaseSync, cfg: PlayConfig, playerId: string): PublicBooking[] {
  releaseExpiredHolds(db, cfg);
  const rows = db
    .prepare(
      `SELECT DISTINCT b.* FROM bookings b LEFT JOIN booking_participants p ON p.booking_id = b.id
       WHERE b.created_by_player = ? OR (p.player_id = ? AND p.status IN ('invited', 'joined'))
       ORDER BY b.start DESC, b.id LIMIT 100`,
    )
    .all(playerId, playerId) as BookingRow[];
  return rows.map((row) => presentBooking(db, row));
}

export function listAllBookings(
  db: DatabaseSync,
  cfg: PlayConfig,
  filter: { facilityId?: string; status?: string; date?: string },
): PublicBooking[] {
  if (filter.date != null && !validDate(filter.date)) return fail(400, 'invalid_date');
  if (filter.status != null && !(BOOKING_STATUSES as readonly string[]).includes(filter.status)) return fail(400, 'invalid_status');
  releaseExpiredHolds(db, cfg);
  const where: string[] = [];
  const args: string[] = [];
  if (filter.facilityId) (where.push('facility_id = ?'), args.push(filter.facilityId));
  if (filter.status) (where.push('status = ?'), args.push(filter.status));
  if (filter.date) (where.push('start LIKE ?'), args.push(`${filter.date}T%`));
  const rows = db
    .prepare(`SELECT * FROM bookings ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY start DESC, id LIMIT 200`)
    .all(...args) as BookingRow[];
  return rows.map((row) => presentBooking(db, row));
}
