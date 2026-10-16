import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type RunningApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { seedDemoOpenMatches } from '../src/play/openMatches.js';

const ADMIN = 'test-admin-token';
const START = Date.parse('2030-06-01T03:00:00Z'); // 10:00 venue time, 2030-06-01
const MAIN = 'demo-facility';

type Started = { base: string; running: RunningApp; server: http.Server; clock: { now: number }; cfg: any };
const started: Started[] = [];

async function boot(): Promise<Started> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'court-replay-om-'));
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
  config.play = { now: () => clock.now, adminToken: ADMIN, holdTtlSeconds: 300, staleMinutes: 15, openMatchHoldSeconds: 1800, inviteTtlSeconds: 1800 };
  const running = createApp(config);
  const server = http.createServer(running.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const item = { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, running, server, clock, cfg: config.play };
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
  const response = await fetch(`${s.base}${url}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await response.text();
  return { status: response.status, text, json: (text ? JSON.parse(text) : {}) as any };
}

const db = (s: Started) => s.running.store.db;
const count = (s: Started, sql: string, ...args: string[]) => Number((db(s).prepare(sql).get(...args) as { n: number | bigint }).n);
const search = (s: Started, player: string, body: Record<string, unknown> = {}) => call(s, 'POST', '/api/play/search', { player, body });
const demoMatch = (s: Started, key: string) =>
  db(s).prepare("SELECT * FROM open_matches WHERE id LIKE ?").get(`demo-om-${key}-%`) as { id: string; booking_id: string; slot_id: string };
const slotAt = (s: Started, court: string, start: string, date = '2030-06-01') =>
  (db(s).prepare('SELECT id FROM court_availability WHERE court_id = ? AND date = ? AND start = ?').get(court, date, start) as { id: string }).id;
const ratings = (s: Started, ids: string[]) =>
  db(s).prepare(`SELECT id, pir_rating, wins, losses, matches_played FROM players WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids);

describe('Play Now open matches', () => {
  it('seeds three demo open matches once, flagged demo, with players opted in', async () => {
    const s = await boot();
    expect(count(s, 'SELECT COUNT(*) AS n FROM open_matches WHERE demo = 1')).toBe(3);
    expect(count(s, 'SELECT COUNT(*) AS n FROM open_matches WHERE demo = 0')).toBe(0);
    const bt = demoMatch(s, 'bt');
    expect(count(s, "SELECT COUNT(*) AS n FROM booking_participants WHERE booking_id = ? AND status = 'joined'", bt.booking_id)).toBe(3);
    const row = db(s).prepare('SELECT * FROM open_matches WHERE id = ?').get(bt.id) as any;
    expect([row.min_level, row.max_level, Number(row.price_per_player_vnd), row.format]).toEqual([3.0, 3.5, 45000, 'doubles']);
    expect(count(s, 'SELECT COUNT(*) AS n FROM player_preferences WHERE match_invite_opt_in = 1')).toBe(20);
    expect(seedDemoOpenMatches(db(s), { ...s.cfg, now: () => START })).toBe(0);
    expect(count(s, 'SELECT COUNT(*) AS n FROM open_matches')).toBe(3);
    expect(count(s, 'SELECT COUNT(*) AS n FROM bookings')).toBe(3);
  });

  it('filters join_existing by radius, and widening the radius changes the results', async () => {
    const s = await boot();
    const narrow = await search(s, 'demo-minh');
    expect(narrow.status).toBe(200);
    const ids = (r: any) => r.json.categories.join_existing.map((x: any) => x.match.facilityId).sort();
    expect(ids(narrow)).toEqual(['demo-facility', 'demo-facility-binh-thanh']);
    expect(narrow.json.filteredOut.outside_radius).toBeGreaterThanOrEqual(1);
    expect(narrow.json.query.radiusKm).toBe(5);
    const wide = await search(s, 'demo-minh', { radiusKm: 10 });
    expect(ids(wide)).toEqual(['demo-facility', 'demo-facility-binh-thanh', 'demo-facility-quan-7']);
    const first = narrow.json.categories.join_existing[0];
    expect(first.explanation).toMatch(/estimates, not guarantees/);
    for (const key of ['skill', 'schedule', 'distance', 'reliability']) expect(typeof first.factors[key].score).toBe('number');
  });

  it('returns three categories, and join_queue uses the real queue length with no invented wait', async () => {
    const s = await boot();
    const r = await search(s, 'demo-minh');
    expect(Object.keys(r.json.categories)).toEqual(['join_existing', 'build_my_game', 'join_queue']);
    const q = r.json.categories.join_queue;
    expect(q.map((x: any) => x.facilityId)).toEqual(['demo-facility', 'demo-facility-binh-thanh']);
    const byId = Object.fromEntries(q.map((x: any) => [x.facilityId, x]));
    // The demo seed places six waiting players at the main club and nobody at Bình Thạnh.
    expect(byId['demo-facility'].activeQueueLength).toBe(6);
    expect(byId['demo-facility-binh-thanh'].activeQueueLength).toBe(0);
    for (const f of q) {
      expect(f.estimate).toMatchObject({ status: 'not_available_yet', waitMinutes: null });
      expect(f.estimate.typicalMinutes).toBeUndefined();
    }
    expect(r.json.categories.build_my_game.length).toBeGreaterThan(0);
    const entry = r.json.categories.build_my_game[0];
    expect(entry.suggestedMatch).toMatchObject({ format: 'doubles', capacity: 4, seatsToFill: 3 });
    expect(entry.candidates.length).toBeGreaterThan(0);
    for (const c of entry.candidates) {
      expect(Object.keys(c).sort()).toEqual(['displayName', 'distanceKm', 'explanation', 'factors', 'level', 'playerId', 'provisional', 'score', 'warnings']);
    }
  });

  it('excludes opted-out and busy players from build_my_game candidates but keeps beginners', async () => {
    const s = await boot();
    const all = (r: any) => r.json.categories.build_my_game.flatMap((e: any) => e.candidates.map((c: any) => ({ id: c.playerId, start: e.slot.start })));
    const before = all(await search(s, 'demo-minh', { candidateLimit: 20 }));
    expect(before.some((c: any) => c.id === 'demo-hung')).toBe(true); // brand new beginner (0 matches) stays in
    expect(before.some((c: any) => c.id === 'demo-minh')).toBe(false); // never the searcher

    // Opt out: gone everywhere.
    expect((await call(s, 'PUT', '/api/play/preferences', { player: 'demo-hung', body: { matchInviteOptIn: false } })).status).toBe(200);
    expect(all(await search(s, 'demo-minh', { candidateLimit: 20 })).some((c: any) => c.id === 'demo-hung')).toBe(false);
    await call(s, 'PUT', '/api/play/preferences', { player: 'demo-hung', body: { matchInviteOptIn: true, availability: { optedIn: false } } });
    expect(all(await search(s, 'demo-minh', { candidateLimit: 20 })).some((c: any) => c.id === 'demo-hung')).toBe(false);
    await call(s, 'PUT', '/api/play/preferences', { player: 'demo-hung', body: { availability: { optedIn: true } } });
    expect(all(await search(s, 'demo-minh', { candidateLimit: 20 })).some((c: any) => c.id === 'demo-hung')).toBe(true);

    // Busy: a booking at 17:00 removes demo-hung from 17:00 only.
    const book = await call(s, 'POST', '/api/play/bookings', { player: 'demo-hung', body: { slotId: slotAt(s, 'court-3', '17:00'), idempotencyKey: 'hung-booking-0001' } });
    expect(book.status).toBe(201);
    const after = all(await search(s, 'demo-minh', { candidateLimit: 20 }));
    expect(after.some((c: any) => c.id === 'demo-hung' && c.start === '2030-06-01T17:00')).toBe(false);
    expect(after.some((c: any) => c.id === 'demo-hung' && c.start !== '2030-06-01T17:00')).toBe(true);
  });

  it('does not search for singles yet', async () => {
    const s = await boot();
    expect((await search(s, 'demo-minh', { format: 'singles' })).json.error).toBe('format_not_supported_yet');
    expect((await search(s, 'demo-minh', { radiusKm: 0 })).json.error).toBe('invalid_radius');
    expect((await call(s, 'POST', '/api/play/search', { body: {} })).status).toBe(401);
  });

  it('keeps stale availability in the results with a warning', async () => {
    const s = await boot();
    s.clock.now += 20 * 60_000; // past the 15 minute stale threshold
    const r = await search(s, 'demo-minh');
    const list = r.json.categories.join_existing;
    expect(list.length).toBe(2);
    for (const item of list) expect(item.warnings.join(' ')).toMatch(/not verified/i);
  });

  it('never exceeds capacity with concurrent joins, and the full game is confirmed', async () => {
    const s = await boot();
    const bt = demoMatch(s, 'bt'); // host + 2 joined: one seat left
    const players = ['demo-minh', 'demo-mai', 'demo-hung', 'demo-trang', 'demo-vy', 'demo-linh'];
    const before = ratings(s, [...players, 'demo-nam', 'demo-thao', 'demo-an']);
    const results = await Promise.all(players.map((p) => call(s, 'POST', `/api/play/open-matches/${bt.id}/join`, { player: p })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect(count(s, "SELECT COUNT(*) AS n FROM booking_participants WHERE booking_id = ? AND status = 'joined'", bt.booking_id)).toBe(4);
    const row = db(s).prepare('SELECT status FROM open_matches WHERE id = ?').get(bt.id) as { status: string };
    expect(row.status).toBe('confirmed');
    expect((db(s).prepare('SELECT status FROM bookings WHERE id = ?').get(bt.booking_id) as { status: string }).status).toBe('confirmed');
    expect((db(s).prepare('SELECT status FROM court_availability WHERE id = ?').get(bt.slot_id) as { status: string }).status).toBe('booked');
    const winner = results.find((r) => r.status === 200)!;
    expect(winner.json.match.teamSplit.pairings).toHaveLength(3);
    // Joining never touches a rating.
    expect(ratings(s, [...players, 'demo-nam', 'demo-thao', 'demo-an'])).toEqual(before);
  });

  it('treats a duplicate join as the same join', async () => {
    const s = await boot();
    const main = demoMatch(s, 'main'); // host + 1
    const first = await call(s, 'POST', `/api/play/open-matches/${main.id}/join`, { player: 'demo-minh' });
    const second = await call(s, 'POST', `/api/play/open-matches/${main.id}/join`, { player: 'demo-minh' });
    expect([first.status, second.status]).toEqual([200, 200]);
    expect([first.json.replayed, second.json.replayed]).toEqual([false, true]);
    expect(count(s, 'SELECT COUNT(*) AS n FROM booking_participants WHERE booking_id = ? AND player_id = ?', main.booking_id, 'demo-minh')).toBe(1);
    expect(second.json.match.joinedCount).toBe(3);
    // Already in: the game no longer appears under join_existing for that player.
    const r = await search(s, 'demo-minh');
    expect(r.json.categories.join_existing.some((x: any) => x.match.id === main.id)).toBe(false);
    // A back-to-back game (18:00 then 19:00) is not an overlap, so it is allowed.
    const adjacent = await call(s, 'POST', `/api/play/open-matches/${demoMatch(s, 'bt').id}/join`, { player: 'demo-trang' });
    expect(adjacent.status).toBe(200);
  });

  it('refuses a seat that conflicts with another booking of the same player', async () => {
    const s = await boot();
    const bt = demoMatch(s, 'bt');
    const book = await call(s, 'POST', '/api/play/bookings', { player: 'demo-minh', body: { slotId: slotAt(s, 'court-3', '18:00', '2030-06-02'), idempotencyKey: 'minh-booking-0001' } });
    expect(book.status).toBe(201);
    const r = await call(s, 'POST', `/api/play/open-matches/${bt.id}/join`, { player: 'demo-minh' });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('player_overlap');
    const found = await search(s, 'demo-minh');
    expect(found.json.categories.join_existing.some((x: any) => x.match.id === bt.id)).toBe(false);
    expect(found.json.filteredOut.busy).toBeGreaterThanOrEqual(1);
  });

  it('builds a game: create, invite, decline frees the seat, accept confirms at four, balanced split', async () => {
    const s = await boot();
    const slot = slotAt(s, 'court-1', '17:00');
    const people = ['demo-minh', 'demo-hung', 'demo-mai', 'demo-linh', 'demo-trang'];
    const before = ratings(s, people);

    const created = await call(s, 'POST', '/api/play/open-matches', { player: 'demo-minh', body: { slotId: slot } });
    expect(created.status).toBe(201);
    const m = created.json.match;
    expect(m).toMatchObject({ status: 'open', format: 'doubles', capacity: 4, joinedCount: 1, seatsOpen: 3, bookingStatus: 'held' });
    expect(m.pricePerPlayerVnd).toBe(30000); // 120,000 VND court, four shares rounded up to 5,000
    expect(m.payment).toEqual({ method: 'pay_at_facility', processed: false });
    expect((db(s).prepare('SELECT status FROM court_availability WHERE id = ?').get(slot) as { status: string }).status).toBe('held');
    const replay = await call(s, 'POST', '/api/play/open-matches', { player: 'demo-minh', body: { slotId: slot } });
    expect([replay.status, replay.json.match.id, replay.json.replayed]).toEqual([200, m.id, true]);
    expect((await call(s, 'POST', '/api/play/open-matches', { player: 'demo-trang', body: { slotId: slot } })).status).toBe(409);
    expect((await call(s, 'POST', '/api/play/open-matches', { player: 'demo-trang', body: { slotId: slot, format: 'singles' } })).json.error).toBe('format_not_supported_yet');

    // Only the host invites, and a pending invitation reserves a seat.
    expect((await call(s, 'POST', `/api/play/open-matches/${m.id}/invite`, { player: 'demo-hung', body: { playerId: 'demo-mai' } })).status).toBe(403);
    const inv: Record<string, string> = {};
    for (const id of ['demo-hung', 'demo-mai', 'demo-linh']) {
      const r = await call(s, 'POST', `/api/play/open-matches/${m.id}/invite`, { player: 'demo-minh', body: { playerId: id } });
      expect(r.status).toBe(201);
      inv[id] = r.json.invitation.id;
    }
    const dup = await call(s, 'POST', `/api/play/open-matches/${m.id}/invite`, { player: 'demo-minh', body: { playerId: 'demo-mai' } });
    expect([dup.status, dup.json.replayed, dup.json.invitation.id]).toEqual([200, true, inv['demo-mai']]);
    const full = await call(s, 'POST', `/api/play/open-matches/${m.id}/join`, { player: 'demo-trang' });
    expect([full.status, full.json.error]).toEqual([409, 'match_full']);
    expect((await call(s, 'POST', `/api/play/open-matches/${m.id}/invite`, { player: 'demo-minh', body: { playerId: 'demo-trang' } })).json.error).toBe('match_full');

    // Only the invitee answers.
    expect((await call(s, 'POST', `/api/play/invitations/${inv['demo-mai']}/accept`, { player: 'demo-hung' })).status).toBe(403);

    // Decline frees the seat.
    const declined = await call(s, 'POST', `/api/play/invitations/${inv['demo-hung']}/decline`, { player: 'demo-hung' });
    expect([declined.status, declined.json.invitation.status, declined.json.match.seatsOpen]).toEqual([200, 'declined', 1]);
    expect((await call(s, 'POST', `/api/play/invitations/${inv['demo-hung']}/decline`, { player: 'demo-hung' })).json.replayed).toBe(true);
    expect((await call(s, 'POST', `/api/play/invitations/${inv['demo-hung']}/accept`, { player: 'demo-hung' })).json.error).toBe('invalid_transition');

    // Accepting takes a seat, but the game is not confirmed until all four are in.
    const a1 = await call(s, 'POST', `/api/play/invitations/${inv['demo-mai']}/accept`, { player: 'demo-mai' });
    expect([a1.status, a1.json.match.status, a1.json.match.joinedCount, a1.json.match.teamSplit]).toEqual([200, 'open', 2, null]);
    expect((await call(s, 'POST', `/api/play/invitations/${inv['demo-mai']}/accept`, { player: 'demo-mai' })).json.replayed).toBe(true);
    const a2 = await call(s, 'POST', `/api/play/invitations/${inv['demo-linh']}/accept`, { player: 'demo-linh' });
    expect([a2.json.match.status, a2.json.match.joinedCount, a2.json.match.bookingStatus]).toEqual(['open', 3, 'held']);
    const last = await call(s, 'POST', `/api/play/open-matches/${m.id}/join`, { player: 'demo-trang' });
    expect(last.status).toBe(200);
    const done = last.json.match;
    expect([done.status, done.joinedCount, done.bookingStatus, done.seatsOpen]).toEqual(['confirmed', 4, 'confirmed', 0]);
    expect((db(s).prepare('SELECT status FROM court_availability WHERE id = ?').get(slot) as { status: string }).status).toBe('booked');

    // Balanced split: all three pairings, each uses all four players, the recommended one has the smallest gap.
    const split = done.teamSplit;
    expect(split.pairings).toHaveLength(3);
    const seen = new Set<string>();
    for (const p of split.pairings) {
      const ids = [...p.teamA, ...p.teamB].map((x: any) => x.playerId).sort();
      expect(ids).toEqual(['demo-linh', 'demo-mai', 'demo-minh', 'demo-trang']);
      seen.add(p.teamA.map((x: any) => x.playerId).sort().join('+'));
    }
    expect(seen.size).toBe(3);
    expect(split.gap).toBe(Math.min(...split.pairings.map((p: any) => p.gap)));
    expect(split.recommended).toEqual(split.pairings[split.recommendedIndex]);
    expect(typeof split.gapLevel).toBe('number');

    // Ratings are untouched by joining, inviting or confirming.
    expect(ratings(s, people)).toEqual(before);

    // The decline freed the seat, the invitation list is clean, and my-games shows the game to its players only.
    const mine = await call(s, 'GET', '/api/play/my-games', { player: 'demo-linh' });
    expect(mine.json.games.map((g: any) => g.id)).toEqual([m.id]);
    expect(mine.json.invitations).toEqual([]);
    expect((await call(s, 'GET', '/api/play/my-games', { player: 'demo-hung' })).json.games).toEqual([]);
    expect((await call(s, 'GET', '/api/play/my-games')).status).toBe(401);
  });

  it('does not invite someone who opted out, and shows pending invitations in my-games', async () => {
    const s = await boot();
    const slot = slotAt(s, 'court-1', '17:00');
    const m = (await call(s, 'POST', '/api/play/open-matches', { player: 'demo-minh', body: { slotId: slot } })).json.match;
    await call(s, 'PUT', '/api/play/preferences', { player: 'demo-hung', body: { matchInviteOptIn: false } });
    const no = await call(s, 'POST', `/api/play/open-matches/${m.id}/invite`, { player: 'demo-minh', body: { playerId: 'demo-hung' } });
    expect([no.status, no.json.error]).toEqual([409, 'player_not_available']);
    const ok = await call(s, 'POST', `/api/play/open-matches/${m.id}/invite`, { player: 'demo-minh', body: { playerId: 'demo-mai' } });
    expect(ok.status).toBe(201);
    const mine = await call(s, 'GET', '/api/play/my-games', { player: 'demo-mai' });
    expect(mine.json.invitations.map((i: any) => i.id)).toEqual([ok.json.invitation.id]);
    expect(mine.json.invitations[0].match.id).toBe(m.id);
    expect(mine.json.games).toEqual([]);
  });

  it('frees the court and expires the invitations when the held game lapses', async () => {
    const s = await boot();
    const slot = slotAt(s, 'court-1', '17:00');
    const m = (await call(s, 'POST', '/api/play/open-matches', { player: 'demo-minh', body: { slotId: slot } })).json.match;
    const inv = (await call(s, 'POST', `/api/play/open-matches/${m.id}/invite`, { player: 'demo-minh', body: { playerId: 'demo-mai' } })).json.invitation;
    s.clock.now += 31 * 60_000; // past the 30 minute open-match hold
    const mine = await call(s, 'GET', '/api/play/my-games', { player: 'demo-minh' });
    expect(mine.json.games[0].status).toBe('expired');
    expect((db(s).prepare('SELECT status FROM court_availability WHERE id = ?').get(slot) as { status: string }).status).toBe('available');
    const late = await call(s, 'POST', `/api/play/invitations/${inv.id}/accept`, { player: 'demo-mai' });
    expect([late.status, late.json.error]).toEqual([409, 'invitation_expired']);
    expect((await call(s, 'POST', `/api/play/open-matches/${m.id}/join`, { player: 'demo-trang' })).json.error).toBe('match_closed');
  });

  it('shows other players by name and level only, and keeps facility listing behind the admin token', async () => {
    const s = await boot();
    const r = await search(s, 'demo-minh');
    const text = JSON.stringify(r.json);
    expect(text).not.toMatch(/phone|zalo|whatsapp|email|contact/i);
    const person = r.json.categories.join_existing[0].match.participants[0];
    expect(Object.keys(person).sort()).toEqual(['displayName', 'isHost', 'level', 'playerId', 'provisional']);
    expect((await call(s, 'GET', '/api/play/admin/open-matches')).status).toBe(403);
    const admin = await call(s, 'GET', '/api/play/admin/open-matches?facilityId=demo-facility', { admin: true });
    expect(admin.status).toBe(200);
    expect(admin.json.matches).toHaveLength(1);
    expect(admin.json.matches[0].you).toBeNull();
  });

  it('adds only tables, with the documented defaults', async () => {
    const s = await boot();
    const row = db(s).prepare("SELECT * FROM player_preferences WHERE player_id = 'demo-minh'").get() as any;
    expect([row.radius_km, row.format, row.start_pref]).toEqual([5, 'doubles', 'asap']);
    const prefs = await call(s, 'GET', '/api/play/preferences', { player: 'demo-minh' });
    expect(prefs.json.preferences).toMatchObject({ radiusKm: 5, format: 'doubles', start: { kind: 'asap' } });
    expect((await call(s, 'PUT', '/api/play/preferences', { player: 'demo-minh', body: { radiusKm: 99 } })).json.error).toBe('invalid_radius');
    const tables = (db(s).prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('open_matches','match_invitations','player_availability','player_preferences')").all() as { name: string }[]).length;
    expect(tables).toBe(4);
  });
});
