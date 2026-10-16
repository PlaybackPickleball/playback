import type { DatabaseSync } from 'node:sqlite';
import { releaseExpiredHolds } from './bookings.js';
import { SLOT_STATUSES, type SlotStatus } from './schema.js';
import { TIME_RE, fail, iso, newId, rowNum, tx, validDate, venueLocal, type PlayConfig } from './util.js';

type SlotRow = {
  id: string;
  facility_id: string;
  court_id: string;
  court_number: number | bigint;
  date: string;
  start: string;
  end: string;
  price_vnd: number | bigint;
  status: SlotStatus;
  source: string;
  demo: number | bigint;
  updated_at: string;
};

export type PublicSlot = {
  id: string;
  facilityId: string;
  courtId: string;
  courtNumber: number;
  date: string;
  start: string;
  end: string;
  priceVnd: number;
  currency: 'VND';
  status: SlotStatus;
  source: string;
  demo: boolean;
  updatedAt: string;
  /** false when the row is older than the stale threshold: the UI shows "Availability not verified". */
  availabilityVerified: boolean;
  /** true only when a player could try to hold it now (available and not in the past). */
  bookable: boolean;
};

const SLOT_SELECT = `SELECT a.*, c.number AS court_number FROM court_availability a JOIN courts c ON c.id = a.court_id`;

export function presentSlot(row: SlotRow, cfg: PlayConfig): PublicSlot {
  const now = cfg.now();
  const age = now - Date.parse(row.updated_at);
  return {
    id: row.id,
    facilityId: row.facility_id,
    courtId: row.court_id,
    courtNumber: rowNum(row.court_number),
    date: row.date,
    start: row.start,
    end: row.end,
    priceVnd: rowNum(row.price_vnd),
    currency: 'VND',
    status: row.status,
    source: row.source,
    demo: rowNum(row.demo) === 1,
    updatedAt: row.updated_at,
    availabilityVerified: Number.isFinite(age) && age <= cfg.staleMinutes * 60_000,
    bookable: row.status === 'available' && `${row.date}T${row.start}` > venueLocal(now),
  };
}

export function getSlot(db: DatabaseSync, id: string): SlotRow | undefined {
  return db.prepare(`${SLOT_SELECT} WHERE a.id = ?`).get(id) as SlotRow | undefined;
}

/** Public read: expired holds are released first, then rows come back with the stale flag. No player data. */
export function listSlots(db: DatabaseSync, cfg: PlayConfig, query: { facilityId: string; date: string }): PublicSlot[] {
  if (!validDate(query.date)) fail(400, 'invalid_date');
  releaseExpiredHolds(db, cfg);
  const rows = db
    .prepare(`${SLOT_SELECT} WHERE a.facility_id = ? AND a.date = ? ORDER BY c.number, a.start`)
    .all(query.facilityId, query.date) as SlotRow[];
  return rows.map((row) => presentSlot(row, cfg));
}

export type NewSlot = { facilityId: string; courtId: string; date: string; start: string; end: string; priceVnd: number };

/** Facility action. Slots created this way are labelled source 'facility'. */
export function createSlot(db: DatabaseSync, cfg: PlayConfig, input: NewSlot): PublicSlot {
  const { facilityId, courtId, date, start, end, priceVnd } = input;
  if (typeof facilityId !== 'string' || typeof courtId !== 'string') return fail(400, 'invalid_body');
  if (!validDate(date) || typeof start !== 'string' || typeof end !== 'string' || !TIME_RE.test(start) || !TIME_RE.test(end) || end <= start) {
    return fail(400, 'invalid_slot_time');
  }
  if (!Number.isInteger(priceVnd) || priceVnd < 0 || priceVnd > 100_000_000) return fail(400, 'invalid_price');
  return tx(db, () => {
    const court = db.prepare('SELECT facility_id FROM courts WHERE id = ?').get(courtId) as { facility_id: string } | undefined;
    if (!court || court.facility_id !== facilityId) return fail(404, 'court_not_found');
    const clash = db
      .prepare('SELECT 1 FROM court_availability WHERE court_id = ? AND date = ? AND start < ? AND end > ?')
      .get(courtId, date, end, start);
    if (clash) return fail(409, 'slot_overlap');
    const id = newId('slot');
    db.prepare(
      `INSERT INTO court_availability (id, facility_id, court_id, date, start, end, price_vnd, status, source, demo, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'available', 'facility', 0, ?)`,
    ).run(id, facilityId, courtId, date, start, end, priceVnd, iso(cfg.now()));
    return presentSlot(getSlot(db, id)!, cfg);
  });
}

/** Facility action: confirm the slot is still accurate (refreshes updated_at). */
export function verifySlot(db: DatabaseSync, cfg: PlayConfig, id: string): PublicSlot {
  return tx(db, () => {
    if (!getSlot(db, id)) return fail(404, 'not_found');
    db.prepare('UPDATE court_availability SET updated_at = ? WHERE id = ?').run(iso(cfg.now()), id);
    return presentSlot(getSlot(db, id)!, cfg);
  });
}

/** Facility action: mark a free slot unavailable, in_play, queue_managed, or back to available. */
export function setSlotStatus(db: DatabaseSync, cfg: PlayConfig, id: string, status: unknown): PublicSlot {
  if (typeof status !== 'string' || !(SLOT_STATUSES as readonly string[]).includes(status) || status === 'held' || status === 'booked') {
    return fail(400, 'invalid_status');
  }
  return tx(db, () => {
    releaseExpiredHolds(db, cfg);
    const slot = getSlot(db, id);
    if (!slot) return fail(404, 'not_found');
    if (slot.status === 'held' || slot.status === 'booked') return fail(409, 'slot_in_use');
    db.prepare('UPDATE court_availability SET status = ?, updated_at = ? WHERE id = ?').run(status, iso(cfg.now()), id);
    return presentSlot(getSlot(db, id)!, cfg);
  });
}

export const DEMO_SLOT_DAYS = 3;
export const DEMO_SLOT_HOURS = [17, 18, 19, 20];

/**
 * Idempotent demo inventory. Rows are labelled source 'demo' and demo = 1, ids are deterministic and
 * INSERT OR IGNORE never rewrites an existing row. Only courts flagged demo = 1 get slots.
 */
export function seedDemoSlots(db: DatabaseSync, nowMs: number): number {
  const courts = db
    .prepare(
      `SELECT c.id, c.facility_id, c.number FROM courts c
       WHERE c.demo = 1 AND c.number <= 3 ORDER BY c.facility_id, c.number`,
    )
    .all() as { id: string; facility_id: string; number: number | bigint }[];
  const insert = db.prepare(
    `INSERT OR IGNORE INTO court_availability
       (id, facility_id, court_id, date, start, end, price_vnd, status, source, demo, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'available', 'demo', 1, ?)`,
  );
  const stamp = iso(nowMs);
  let added = 0;
  tx(db, () => {
    for (let day = 0; day < DEMO_SLOT_DAYS; day += 1) {
      const date = venueLocal(nowMs + day * 86_400_000).slice(0, 10);
      for (const court of courts) {
        for (const hour of DEMO_SLOT_HOURS) {
          const start = `${String(hour).padStart(2, '0')}:00`;
          const end = `${String(hour + 1).padStart(2, '0')}:00`;
          const price = 100_000 + (rowNum(court.number) % 2) * 20_000 + (hour >= 18 ? 50_000 : 0);
          const result = insert.run(`demo-slot-${court.id}-${date}-${start}`, court.facility_id, court.id, date, start, end, price, stamp);
          added += Number(result.changes);
        }
      }
    }
  });
  return added;
}
