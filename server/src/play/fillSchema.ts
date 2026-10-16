import type { DatabaseSync } from 'node:sqlite';

/**
 * Additive only. Smart Court Fill never rewrites an existing table.
 * Prices are integer VND. `incremental` defaults to 0: a Playback booking is not incremental
 * unless a later, explicit update flags that one row. `demo = 1` marks seeded demo rules.
 */
export const FILL_SCHEMA = `
CREATE TABLE IF NOT EXISTS promotion_rules (
  facility_id TEXT PRIMARY KEY REFERENCES facilities(id),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  normal_price_vnd INTEGER NOT NULL CHECK (normal_price_vnd >= 0),
  promo_price_vnd INTEGER NOT NULL CHECK (promo_price_vnd >= 0),
  max_discount_percent INTEGER NOT NULL CHECK (max_discount_percent BETWEEN 0 AND 100),
  promotable_start TEXT NOT NULL,
  promotable_end TEXT NOT NULL,
  demo INTEGER NOT NULL DEFAULT 0 CHECK (demo IN (0, 1)),
  updated_at TEXT NOT NULL,
  CHECK (promotable_end > promotable_start)
);

CREATE TABLE IF NOT EXISTS fill_publications (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facilities(id),
  slot_id TEXT NOT NULL REFERENCES court_availability(id),
  open_match_id TEXT NOT NULL UNIQUE REFERENCES open_matches(id),
  booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id),
  promo_price_vnd INTEGER NOT NULL CHECK (promo_price_vnd >= 0),
  normal_price_vnd INTEGER NOT NULL CHECK (normal_price_vnd >= 0),
  demo INTEGER NOT NULL DEFAULT 0 CHECK (demo IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fill_publications_facility ON fill_publications (facility_id, created_at);

CREATE TABLE IF NOT EXISTS fill_requests (
  id TEXT PRIMARY KEY,
  facility_id TEXT NOT NULL REFERENCES facilities(id),
  open_match_id TEXT NOT NULL REFERENCES open_matches(id),
  player_id TEXT NOT NULL REFERENCES players(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  demo INTEGER NOT NULL DEFAULT 0 CHECK (demo IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (open_match_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_fill_requests_facility ON fill_requests (facility_id, status);

CREATE TABLE IF NOT EXISTS revenue_attributions (
  booking_id TEXT PRIMARY KEY REFERENCES bookings(id),
  facility_id TEXT NOT NULL REFERENCES facilities(id),
  origin TEXT NOT NULL CHECK (origin IN ('playback', 'facility')),
  amount_vnd INTEGER NOT NULL CHECK (amount_vnd >= 0),
  incremental INTEGER NOT NULL DEFAULT 0 CHECK (incremental IN (0, 1)),
  demo INTEGER NOT NULL DEFAULT 0 CHECK (demo IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revenue_attributions_facility ON revenue_attributions (facility_id, origin);
`;

export type AttributionOrigin = 'playback' | 'facility';

export type AttributionInput = {
  bookingId: string;
  facilityId: string;
  origin: AttributionOrigin;
  amountVnd: number;
  /** Defaults to false. Callers must opt in for a single booking. */
  incremental?: boolean;
  demo?: boolean;
  at: string;
};

/** One row per booking. A second insert for the same booking does nothing, so the flag is not reset. */
export function recordAttribution(db: DatabaseSync, row: AttributionInput): void {
  db.prepare(
    `INSERT INTO revenue_attributions (booking_id, facility_id, origin, amount_vnd, incremental, demo, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(booking_id) DO NOTHING`,
  ).run(row.bookingId, row.facilityId, row.origin, row.amountVnd, row.incremental ? 1 : 0, row.demo ? 1 : 0, row.at);
}

export function ensureFillSchema(db: DatabaseSync): void {
  db.exec(FILL_SCHEMA);
  const bookings = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bookings'").get();
  if (!bookings) return;
  // Existing bookings get a row with incremental left off. This does not treat Playback origin as incremental.
  db.prepare(
    `INSERT INTO revenue_attributions (booking_id, facility_id, origin, amount_vnd, incremental, demo, created_at)
     SELECT b.id, b.facility_id, b.origin, b.price_vnd, 0,
            CASE WHEN IFNULL(a.demo, 0) = 1 THEN 1 ELSE 0 END,
            b.created_at
     FROM bookings b
     LEFT JOIN court_availability a ON a.id = b.slot_id
     WHERE NOT EXISTS (SELECT 1 FROM revenue_attributions r WHERE r.booking_id = b.id)`,
  ).run();
}

/** Demo rules are off, labeled demo, and priced inside a 20% cap for the evening window. Insert-only unless reset. */
export const DEMO_FILL_RULE = {
  normalPriceVnd: 150_000,
  promoPriceVnd: 120_000,
  maxDiscountPercent: 20,
  promotableStart: '17:00',
  promotableEnd: '21:00',
} as const;

export function seedPromotionRules(db: DatabaseSync, now: string, reset = false): number {
  const ready = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'promotion_rules'").get();
  if (!ready) return 0;
  const facilities = db.prepare('SELECT id FROM facilities WHERE demo = 1 ORDER BY id').all() as { id: string }[];
  const insert = db.prepare(
    `INSERT OR IGNORE INTO promotion_rules (
       facility_id, enabled, normal_price_vnd, promo_price_vnd, max_discount_percent,
       promotable_start, promotable_end, demo, updated_at
     ) VALUES (?, 0, ?, ?, ?, ?, ?, 1, ?)`,
  );
  let added = 0;
  for (const facility of facilities) {
    const result = insert.run(
      facility.id,
      DEMO_FILL_RULE.normalPriceVnd,
      DEMO_FILL_RULE.promoPriceVnd,
      DEMO_FILL_RULE.maxDiscountPercent,
      DEMO_FILL_RULE.promotableStart,
      DEMO_FILL_RULE.promotableEnd,
      now,
    );
    added += Number(result.changes);
  }
  if (reset) {
    // Restores labeled demo rules only. Rows with demo = 0, and every booking, stay as they are.
    db.prepare(
      `UPDATE promotion_rules SET enabled = 0, normal_price_vnd = ?, promo_price_vnd = ?, max_discount_percent = ?,
         promotable_start = ?, promotable_end = ?, updated_at = ?
       WHERE demo = 1`,
    ).run(
      DEMO_FILL_RULE.normalPriceVnd,
      DEMO_FILL_RULE.promoPriceVnd,
      DEMO_FILL_RULE.maxDiscountPercent,
      DEMO_FILL_RULE.promotableStart,
      DEMO_FILL_RULE.promotableEnd,
      now,
    );
  }
  return added;
}
