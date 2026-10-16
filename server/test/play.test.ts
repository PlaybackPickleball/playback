import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type RunningApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { BOOKING_STATUSES } from '../src/play/schema.js';
import { canTransition, releaseExpiredHolds, TRANSITIONS } from '../src/play/bookings.js';
import { ensurePlaySchema } from '../src/play/schema.js';
import { seedDemoSlots } from '../src/play/slots.js';

const ADMIN = 'test-admin-token';
const START = Date.parse('2030-06-01T03:00:00Z'); // 10:00 venue time
const DAY = '2030-06-02';
const FACILITY = 'demo-facility';

type Started = { base: string; running: RunningApp; server: http.Server; clock: { now: number } };
const started: Started[] = [];

async function boot(): Promise<Started> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'court-replay-play-'));
  const clock = { now: START };
  const config = loadConfig(
    {
      HOST: '127.0.0.1',
      PORT: '8787',
      PUBLIC_BASE_URL: 'http://127.0.0.1:5173',
      STORAGE_DIR: path.join(dir, 'recordings'),
      DATABASE_PATH: path.join(dir, 'court.db'),
      LAN_MODE: 'false',
    },
    dir,
  );
  config.play = { now: () => clock.now, adminToken: ADMIN, holdTtlSeconds: 300, staleMinutes: 15, seedDemoMatches: false };
  const running = createApp(config);
  const server = http.createServer(running.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const item = { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, running, server, clock };
  started.push(item);
  return item;
}

afterEach(async () => {
  while (started.length) {
    const item = started.pop();
    if (!item) continue;
    await new Promise<void>((resolve, reject) => item.server.close((error) => (error ? reject(error) : resolve())));
    item.running.close();
  }
});

