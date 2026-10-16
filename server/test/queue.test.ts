import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type RunningApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { seedDemoQueue } from '../src/play/queue.js';
import { loadPlayConfig } from '../src/play/util.js';

const ADMIN = 'test-admin-token';
const START = Date.parse('2030-06-01T03:00:00Z'); // 10:00 venue time
const DAY = '2030-06-02';
const FACILITY = 'demo-facility';
const OTHER = 'demo-facility-binh-thanh';

type Started = { base: string; running: RunningApp; server: http.Server; clock: { now: number } };
const started: Started[] = [];

async function boot(seedDemo = false): Promise<Started> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'court-replay-queue-'));
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
  config.play = { now: () => clock.now, adminToken: ADMIN, seedDemoMatches: seedDemo };
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

async function call(s: Started, method: string, url: string, opts: { player?: string; admin?: boolean; body?: unknown } = {}) {
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

const db = (s: Started) => s.running.store.db;
const count = (s: Started, sql: string, ...args: (string | number)[]) => Number((db(s).prepare(sql).get(...args) as { n: number | bigint }).n);

async function makeSlot(s: Started, court = 'court-1') {
  const r = await call(s, 'POST', '/api/play/admin/slots', {
    admin: true,
    body: { facilityId: FACILITY, courtId: court, date: DAY, start: '10:00', end: '11:00', priceVnd: 160000 },
  });
  expect(r.status).toBe(201);
  return r.json.slot as { id: string };
}

async function setMode(s: Started, mode: string, extra: Record<string, unknown> = {}) {
  const r = await call(s, 'PUT', '/api/play/admin/queue/settings', {
    admin: true,
    body: { facilityId: FACILITY, mode, ...extra },
  });
  expect(r.status).toBe(200);
  expect(r.json.settings.mode).toBe(mode);
}

function setRatings(s: Started, pairs: [string, number][]) {
  const stmt = db(s).prepare('UPDATE players SET pir_rating = ? WHERE id = ?');
  for (const [id, rating] of pairs) stmt.run(rating, id);
}

async function join(s: Started, player: string, body: Record<string, unknown> = {}) {
  s.clock.now += 1000;
  return call(s, 'POST', '/api/play/queue/join', { player, body: { facilityId: FACILITY, ...body } });
}

async function joinMany(s: Started, players: string[]) {
  const ids: string[] = [];
  for (const player of players) {
    const r = await join(s, player);
    expect(r.status).toBe(201);
    ids.push(r.json.entry.id as string);
  }
  return ids;
}

async function courtReady(s: Started, slotId: string) {
  const r = await call(s, 'POST', '/api/play/admin/queue/court-ready', {
    admin: true,
    body: { facilityId: FACILITY, slotId },
  });
  expect(r.status).toBe(200);
  expect(r.json.offer?.id).toBeTruthy();
  return r;
}

async function offeredPlayers(s: Started): Promise<string[]> {
  const r = await call(s, 'GET', `/api/play/admin/queue?facilityId=${FACILITY}`, { admin: true });
  expect(r.status).toBe(200);
  return (r.json.entries as { playerId: string; status: string }[])
    .filter((e) => e.status === 'offered')
    .map((e) => e.playerId);
}

describe('smart queue', () => {
  it('keeps one active entry per player, from the app, a court QR, or staff', async () => {
    const s = await boot();
    expect((await call(s, 'POST', '/api/play/queue/join', { body: { facilityId: FACILITY } })).status).toBe(401);
    expect((await call(s, 'POST', '/api/play/admin/queue/court-ready', { body: { facilityId: FACILITY } })).status).toBe(403);

    const first = await join(s, 'demo-linh');
    expect(first.status).toBe(201);
    expect(first.json.entry.source).toBe('app');
    const again = await join(s, 'demo-linh');
    expect(again.status).toBe(200);
    expect(again.json.replayed).toBe(true);
    expect(again.json.entry.id).toBe(first.json.entry.id);
    const elsewhere = await call(s, 'POST', '/api/play/queue/join', {
      player: 'demo-linh',
      body: { facilityId: OTHER },
    });
    expect(elsewhere.status).toBe(409);
    expect(elsewhere.json.error).toBe('already_in_queue');

    expect(() =>
      db(s)
        .prepare(
          `INSERT INTO queue_entries (id, player_id, facility_id, joined_at, rating_snapshot, party_size, format, status, source, updated_at)
           VALUES ('qe-dup', 'demo-linh', ?, ?, 1300, 1, 'doubles', 'waiting', 'app', ?)`,
        )
        .run(FACILITY, new Date(START).toISOString(), new Date(START).toISOString()),
    ).toThrow(/UNIQUE/);
    expect(count(s, "SELECT COUNT(*) AS n FROM queue_entries WHERE player_id = 'demo-linh' AND status = 'waiting'")).toBe(1);

    expect((await join(s, 'demo-hung', { source: 'staff' })).status).toBe(400);
    expect((await join(s, 'demo-hung', { source: 'court_qr' })).json.error).toBe('court_required');
    const qr = await join(s, 'demo-hung', { source: 'court_qr', courtId: 'court-1' });
    expect(qr.status).toBe(201);
    expect(qr.json.entry.source).toBe('court_qr');
    expect(qr.json.entry.courtId).toBe('court-1');

    const staff = await call(s, 'POST', '/api/play/admin/queue/join', {
      admin: true,
      body: { playerId: 'demo-thao', facilityId: FACILITY },
    });
    expect(staff.status).toBe(201);
    expect(staff.json.entry.source).toBe('staff');
    const keyed = await call(s, 'POST', '/api/play/admin/queue/join', {
      admin: true,
      body: { playerId: 'demo-nam', facilityId: FACILITY, idempotencyKey: 'staff-key-abcdefgh' },
    });
    const keyedAgain = await call(s, 'POST', '/api/play/admin/queue/join', {
      admin: true,
      body: { playerId: 'demo-nam', facilityId: FACILITY, idempotencyKey: 'staff-key-abcdefgh' },
    });
    expect(keyed.status).toBe(201);
    expect(keyedAgain.status).toBe(200);
    expect(keyedAgain.json.entry.id).toBe(keyed.json.entry.id);
    expect(count(s, "SELECT COUNT(*) AS n FROM queue_entries WHERE status IN ('waiting', 'offered', 'confirmed')")).toBe(4);
  });

  it('cancels a waiting entry and releases an offered court', async () => {
    const s = await boot();
    await setMode(s, 'fifo');
    const first = await join(s, 'demo-linh');
    const id = first.json.entry.id as string;
    const cancelled = await call(s, 'POST', `/api/play/queue/${id}/cancel`, { player: 'demo-linh' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.entry.status).toBe('cancelled');
    expect(cancelled.json.replayed).toBe(false);
    const repeat = await call(s, 'POST', `/api/play/queue/${id}/cancel`, { player: 'demo-linh' });
    expect(repeat.json.replayed).toBe(true);
    expect((await call(s, 'POST', `/api/play/queue/${id}/cancel`, { player: 'demo-hung' })).status).toBe(403);

    const rejoined = await join(s, 'demo-linh');
    expect(rejoined.status).toBe(201);
    expect(rejoined.json.entry.id).not.toBe(id);

    await joinMany(s, ['demo-hung', 'demo-thao', 'demo-nam']);
    const slot = await makeSlot(s);
    await courtReady(s, slot.id);
    expect(await offeredPlayers(s)).toEqual(['demo-linh', 'demo-hung', 'demo-thao', 'demo-nam']);
    const left = await call(s, 'POST', `/api/play/queue/${rejoined.json.entry.id}/cancel`, { player: 'demo-linh' });
    expect(left.json.entry.status).toBe('cancelled');
    expect(count(s, "SELECT COUNT(*) AS n FROM queue_offers WHERE status = 'pending'")).toBe(0);
    const slotRow = db(s).prepare('SELECT status, booking_id FROM court_availability WHERE id = ?').get(slot.id) as {
      status: string;
      booking_id: string | null;
    };
    expect(slotRow).toEqual({ status: 'available', booking_id: null });
    expect(count(s, "SELECT COUNT(*) AS n FROM bookings")).toBe(0);
    expect(await offeredPlayers(s)).toEqual([]);
    const still = await call(s, 'GET', `/api/play/admin/queue?facilityId=${FACILITY}`, { admin: true });
    expect(still.json.entries.map((e: { playerId: string }) => e.playerId)).toEqual(['demo-hung', 'demo-thao', 'demo-nam']);
  });

  it('offers the court in join order under fifo', async () => {
    const s = await boot();
    await setMode(s, 'fifo');
    setRatings(s, [
      ['demo-linh', 1700],
      ['demo-hung', 1300],
      ['demo-thao', 1680],
      ['demo-nam', 1320],
      ['demo-trang', 1500],
    ]);
    await joinMany(s, ['demo-linh', 'demo-hung', 'demo-thao', 'demo-nam', 'demo-trang']);
    const slot = await makeSlot(s);
    const ready = await courtReady(s, slot.id);
    expect(await offeredPlayers(s)).toEqual(['demo-linh', 'demo-hung', 'demo-thao', 'demo-nam']);
    expect(ready.json.offer.reason).toMatch(/join order/);
    expect(ready.json.offer.group.map((g: { displayName: string }) => g.displayName)).toEqual([
      'Linh Ngô',
      'Hùng Trịnh',
      'Thảo Đặng',
      'Nam Phan',
    ]);
    const waiting = (await call(s, 'GET', '/api/play/queue/my', { player: 'demo-trang' })).json.entry;
    expect(waiting.status).toBe('waiting');
    expect(waiting.position).toBe(5);
  });

  it('groups the closest ratings under skill', async () => {
    const s = await boot();
    await setMode(s, 'skill', { skillBand: 0.5 });
    // Same spread on the low and high fours; the earlier high group wins the tie (policy places 2, 3, 5, 7).
    setRatings(s, [
      ['demo-linh', 1300],
      ['demo-hung', 1700],
      ['demo-thao', 1650],
      ['demo-nam', 1350],
      ['demo-trang', 1700],
      ['demo-duc', 1300],
      ['demo-phuong', 1700],
      ['demo-vy', 1300],
    ]);
    await joinMany(s, ['demo-linh', 'demo-hung', 'demo-thao', 'demo-nam', 'demo-trang', 'demo-duc', 'demo-phuong', 'demo-vy']);
    const ready = await courtReady(s, (await makeSlot(s)).id);
    expect(await offeredPlayers(s)).toEqual(['demo-hung', 'demo-thao', 'demo-trang', 'demo-phuong']);
    expect(ready.json.offer.reason).toMatch(/closest rating/);
  });

  it('skips ahead under hybrid only within the documented limit', async () => {
    const s = await boot();
    const initial = await call(s, 'GET', `/api/play/admin/queue/settings?facilityId=${FACILITY}`, { admin: true });
    expect(initial.json.settings.mode).toBe('hybrid');
    expect(initial.json.settings.maxBypass).toBe(3);
    // Join order a b c d e f. In-order group spans 1.5; a c d e spans 0.2 and passes b by 3 later players.
    const ratings: [string, number][] = [
      ['demo-linh', 1400],
      ['demo-hung', 1700],
      ['demo-thao', 1420],
      ['demo-nam', 1440],
      ['demo-trang', 1410],
      ['demo-duc', 1680],
    ];
    const players = ratings.map(([id]) => id);
    setRatings(s, ratings);
    await setMode(s, 'hybrid', { maxBypass: 3, minSkillGain: 0.3, skillBand: 0.5 });
    await joinMany(s, players);
    const skipped = await courtReady(s, (await makeSlot(s)).id);
    expect(await offeredPlayers(s)).toEqual(['demo-linh', 'demo-thao', 'demo-nam', 'demo-trang']);
    expect(skipped.json.offer.reason).toMatch(/nobody waits behind more than 3 later players/);

    const tight = await boot();
    setRatings(tight, ratings);
    await setMode(tight, 'hybrid', { maxBypass: 2, minSkillGain: 0.3, skillBand: 0.5 });
    await joinMany(tight, players);
    const kept = await courtReady(tight, (await makeSlot(tight)).id);
    expect(await offeredPlayers(tight)).toEqual(['demo-linh', 'demo-hung', 'demo-thao', 'demo-nam']);
    expect(kept.json.offer.reason).toMatch(/join order/);
  });

  it('moves the court to the next group on decline or timeout', async () => {
    const s = await boot();
    await setMode(s, 'fifo');
    await joinMany(s, ['demo-linh', 'demo-hung', 'demo-thao', 'demo-nam', 'demo-trang']);
    const slot = await makeSlot(s);
    const ready = await courtReady(s, slot.id);
    const declined = await call(s, 'POST', `/api/play/queue/offers/${ready.json.offer.id}/decline`, { player: 'demo-hung' });
    expect(declined.status).toBe(200);
    expect(declined.json.replayed).toBe(false);
    expect((await call(s, 'GET', '/api/play/queue/my', { player: 'demo-hung' })).json.entry.status).toBe('declined');
    expect(await offeredPlayers(s)).toEqual(['demo-linh', 'demo-thao', 'demo-nam', 'demo-trang']);
    expect(count(s, "SELECT COUNT(*) AS n FROM queue_offers WHERE status = 'pending'")).toBe(1);
    expect(count(s, "SELECT COUNT(*) AS n FROM queue_offers WHERE status = 'declined'")).toBe(1);

    const later = await boot();
    await setMode(later, 'fifo');
    const eight = ['demo-linh', 'demo-hung', 'demo-thao', 'demo-nam', 'demo-trang', 'demo-duc', 'demo-phuong', 'demo-vy'];
    await joinMany(later, eight);
    const laterSlot = await makeSlot(later);
    await courtReady(later, laterSlot.id);
    later.clock.now += 121_000;
    const expired = await call(later, 'GET', '/api/play/queue/my', { player: 'demo-linh' });
    expect(expired.json.entry.status).toBe('expired');
    expect(expired.json.entry.message).toMatch(/expired/);
    expect(await offeredPlayers(later)).toEqual(['demo-trang', 'demo-duc', 'demo-phuong', 'demo-vy']);
    expect(count(later, "SELECT COUNT(*) AS n FROM queue_offers WHERE status = 'expired'")).toBe(1);
    expect(count(later, "SELECT COUNT(*) AS n FROM queue_offers WHERE status = 'pending'")).toBe(1);
    expect(count(later, 'SELECT COUNT(*) AS n FROM bookings')).toBe(0);
    const held = db(later).prepare('SELECT status FROM court_availability WHERE id = ?').get(laterSlot.id) as { status: string };
    expect(held.status).toBe('queue_managed');
  });

  it('creates exactly one booking when the group accepts together', async () => {
    const s = await boot();
    await setMode(s, 'fifo');
    const players = ['demo-linh', 'demo-hung', 'demo-thao', 'demo-nam'];
    await joinMany(s, players);
    const slot = await makeSlot(s);
    const ready = await courtReady(s, slot.id);
    const offerId = ready.json.offer.id as string;
    expect((await call(s, 'POST', `/api/play/queue/offers/${offerId}/accept`, { player: 'demo-duc' })).status).toBe(403);

    const results = await Promise.all(
      players.map((player) => call(s, 'POST', `/api/play/queue/offers/${offerId}/accept`, { player })),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(count(s, "SELECT COUNT(*) AS n FROM bookings")).toBe(1);
    expect(count(s, "SELECT COUNT(*) AS n FROM bookings WHERE status = 'confirmed'")).toBe(1);
    expect(count(s, "SELECT COUNT(*) AS n FROM booking_participants WHERE status = 'joined'")).toBe(4);
    expect(count(s, "SELECT COUNT(*) AS n FROM queue_entries WHERE status = 'assigned'")).toBe(4);
    expect(count(s, "SELECT COUNT(*) AS n FROM queue_offers WHERE status = 'accepted'")).toBe(1);

    const bookingId = (db(s).prepare('SELECT id FROM bookings').get() as { id: string }).id;
    const view = await call(s, 'GET', `/api/play/bookings/${bookingId}`, { player: 'demo-nam' });
    expect(view.status).toBe(200);
    expect(view.json.booking.status).toBe('confirmed');
    expect(view.json.booking.slotId).toBe(slot.id);
    expect(view.json.booking.payment).toMatchObject({ method: 'pay_at_facility', processed: false });
    expect(view.json.booking.participants).toHaveLength(4);
    expect(view.json.booking.history.map((h: { to: string }) => h.to)).toEqual(['held', 'confirmed']);
    const slotRow = db(s).prepare('SELECT status, booking_id FROM court_availability WHERE id = ?').get(slot.id) as {
      status: string;
      booking_id: string;
    };
    expect(slotRow).toEqual({ status: 'booked', booking_id: bookingId });

    const replay = await call(s, 'POST', `/api/play/queue/offers/${offerId}/accept`, { player: 'demo-linh' });
    expect(replay.json.replayed).toBe(true);
    expect(count(s, 'SELECT COUNT(*) AS n FROM bookings')).toBe(1);
  });

  it('writes an audit row for every queue decision', async () => {
    const s = await boot();
    await setMode(s, 'fifo');
    const [entryId] = await joinMany(s, ['demo-linh', 'demo-hung', 'demo-thao', 'demo-nam']);
    const ready = await courtReady(s, (await makeSlot(s)).id);
    const offerId = ready.json.offer.id as string;
    for (const player of ['demo-hung', 'demo-thao', 'demo-nam', 'demo-linh']) {
      expect((await call(s, 'POST', `/api/play/queue/offers/${offerId}/accept`, { player })).status).toBe(200);
    }
    const listed = await call(s, 'GET', `/api/play/admin/queue/audit?facilityId=${FACILITY}&entryId=${entryId}`, { admin: true });
    expect(listed.status).toBe(200);
    const mine = listed.json.audit as { event: string; from: string | null; to: string | null; actor: string }[];
    expect(mine.map((row) => `${row.from}>${row.to}:${row.event}`)).toEqual([
      'null>waiting:joined',
      'waiting>offered:offered',
      'offered>confirmed:accepted',
      'confirmed>assigned:assigned',
    ]);
    expect(mine[0].actor).toBe('player:demo-linh');
    expect(mine[1].actor).toBe('admin');
    expect(mine[2].actor).toBe('player:demo-linh');

    const all = await call(s, 'GET', `/api/play/admin/queue/audit?facilityId=${FACILITY}`, { admin: true });
    const events = (all.json.audit as { event: string }[]).map((row) => row.event);
    for (const event of ['settings_changed', 'joined', 'court_ready', 'offer_created', 'offered', 'accepted', 'assigned', 'offer_accepted']) {
      expect(events).toContain(event);
    }
    expect((await call(s, 'GET', `/api/play/admin/queue/audit?facilityId=${FACILITY}`)).status).toBe(403);
  });

  it('shows display name and rating on the public board, and does not invent a wait', async () => {
    const s = await boot();
    await joinMany(s, ['demo-linh', 'demo-hung']);
    const board = await call(s, 'GET', `/api/play/queue/status?facilityId=${FACILITY}`);
    expect(board.status).toBe(200);
    expect(board.json.waitingPlayers).toBe(2);
    expect(board.json.waitingEntries).toBe(2);
    expect(board.json.estimate).toEqual({
      status: 'not_available_yet',
      waitMinutes: null,
      note: 'Not enough completed waits here yet to estimate. We will not guess.',
    });
    expect(board.json.queue).toEqual([
      { position: 1, displayName: 'Linh Ngô', level: 2.5, partySize: 1, state: 'waiting' },
      { position: 2, displayName: 'Hùng Trịnh', level: 2.8, partySize: 1, state: 'waiting' },
    ]);
    expect(board.json.alternatives.map((a: { facilityId: string; waitingPlayers: number }) => [a.facilityId, a.waitingPlayers])).toEqual([
      ['demo-facility-binh-thanh', 0],
      ['demo-facility-quan-7', 0],
    ]);
    const text = JSON.stringify(board.json);
    for (const id of ['demo-linh', 'demo-hung', 'playerId', 'phone', 'email', 'zalo']) expect(text).not.toContain(id);
    expect(board.json.you).toBeUndefined();

    const mine = await call(s, 'GET', `/api/play/queue/status?facilityId=${FACILITY}`, { player: 'demo-linh' });
    expect(JSON.stringify(mine.json)).not.toContain('demo-hung');
    expect(JSON.stringify(mine.json)).not.toContain('demo-linh');
    expect(mine.json.you.position).toBe(1);
    expect(mine.json.you.offer).toBeNull();

    const insert = db(s).prepare(
      `INSERT INTO queue_entries (id, player_id, facility_id, joined_at, rating_snapshot, party_size, format, status, source, demo, updated_at)
       VALUES (?, ?, ?, ?, 1500, 1, 'doubles', 'assigned', 'app', 0, ?)`,
    );
    for (const [i, player] of ['demo-minh', 'demo-lan', 'demo-an', 'demo-khoa', 'demo-ha'].entries()) {
      const minutes = (i + 1) * 10;
      insert.run(`est-${i}`, player, FACILITY, new Date(START).toISOString(), new Date(START + minutes * 60_000).toISOString());
    }
    const estimated = await call(s, 'GET', `/api/play/queue/status?facilityId=${FACILITY}`);
    expect(estimated.json.estimate.status).toBe('estimated');
    expect(estimated.json.estimate.waitMinutes).toBeNull();
    expect(estimated.json.estimate.typicalMinutes).toEqual({ low: 20, high: 40 });
    expect(estimated.json.estimate.note).toMatch(/not a promise/);
    expect(estimated.json.estimate.note).not.toMatch(/exactly \d+ minutes/);
  });

  it('seeds the demo queue once', async () => {
    const s = await boot(true);
    expect(count(s, "SELECT COUNT(*) AS n FROM queue_entries WHERE demo = 1 AND status = 'waiting'")).toBe(6);
    expect(count(s, 'SELECT COUNT(*) AS n FROM queue_settings')).toBeGreaterThan(0);
    const cfg = { ...loadPlayConfig(), now: () => s.clock.now, adminToken: ADMIN };
    expect(seedDemoQueue(db(s), cfg)).toBe(0);
    expect(count(s, "SELECT COUNT(*) AS n FROM queue_entries WHERE demo = 1")).toBe(6);
    expect(count(s, "SELECT COUNT(*) AS n FROM queue_entries WHERE player_id = 'demo-bao' AND status = 'waiting'")).toBe(1);
  });
});
