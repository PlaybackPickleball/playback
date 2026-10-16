import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type RunningApp } from '../src/app.js';
import { resetDemo } from '../src/club.js';
import { loadConfig } from '../src/config.js';
import { seedPromotionRules } from '../src/play/fillSchema.js';

const ADMIN = 'test-admin-token';
const START = Date.parse('2030-06-01T03:00:00Z'); // 10:00 venue time
const DAY = '2030-06-02';
const FACILITY = 'demo-facility';
const HOST = 'demo-minh';

type Started = { base: string; running: RunningApp; server: http.Server };
const started: Started[] = [];

async function boot(): Promise<Started> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'court-replay-fill-'));
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
  config.play = { now: () => START, adminToken: ADMIN, holdTtlSeconds: 300, staleMinutes: 15, seedDemoMatches: false };
  const running = createApp(config);
  const server = http.createServer(running.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const item = { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, running, server };
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
  return { status: response.status, json: (text ? JSON.parse(text) : {}) as any };
}

const dbOf = (s: Started) => s.running.store.db;
const num = (db: DatabaseSync, sql: string, ...args: string[]) => Number((db.prepare(sql).get(...args) as { n: number | bigint }).n);

function priceWithin(normal: number, percent: number) {
  return normal - Math.floor((normal * percent) / 100);
}

const rules = (extra: Record<string, unknown>) => ({
  facilityId: FACILITY,
  enabled: true,
  normalPriceVnd: 170_000,
  promoPriceVnd: priceWithin(170_000, 20),
  maxDiscountPercent: 20,
  promotableStart: '17:00',
  promotableEnd: '21:00',
  ...extra,
});

async function vacantAt(s: Started, start: string, courtId = 'court-1') {
  const listed = await call(s, 'GET', `/api/play/admin/smart-fill/vacant-slots?facilityId=${FACILITY}`, { admin: true });
  expect(listed.status).toBe(200);
  const slot = (listed.json.slots as { id: string; start: string; courtId: string; date: string; priceVnd: number; demo: boolean }[]).find(
    (item) => item.date === DAY && item.start === start && item.courtId === courtId,
  );
  expect(slot?.demo).toBe(true);
  return slot!;
}