type Call = { player?: string; admin?: boolean; body?: unknown };
async function call(s: Started, method: string, url: string, opts: Call = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.player) headers['x-player-id'] = opts.player;
  if (opts.admin) headers['x-admin-token'] = ADMIN;
  const response = await fetch(`${s.base}${url}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await response.text();
  return { status: response.status, text, json: (text ? JSON.parse(text) : {}) as any };
}

async function makeSlot(s: Started, court = 'court-1', start = '10:00', end = '11:00', price = 150000, date = DAY) {
  const r = await call(s, 'POST', '/api/play/admin/slots', {
    admin: true,
    body: { facilityId: FACILITY, courtId: court, date, start, end, priceVnd: price },
  });
  expect(r.status).toBe(201);
  return r.json.slot as { id: string };
}

const book = (s: Started, player: string, slotId: string, key: string) =>
  call(s, 'POST', '/api/play/bookings', { player, body: { slotId, idempotencyKey: key } });
const slotsOf = async (s: Started, date = DAY) =>
  (await call(s, 'GET', `/api/play/slots?facilityId=${FACILITY}&date=${date}`)).json.slots as any[];
const slotById = async (s: Started, id: string) => (await slotsOf(s)).find((x) => x.id === id);
const count = (s: Started, sql: string) => Number((s.running.store.db.prepare(sql).get() as { n: number | bigint }).n);

describe('court slots, holds and bookings', () => {
  it('rejects double booking, including 20 concurrent requests for one slot', async () => {
    const s = await boot();
    const slot = await makeSlot(s);
    const players = (
      s.running.store.db.prepare('SELECT id FROM players WHERE demo = 1 ORDER BY id LIMIT 20').all() as { id: string }[]
    ).map((p) => p.id);
    expect(players).toHaveLength(20);
    const results = await Promise.all(players.map((p, i) => book(s, p, slot.id, `race-key-${i}-abcdefgh`)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(19);
    expect(count(s, "SELECT COUNT(*) AS n FROM bookings WHERE status IN ('held','confirmed')")).toBe(1);
    expect(count(s, "SELECT COUNT(*) AS n FROM court_holds WHERE status = 'active'")).toBe(1);

    const winner = results.find((r) => r.status === 201)!;
    const owner = players.find((p, i) => results[i] === winner)!;
    const confirmed = await call(s, 'POST', `/api/play/bookings/${winner.json.booking.id}/confirm`, { player: owner });
    expect(confirmed.status).toBe(200);
    // A later request on the confirmed slot is also rejected.
    const late = await book(s, players.find((p) => p !== owner)!, slot.id, 'late-key-abcdefgh');
    expect(late.status).toBe(409);
    expect(late.json.error).toBe('slot_unavailable');
  });

  it('rejects overlapping bookings at the database level, even if the code were bypassed', async () => {
    const s = await boot();
    const db = s.running.store.db;
    const insert = (id: string, status: string, start: string, end: string, slot: string | null) =>
      db
        .prepare(
          `INSERT INTO bookings (id, facility_id, court_id, slot_id, start, end, status, price_vnd, created_by_player, origin, created_at, updated_at)
           VALUES (?, ?, 'court-1', ?, ?, ?, ?, 1000, 'demo-linh', 'playback', 'x', 'x')`,
        )
        .run(id, FACILITY, slot, start, end, status);
    insert('b1', 'confirmed', `${DAY}T10:00`, `${DAY}T11:00`, null);
    expect(() => insert('b2', 'held', `${DAY}T10:30`, `${DAY}T11:30`, null)).toThrow(/court_overlap/);
    expect(() => insert('b3', 'confirmed', `${DAY}T10:00`, `${DAY}T10:30`, null)).toThrow();
    insert('b4', 'cancelled', `${DAY}T10:00`, `${DAY}T11:00`, null); // cancelled rows never block
    insert('b5', 'confirmed', `${DAY}T11:00`, `${DAY}T12:00`, null); // adjacent is fine
    expect(() => db.prepare("UPDATE bookings SET status = 'confirmed' WHERE id = 'b4'").run()).toThrow(/court_overlap/);
    const slotId = (db.prepare("SELECT id FROM court_availability WHERE court_id = 'court-1' LIMIT 1").get() as { id: string }).id;
    db.prepare(
      `INSERT INTO court_holds (id, slot_id, court_id, player_id, status, created_at, expires_at)
       VALUES ('h1', '${slotId}', 'court-1', 'demo-linh', 'active', 'x', 'y')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO court_holds (id, slot_id, court_id, player_id, status, created_at, expires_at)
           VALUES ('h2', '${slotId}', 'court-1', 'demo-hung', 'active', 'x', 'y')`,
        )
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it('releases an expired hold back to available and expires the held booking', async () => {
    const s = await boot();
    const slot = await makeSlot(s);
    const created = await book(s, 'demo-linh', slot.id, 'expire-key-abcdefgh');
    expect(created.status).toBe(201);
    expect(created.json.booking.status).toBe('held');
    expect(created.json.booking.holdExpiresAt).toBe(new Date(START + 300_000).toISOString());
    expect((await slotById(s, slot.id)).status).toBe('held');

    s.clock.now = START + 301_000;
    expect((await slotById(s, slot.id)).status).toBe('available');
    const mine = await call(s, 'GET', '/api/play/my-bookings', { player: 'demo-linh' });
    expect(mine.json.bookings[0].status).toBe('expired');
    expect(mine.json.bookings[0].history.map((h: any) => h.to)).toEqual(['held', 'expired']);
    const late = await call(s, 'POST', `/api/play/bookings/${created.json.booking.id}/confirm`, { player: 'demo-linh' });
    expect(late.status).toBe(409);
    expect(late.json.error).toBe('hold_expired');
    // Someone else can now take the slot.
    expect((await book(s, 'demo-hung', slot.id, 'next-key-abcdefgh')).status).toBe(201);
  });

  it('releases expired holds from the timer function without any read', async () => {
    const s = await boot();
    const slot = await makeSlot(s);
    const hold = await call(s, 'POST', '/api/play/holds', { player: 'demo-linh', body: { slotId: slot.id } });
    expect(hold.status).toBe(201);
    const db = s.running.store.db;
    expect(releaseExpiredHolds(db, { ...s.running.config.play, now: () => START + 1000 } as any)).toBe(0);
    s.clock.now = START + 400_000;
    expect(releaseExpiredHolds(db, { ...s.running.config.play, now: () => s.clock.now } as any)).toBe(1);
    const row = db.prepare('SELECT status FROM court_availability WHERE id = ?').get(slot.id) as { status: string };
    expect(row.status).toBe('available');
    // Only one active hold per slot while it is live.
    const first = await call(s, 'POST', '/api/play/holds', { player: 'demo-linh', body: { slotId: slot.id } });
    const second = await call(s, 'POST', '/api/play/holds', { player: 'demo-hung', body: { slotId: slot.id } });
    expect([first.status, second.status]).toEqual([201, 409]);
  });

  it('frees the slot on cancellation and lets someone else book it', async () => {
    const s = await boot();
    const slot = await makeSlot(s);
    const created = await book(s, 'demo-linh', slot.id, 'cancel-key-abcdefgh');
    const id = created.json.booking.id as string;
    const confirmed = await call(s, 'POST', `/api/play/bookings/${id}/confirm`, { player: 'demo-linh' });
    expect(confirmed.json.booking.status).toBe('confirmed');
    expect((await slotById(s, slot.id)).status).toBe('booked');

    const cancelled = await call(s, 'POST', `/api/play/bookings/${id}/cancel`, { player: 'demo-linh' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.booking.status).toBe('cancelled');
    expect((await slotById(s, slot.id)).status).toBe('available');
    expect(count(s, "SELECT COUNT(*) AS n FROM court_holds WHERE status = 'active'")).toBe(0);
    const log = s.running.store.db
      .prepare('SELECT from_status AS f, to_status AS t, actor FROM booking_status_log WHERE booking_id = ? ORDER BY id')
      .all(id) as { f: string | null; t: string; actor: string }[];
    expect(log.map((l) => `${l.f}>${l.t}`)).toEqual(['null>held', 'held>confirmed', 'confirmed>cancelled']);
    expect(log[2].actor).toBe('player:demo-linh');
    expect((await book(s, 'demo-hung', slot.id, 'again-key-abcdefgh')).status).toBe(201);
  });

  it('rejects invalid transitions and logs every valid one', async () => {
    expect(canTransition('held', 'confirmed')).toBe(true);
    expect(canTransition('confirmed', 'held')).toBe(false);
    for (const terminal of ['completed', 'cancelled', 'expired', 'no_show'] as const) {
      expect(TRANSITIONS[terminal]).toEqual([]);
    }
    for (const from of BOOKING_STATUSES) expect(canTransition(from, from)).toBe(false);

    const s = await boot();
    const slot = await makeSlot(s);
    const created = await book(s, 'demo-linh', slot.id, 'trans-key-abcdefgh');
    const id = created.json.booking.id as string;
    const go = (to: string) => call(s, 'POST', `/api/play/admin/bookings/${id}/transition`, { admin: true, body: { to } });
    expect((await go('completed')).status).toBe(409); // held -> completed is not allowed
    expect((await go('checked_in')).status).toBe(409);
    expect((await go('nonsense')).status).toBe(400);
    await call(s, 'POST', `/api/play/bookings/${id}/confirm`, { player: 'demo-linh' });
    expect((await go('held')).status).toBe(409);
    expect((await go('checked_in')).status).toBe(200);
    expect((await slotById(s, slot.id)).status).toBe('in_play');
    // A player cannot cancel once checked in.
    expect((await call(s, 'POST', `/api/play/bookings/${id}/cancel`, { player: 'demo-linh' })).status).toBe(409);
    expect((await go('completed')).status).toBe(200);
    expect((await go('confirmed')).status).toBe(409);
    expect((await go('cancelled')).status).toBe(409);
    const detail = await call(s, 'GET', `/api/play/bookings/${id}`, { player: 'demo-linh' });
    expect(detail.json.booking.history.map((h: any) => h.to)).toEqual(['held', 'confirmed', 'checked_in', 'completed']);
  });

  it('returns the same booking for the same idempotency key and never a duplicate', async () => {
    const s = await boot();
    const slot = await makeSlot(s);
    const first = await book(s, 'demo-linh', slot.id, 'idem-key-abcdefgh');
    const retry = await book(s, 'demo-linh', slot.id, 'idem-key-abcdefgh');
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.json.replayed).toBe(true);
    expect(retry.json.booking.id).toBe(first.json.booking.id);
    expect(count(s, 'SELECT COUNT(*) AS n FROM bookings')).toBe(1);
    const other = await makeSlot(s, 'court-2', '10:00', '11:00');
    const clash = await book(s, 'demo-linh', other.id, 'idem-key-abcdefgh');
    expect(clash.status).toBe(409);
    expect(clash.json.error).toBe('idempotency_conflict');
    const noKey = await call(s, 'POST', '/api/play/bookings', { player: 'demo-linh', body: { slotId: other.id } });
    expect(noKey.status).toBe(400);

    const id = first.json.booking.id as string;
    const a = await call(s, 'POST', `/api/play/bookings/${id}/confirm`, { player: 'demo-linh' });
    const b = await call(s, 'POST', `/api/play/bookings/${id}/confirm`, { player: 'demo-linh' });
    expect([a.json.replayed, b.json.replayed]).toEqual([false, true]);
    expect(count(s, 'SELECT COUNT(*) AS n FROM booking_status_log')).toBe(2);
    // The retry after confirm and a later cancel still resolves to the one booking.
    const again = await book(s, 'demo-linh', slot.id, 'idem-key-abcdefgh');
    expect(again.json.booking.id).toBe(id);
    expect(again.json.booking.status).toBe('confirmed');
    // A hold with a key is idempotent too.
    const h1 = await call(s, 'POST', '/api/play/holds', { player: 'demo-hung', body: { slotId: other.id, idempotencyKey: 'hold-key-abcdefgh' } });
    const h2 = await call(s, 'POST', '/api/play/holds', { player: 'demo-hung', body: { slotId: other.id, idempotencyKey: 'hold-key-abcdefgh' } });
    expect(h2.json.hold.id).toBe(h1.json.hold.id);
    expect(count(s, 'SELECT COUNT(*) AS n FROM court_holds')).toBe(2);
  });

  it('rejects overlapping games for one player but allows back-to-back games', async () => {
    const s = await boot();
    const a = await makeSlot(s, 'court-1', '10:00', '11:00');
    const sameTime = await makeSlot(s, 'court-2', '10:00', '11:00');
    const partial = await makeSlot(s, 'court-3', '10:30', '11:30');
    const next = await makeSlot(s, 'court-2', '11:00', '12:00');
    const first = await book(s, 'demo-linh', a.id, 'ovl-key-1-abcdefgh');
    await call(s, 'POST', `/api/play/bookings/${first.json.booking.id}/confirm`, { player: 'demo-linh' });
    for (const [i, slot] of [sameTime, partial].entries()) {
      const r = await book(s, 'demo-linh', slot.id, `ovl-key-x${i}-abcdefgh`);
      expect(r.status).toBe(409);
      expect(r.json.error).toBe('player_overlap');
      const h = await call(s, 'POST', '/api/play/holds', { player: 'demo-linh', body: { slotId: slot.id } });
      expect(h.json.error).toBe('player_overlap');
    }
    expect((await slotById(s, sameTime.id)).status).toBe('available');
    expect((await book(s, 'demo-linh', next.id, 'ovl-key-n-abcdefgh')).status).toBe(201);
    // Another player is free to take the overlapping slot.
    expect((await book(s, 'demo-hung', sameTime.id, 'ovl-key-h-abcdefgh')).status).toBe(201);
  });

  it('flags stale slots as availability_verified=false until the facility re-verifies', async () => {
    const s = await boot();
    const slot = await makeSlot(s);
    expect((await slotById(s, slot.id)).availabilityVerified).toBe(true);
    s.clock.now = START + 14 * 60_000;
    expect((await slotById(s, slot.id)).availabilityVerified).toBe(true);
    s.clock.now = START + 16 * 60_000;
    const stale = await slotById(s, slot.id);
    expect(stale.availabilityVerified).toBe(false);
    expect(stale.status).toBe('available');
    const verified = await call(s, 'POST', `/api/play/admin/slots/${slot.id}/verify`, { admin: true });
    expect(verified.json.slot.availabilityVerified).toBe(true);
    const denied = await call(s, 'POST', `/api/play/admin/slots/${slot.id}/verify`);
    expect(denied.status).toBe(403);
  });

  it('enforces who may cancel, read and list, and keeps other players private', async () => {
    const s = await boot();
    const slot = await makeSlot(s);
    const created = await book(s, 'demo-linh', slot.id, 'auth-key-abcdefgh');
    const id = created.json.booking.id as string;
    await call(s, 'POST', `/api/play/bookings/${id}/confirm`, { player: 'demo-linh' });

    expect((await call(s, 'POST', `/api/play/bookings/${id}/cancel`, { player: 'demo-hung' })).status).toBe(403);
    expect((await call(s, 'POST', `/api/play/bookings/${id}/confirm`, { player: 'demo-hung' })).status).toBe(403);
    expect((await call(s, 'GET', `/api/play/bookings/${id}`, { player: 'demo-hung' })).status).toBe(403);
    expect((await call(s, 'POST', `/api/play/bookings/${id}/cancel`)).status).toBe(401);
    expect((await call(s, 'POST', `/api/play/bookings/${id}/cancel`, { player: 'nobody' })).status).toBe(401);
    expect((await call(s, 'GET', '/api/play/my-bookings', { player: 'demo-hung' })).json.bookings).toEqual([]);
    expect((await slotById(s, slot.id)).status).toBe('booked'); // the denied cancel changed nothing

    // Public slot data carries no player information.
    const publicSlots = (await call(s, 'GET', `/api/play/slots?facilityId=${FACILITY}&date=${DAY}`)).text;
    expect(publicSlots).not.toMatch(/demo-linh|player|idempotency/i);
    // The owner's own view never exposes keys and never claims payment was taken.
    const own = (await call(s, 'GET', `/api/play/bookings/${id}`, { player: 'demo-linh' })).text;
    expect(own).not.toMatch(/idempotency|auth-key/);
    expect(JSON.parse(own).booking.payment).toMatchObject({ method: 'pay_at_facility', processed: false });
    expect(JSON.parse(own).booking.priceVnd).toBe(150000);

    // Facility actions need the admin token; a player id is not enough.
    for (const [method, url] of [
      ['GET', '/api/play/admin/bookings'],
      ['POST', `/api/play/admin/bookings/${id}/cancel`],
      ['POST', '/api/play/admin/slots'],
    ] as const) {
      expect((await call(s, method, url, { player: 'demo-linh' })).status).toBe(403);
    }
    const all = await call(s, 'GET', '/api/play/admin/bookings?status=confirmed', { admin: true });
    expect(all.json.bookings.map((b: any) => b.id)).toEqual([id]);
    const forced = await call(s, 'POST', `/api/play/admin/bookings/${id}/cancel`, { admin: true });
    expect(forced.json.booking.status).toBe('cancelled');
    expect((await slotById(s, slot.id)).status).toBe('available');
    const actors = s.running.store.db.prepare('SELECT actor FROM booking_status_log WHERE booking_id = ? ORDER BY id').all(id) as { actor: string }[];
    expect(actors.at(-1)?.actor).toBe('admin');
  });

  it('validates slot input: integer VND only, no overlapping slots, no past holds', async () => {
    const s = await boot();
    const bad = (body: Record<string, unknown>) =>
      call(s, 'POST', '/api/play/admin/slots', { admin: true, body: { facilityId: FACILITY, courtId: 'court-1', date: DAY, start: '10:00', end: '11:00', priceVnd: 1000, ...body } });
    expect((await bad({ priceVnd: 150000.5 })).status).toBe(400);
    expect((await bad({ priceVnd: -1 })).status).toBe(400);
    expect((await bad({ end: '09:00' })).status).toBe(400);
    expect((await bad({ courtId: 'demo-quan-7-court-1' })).status).toBe(404); // court of another facility
    expect((await bad({})).status).toBe(201);
    expect((await bad({ start: '10:30', end: '11:30' })).status).toBe(409);
    const past = await makeSlot(s, 'court-4', '08:00', '09:00', 100000, '2030-06-01'); // 08:00 venue time, already over at 10:00
    const hold = await call(s, 'POST', '/api/play/holds', { player: 'demo-linh', body: { slotId: past.id } });
    expect(hold.status).toBe(409);
    expect(hold.json.error).toBe('slot_in_past');
  });

  it('adds the schema and demo slots additively and idempotently, flagged as demo', async () => {
    const s = await boot();
    const db = s.running.store.db;
    ensurePlaySchema(db);
    ensurePlaySchema(db);
    const before = count(s, 'SELECT COUNT(*) AS n FROM court_availability');
    expect(before).toBeGreaterThan(0);
    expect(seedDemoSlots(db, START)).toBe(0);
    expect(count(s, 'SELECT COUNT(*) AS n FROM court_availability')).toBe(before);
    expect(count(s, "SELECT COUNT(*) AS n FROM court_availability WHERE demo = 1 AND source = 'demo' AND status = 'available'")).toBe(before);
    expect(count(s, 'SELECT COUNT(DISTINCT facility_id) AS n FROM court_availability')).toBe(3);
    const seeded = await slotsOf(s, '2030-06-01');
    expect(seeded.length).toBeGreaterThan(0);
    expect(seeded.every((x) => x.demo === true && Number.isInteger(x.priceVnd) && x.currency === 'VND')).toBe(true);
    // Seeding never rewrites a booked demo slot.
    const target = seeded[0];
    db.prepare("UPDATE court_availability SET status = 'unavailable' WHERE id = ?").run(target.id);
    seedDemoSlots(db, START);
    const row = db.prepare('SELECT status FROM court_availability WHERE id = ?').get(target.id) as { status: string };
    expect(row.status).toBe('unavailable');
  });
});