describe('smart court fill', () => {
  it('keeps a disabled feature from publishing, including after disable', async () => {
    const s = await boot();
    const db = dbOf(s);
    const seeded = await call(s, 'GET', `/api/play/admin/smart-fill/settings?facilityId=${FACILITY}`, { admin: true });
    expect(seeded.json.settings).toMatchObject({
      enabled: false,
      demo: true,
      normalPriceVnd: 150_000,
      promoPriceVnd: 120_000,
      maxDiscountPercent: 20,
      promotableStart: '17:00',
      promotableEnd: '21:00',
    });
    const slot = await vacantAt(s, '18:00');
    const before = num(db, 'SELECT COUNT(*) AS n FROM bookings');
    const saved = await call(s, 'PUT', '/api/play/admin/smart-fill/settings', {
      admin: true,
      body: rules({ normalPriceVnd: slot.priceVnd, promoPriceVnd: priceWithin(slot.priceVnd, 20) }),
    });
    expect(saved.status).toBe(200);
    const turnedOff = await call(s, 'POST', '/api/play/admin/smart-fill/disable', { admin: true, body: { facilityId: FACILITY } });
    expect(turnedOff.json.settings.enabled).toBe(false);
    const published = await call(s, 'POST', '/api/play/admin/smart-fill/publish', {
      admin: true,
      body: { slotId: slot.id, hostPlayerId: HOST },
    });
    expect(published.status).toBe(409);
    expect(published.json.error).toBe('smart_fill_disabled');
    expect(num(db, 'SELECT COUNT(*) AS n FROM bookings')).toBe(before);
    expect(num(db, 'SELECT price_vnd AS n FROM court_availability WHERE id = ?', slot.id)).toBe(slot.priceVnd);
  });

  it('rejects a promo price past the owner cap', async () => {
    const s = await boot();
    const db = dbOf(s);
    const slot = await vacantAt(s, '18:00');
    const saved = await call(s, 'PUT', '/api/play/admin/smart-fill/settings', {
      admin: true,
      body: rules({ normalPriceVnd: slot.priceVnd, promoPriceVnd: Math.floor(slot.priceVnd / 2), maxDiscountPercent: 10 }),
    });
    expect(saved.status).toBe(200);
    const before = num(db, 'SELECT COUNT(*) AS n FROM bookings');
    const published = await call(s, 'POST', '/api/play/admin/smart-fill/publish', {
      admin: true,
      body: { slotId: slot.id, hostPlayerId: HOST },
    });
    expect(published.status).toBe(409);
    expect(published.json.error).toBe('discount_exceeds_max');
    expect(num(db, 'SELECT COUNT(*) AS n FROM bookings')).toBe(before);
    expect(num(db, 'SELECT price_vnd AS n FROM court_availability WHERE id = ?', slot.id)).toBe(slot.priceVnd);
  });

  it('rejects a slot outside the promotable hours', async () => {
    const s = await boot();
    const db = dbOf(s);
    const created = await call(s, 'POST', '/api/play/admin/slots', {
      admin: true,
      body: { facilityId: FACILITY, courtId: 'court-4', date: DAY, start: '10:00', end: '11:00', priceVnd: 170_000 },
    });
    expect(created.status).toBe(201);
    await call(s, 'PUT', '/api/play/admin/smart-fill/settings', { admin: true, body: rules({}) });
    const before = num(db, 'SELECT COUNT(*) AS n FROM bookings');
    const published = await call(s, 'POST', '/api/play/admin/smart-fill/publish', {
      admin: true,
      body: { slotId: created.json.slot.id, hostPlayerId: HOST },
    });
    expect(published.status).toBe(409);
    expect(published.json.error).toBe('outside_promotable_hours');
    expect(num(db, 'SELECT COUNT(*) AS n FROM bookings')).toBe(before);
  });

  it('approved join creates one booking and reject does not', async () => {
    const s = await boot();
    const db = dbOf(s);
    const slotA = await vacantAt(s, '18:00');
    const slotB = await vacantAt(s, '19:00');
    const promo = priceWithin(slotA.priceVnd, 20);
    expect(slotB.priceVnd).toBe(slotA.priceVnd);
    await call(s, 'PUT', '/api/play/admin/smart-fill/settings', {
      admin: true,
      body: rules({ normalPriceVnd: slotA.priceVnd, promoPriceVnd: promo }),
    });

    const ratings = (id: string) =>
      db.prepare('SELECT pir_rating AS pir, matches_played AS played FROM players WHERE id = ?').get(id) as {
        pir: number | bigint;
        played: number | bigint;
      };
    const beforeLan = ratings('demo-lan');
    const beforeAn = ratings('demo-an');
    const history = () => num(db, "SELECT COUNT(*) AS n FROM rating_history WHERE player_id IN ('demo-lan', 'demo-an', 'demo-minh')");
    const historyBefore = history();

    const publishedA = await call(s, 'POST', '/api/play/admin/smart-fill/publish', {
      admin: true,
      body: { slotId: slotA.id, hostPlayerId: HOST },
    });
    expect(publishedA.status).toBe(201);
    expect(publishedA.json.promoPriceVnd).toBe(promo);
    expect(publishedA.json.match.demo).toBe(true);
    expect(publishedA.json.match.pricePerPlayerVnd).toBe(Math.ceil(promo / 4 / 5000) * 5000);
    expect(num(db, 'SELECT price_vnd AS n FROM bookings WHERE id = ?', publishedA.json.bookingId)).toBe(promo);
    expect(num(db, 'SELECT price_vnd AS n FROM court_availability WHERE id = ?', slotA.id)).toBe(slotA.priceVnd);
    expect(num(db, 'SELECT incremental AS n FROM revenue_attributions WHERE booking_id = ?', publishedA.json.bookingId)).toBe(1);

    const early = await call(s, 'POST', `/api/play/open-matches/${publishedA.json.match.id}/join`, { player: 'demo-lan' });
    expect(early.status).toBe(409);
    expect(early.json.error).toBe('approval_required');

    const requestA = await call(s, 'POST', '/api/play/smart-fill/requests', {
      player: 'demo-lan',
      body: { openMatchId: publishedA.json.match.id },
    });
    expect(requestA.status).toBe(201);
    const approved = await call(s, 'POST', `/api/play/admin/smart-fill/requests/${requestA.json.request.id}/approve`, { admin: true });
    expect(approved.status).toBe(200);
    expect(approved.json.request.status).toBe('approved');
    expect(approved.json.match.participants.map((p: { playerId: string }) => p.playerId)).toContain('demo-lan');
    expect(num(db, 'SELECT COUNT(*) AS n FROM bookings WHERE slot_id = ?', slotA.id)).toBe(1);
    expect(num(db, "SELECT COUNT(*) AS n FROM booking_participants WHERE player_id = 'demo-lan' AND status = 'joined'")).toBe(1);

    const again = await call(s, 'POST', `/api/play/open-matches/${publishedA.json.match.id}/join`, { player: 'demo-lan' });
    expect(again.status).toBe(200);
    expect(num(db, 'SELECT COUNT(*) AS n FROM bookings WHERE slot_id = ?', slotA.id)).toBe(1);

    const publishedB = await call(s, 'POST', '/api/play/admin/smart-fill/publish', {
      admin: true,
      body: { slotId: slotB.id, hostPlayerId: HOST },
    });
    expect(publishedB.status).toBe(201);
    const requestB = await call(s, 'POST', '/api/play/smart-fill/requests', {
      player: 'demo-an',
      body: { openMatchId: publishedB.json.match.id },
    });
    const bookingsBeforeReject = num(db, 'SELECT COUNT(*) AS n FROM bookings');
    const rejected = await call(s, 'POST', `/api/play/admin/smart-fill/requests/${requestB.json.request.id}/reject`, { admin: true });
    expect(rejected.json.request.status).toBe('rejected');
    expect(num(db, 'SELECT COUNT(*) AS n FROM bookings')).toBe(bookingsBeforeReject);
    expect(num(db, 'SELECT COUNT(*) AS n FROM bookings WHERE slot_id = ?', slotB.id)).toBe(1);
    expect(num(db, "SELECT COUNT(*) AS n FROM booking_participants WHERE player_id = 'demo-an'")).toBe(0);

    expect(ratings('demo-lan')).toEqual(beforeLan);
    expect(ratings('demo-an')).toEqual(beforeAn);
    expect(history()).toBe(historyBefore);
    const stillListed = await vacantAt(s, '17:00');
    expect(stillListed.demo).toBe(true);
    const gone = await call(s, 'GET', `/api/play/admin/smart-fill/vacant-slots?facilityId=${FACILITY}`, { admin: true });
    expect((gone.json.slots as { id: string }[]).some((item) => item.id === slotA.id)).toBe(false);
  });

  it('summarizes stored attribution rows and leaves ordinary Playback bookings non-incremental', async () => {
    const s = await boot();
    const db = dbOf(s);
    const plain = await call(s, 'POST', '/api/play/admin/slots', {
      admin: true,
      body: { facilityId: FACILITY, courtId: 'court-4', date: DAY, start: '12:00', end: '13:00', priceVnd: 200_000 },
    });
    const booked = await call(s, 'POST', '/api/play/bookings', {
      player: 'demo-khoa',
      body: { slotId: plain.json.slot.id, idempotencyKey: 'plain-booking-key' },
    });
    expect(booked.status).toBe(201);
    expect(num(db, 'SELECT incremental AS n FROM revenue_attributions WHERE booking_id = ?', booked.json.booking.id)).toBe(0);

    const slot = await vacantAt(s, '18:00');
    const promo = priceWithin(slot.priceVnd, 20);
    await call(s, 'PUT', '/api/play/admin/smart-fill/settings', {
      admin: true,
      body: rules({ normalPriceVnd: slot.priceVnd, promoPriceVnd: promo }),
    });
    const published = await call(s, 'POST', '/api/play/admin/smart-fill/publish', {
      admin: true,
      body: { slotId: slot.id, hostPlayerId: HOST },
    });
    expect(published.status).toBe(201);

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO bookings (id, facility_id, court_id, slot_id, start, end, status, price_vnd, created_by_player, origin, created_at, updated_at)
       VALUES ('bk-facility-desk', ?, 'court-5', NULL, '2030-06-02T08:00', '2030-06-02T09:00', 'confirmed', 80000, 'demo-ha', 'facility', ?, ?)`,
    ).run(FACILITY, now, now);
    db.prepare(
      `INSERT INTO revenue_attributions (booking_id, facility_id, origin, amount_vnd, incremental, demo, created_at)
       VALUES ('bk-facility-desk', ?, 'facility', 80000, 0, 0, ?)`,
    ).run(FACILITY, now);

    const stored = db
      .prepare(
        `SELECT
           COALESCE(SUM(amount_vnd), 0) AS gross,
           COALESCE(SUM(CASE WHEN origin = 'playback' THEN amount_vnd ELSE 0 END), 0) AS playback,
           COALESCE(SUM(CASE WHEN incremental = 1 THEN amount_vnd ELSE 0 END), 0) AS incremental
         FROM revenue_attributions WHERE facility_id = ?`,
      )
      .get(FACILITY) as { gross: number | bigint; playback: number | bigint; incremental: number | bigint };
    const summary = await call(s, 'GET', `/api/play/admin/smart-fill/summary?facilityId=${FACILITY}`, { admin: true });
    expect(summary.json.summary).toEqual({
      facilityId: FACILITY,
      grossBookingValueVnd: Number(stored.gross),
      playbackOriginatedVnd: Number(stored.playback),
      estimatedIncrementalVnd: Number(stored.incremental),
      currency: 'VND',
    });
    expect(Number(stored.playback)).toBeGreaterThan(Number(stored.incremental));
    expect(Number(stored.incremental)).toBe(promo);
    expect(num(db, "SELECT COUNT(*) AS n FROM revenue_attributions WHERE origin = 'playback' AND incremental = 1")).toBe(1);
  });

  it('demo reset does not delete real bookings', async () => {
    const s = await boot();
    const db = dbOf(s);
    expect(seedPromotionRules(db, new Date().toISOString())).toBe(0);
    expect(num(db, 'SELECT COUNT(*) AS n FROM promotion_rules WHERE demo = 1')).toBe(3);
    expect(num(db, 'SELECT COUNT(*) AS n FROM promotion_rules WHERE demo = 1 AND enabled = 1')).toBe(0);

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO players (id, display_name, language, pir_rating, wins, losses, matches_played, demo, guest, created_at, updated_at)
       VALUES ('guest-real', 'Real Person', 'en', 1555, 3, 2, 5, 0, 1, ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO facilities (id, name, latitude, longitude, demo, created_at) VALUES ('real-club', 'Real Club', 10.8, 106.7, 0, ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO promotion_rules (
         facility_id, enabled, normal_price_vnd, promo_price_vnd, max_discount_percent, promotable_start, promotable_end, demo, updated_at
       ) VALUES ('real-club', 1, 200000, 180000, 20, '17:00', '21:00', 0, ?)`,
    ).run(now);
    db.prepare('UPDATE promotion_rules SET enabled = 1 WHERE facility_id = ? AND demo = 1').run(FACILITY);
    db.prepare(
      `INSERT INTO sessions (id, public_token, court_id, mode, status, team_a_json, team_b_json, consent_at, created_at, updated_at)
       VALUES ('s-real', 'tok-real', 'court-1', 'singles', 'ready', '[]', '[]', ?, ?, ?)`,
    ).run(now, now, now);
    db.prepare(
      `INSERT INTO bookings (id, facility_id, court_id, slot_id, start, end, status, price_vnd, created_by_player, origin, created_at, updated_at)
       VALUES ('bk-real', ?, 'court-4', NULL, '2030-06-02T08:00', '2030-06-02T09:00', 'confirmed', 500000, 'guest-real', 'facility', ?, ?)`,
    ).run(FACILITY, now, now);
    db.prepare(
      `INSERT INTO revenue_attributions (booking_id, facility_id, origin, amount_vnd, incremental, demo, created_at)
       VALUES ('bk-real', ?, 'facility', 500000, 0, 0, ?)`,
    ).run(FACILITY, now);

    expect(resetDemo(db)).toEqual({ ok: true, recordingsKept: true });

    expect(num(db, "SELECT COUNT(*) AS n FROM bookings WHERE id = 'bk-real'")).toBe(1);
    expect(num(db, "SELECT amount_vnd AS n FROM revenue_attributions WHERE booking_id = 'bk-real'")).toBe(500000);
    expect(num(db, "SELECT COUNT(*) AS n FROM sessions WHERE id = 's-real'")).toBe(1);
    expect(num(db, "SELECT pir_rating AS n FROM players WHERE id = 'guest-real'")).toBe(1555);
    const realRule = db.prepare('SELECT enabled, promo_price_vnd, demo FROM promotion_rules WHERE facility_id = ?').get('real-club') as {
      enabled: number | bigint;
      promo_price_vnd: number | bigint;
      demo: number | bigint;
    };
    expect(Number(realRule.enabled)).toBe(1);
    expect(Number(realRule.promo_price_vnd)).toBe(180000);
    expect(Number(realRule.demo)).toBe(0);
    expect(num(db, 'SELECT enabled AS n FROM promotion_rules WHERE facility_id = ?', FACILITY)).toBe(0);
  });
});
