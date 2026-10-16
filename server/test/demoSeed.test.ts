import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_FACILITY_ID, DEMO_RADIUS_KM } from '../src/demoSeed.js';
import { ensureClubSchema, listFacilities, listPlayers, resetDemo } from '../src/club.js';
import { toPlayback } from '../src/playbackRating.js';
import { Store } from '../src/db.js';
import { haversineKm } from '../src/geo.js';

const stores: Store[] = [];

function open() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'court-replay-seed-'));
  const store = new Store(path.join(dir, 'court.db'));
  stores.push(store);
  ensureClubSchema(store.db);
  return store.db;
}

afterEach(() => {
  while (stores.length) stores.pop()?.close();
});

const count = (db: ReturnType<typeof open>, sql: string) => Number((db.prepare(sql).get() as { n: number | bigint }).n);

describe('demo seed', () => {
  it('is idempotent: twice still gives 20 demo players and 3 facilities with 17 courts', () => {
    const db = open();
    ensureClubSchema(db);
    ensureClubSchema(db);
    expect(count(db, 'SELECT COUNT(*) AS n FROM players WHERE demo = 1')).toBe(20);
    expect(count(db, 'SELECT COUNT(*) AS n FROM facilities WHERE demo = 1')).toBe(3);
    expect(count(db, 'SELECT COUNT(*) AS n FROM courts WHERE demo = 1')).toBe(17);
    const facilities = listFacilities(db);
    expect(facilities.map((f) => f.courts.length)).toEqual([8, 5, 4]);
    const main = facilities.find((f) => f.id === DEMO_FACILITY_ID);
    expect(main?.courts.filter((c) => c.records).map((c) => c.id)).toEqual(['court-1']);
    expect(main?.courts.filter((c) => c.simulated)).toHaveLength(7);
    expect(facilities.flatMap((f) => f.courts).filter((c) => c.records)).toHaveLength(1);
  });

  it('varies ratings and confidence, with brand-new provisional players and Vietnamese names', () => {
    const db = open();
    const demo = listPlayers(db, 'http://x').filter((p) => p.demo);
    expect(demo).toHaveLength(20);
    const ratings = demo.map((p) => p.rating);
    expect(Math.min(...ratings)).toBeLessThanOrEqual(2.75);
    expect(Math.max(...ratings)).toBeGreaterThanOrEqual(4.5);
    expect(new Set(demo.map((p) => p.confidence))).toEqual(new Set(['low', 'medium', 'high']));
    const fresh = demo.filter((p) => p.matchesPlayed === 0);
    expect(fresh.length).toBeGreaterThanOrEqual(4);
    expect(fresh.every((p) => p.provisional && !p.established && p.confidence === 'low')).toBe(true);
    expect(demo.some((p) => p.established && p.confidence === 'high')).toBe(true);
    expect(demo.every((p) => p.latitude !== null && p.longitude !== null && p.homeFacilityId)).toBe(true);
    expect(new Set(demo.map((p) => p.language))).toEqual(new Set(['en', 'vi']));
    expect(demo.every((p) => /\s/.test(p.displayName))).toBe(true);
    for (const p of demo) expect(p.wins + p.losses).toBe(p.matchesPlayed);
  });

  it('puts exactly one facility inside 5 km of the main one and one outside', () => {
    const db = open();
    const [main, ...others] = listFacilities(db);
    const distances = others.map((f) => haversineKm(main!, f));
    expect(distances.filter((d) => d <= DEMO_RADIUS_KM)).toHaveLength(1);
    expect(distances.filter((d) => d > DEMO_RADIUS_KM)).toHaveLength(1);
  });

  it('never touches real rows, and reset keeps real players, matches, sessions and demo data counts', () => {
    const db = open();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO players (id, display_name, language, pir_rating, wins, losses, matches_played, demo, guest, created_at, updated_at)
       VALUES ('guest-real', 'Real Person', 'en', 1555, 3, 2, 5, 0, 1, ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO sessions (id, public_token, court_id, mode, status, team_a_json, team_b_json, consent_at, created_at, updated_at)
       VALUES ('s1', 'tok1', 'court-1', 'singles', 'ready', '[]', '[]', ?, ?, ?)`,
    ).run(now, now, now);
    db.prepare(
      `INSERT INTO matches (id, court_id, facility_id, mode, status, created_at, session_token, updated_at)
       VALUES ('real-match', 'court-1', ?, 'singles', 'completed', ?, 'tok1', ?)`,
    ).run(DEMO_FACILITY_ID, now, now);
    db.prepare(`INSERT INTO match_players (match_id, player_id, team) VALUES ('real-match', 'guest-real', 'A')`).run();
    db.prepare(
      `INSERT INTO matches (id, court_id, facility_id, mode, status, created_at, updated_at)
       VALUES ('demo-match', 'court-3', ?, 'singles', 'scheduled', ?, ?)`,
    ).run(DEMO_FACILITY_ID, now, now);
    db.prepare(`INSERT INTO match_players (match_id, player_id, team) VALUES ('demo-match', 'demo-lan', 'A')`).run();
    db.prepare(`UPDATE players SET pir_rating = 1999 WHERE id = 'demo-lan'`).run();

    ensureClubSchema(db); // plain seed never overwrites an edited demo row
    expect(count(db, `SELECT pir_rating AS n FROM players WHERE id = 'demo-lan'`)).toBe(1999);

    expect(resetDemo(db)).toEqual({ ok: true, recordingsKept: true });
    resetDemo(db);

    expect(count(db, `SELECT pir_rating AS n FROM players WHERE id = 'guest-real'`)).toBe(1555);
    expect(count(db, `SELECT matches_played AS n FROM players WHERE id = 'guest-real'`)).toBe(5);
    expect(count(db, `SELECT COUNT(*) AS n FROM matches WHERE id = 'real-match'`)).toBe(1);
    expect(count(db, `SELECT COUNT(*) AS n FROM match_players WHERE match_id = 'real-match'`)).toBe(1);
    expect(count(db, `SELECT COUNT(*) AS n FROM matches WHERE id = 'demo-match'`)).toBe(0);
    expect(count(db, `SELECT COUNT(*) AS n FROM sessions WHERE id = 's1'`)).toBe(1);
    expect(count(db, `SELECT pir_rating AS n FROM players WHERE id = 'demo-lan'`)).toBeCloseTo(4.4, 5);
    expect(count(db, 'SELECT COUNT(*) AS n FROM players WHERE demo = 1')).toBe(20);
    expect(count(db, 'SELECT COUNT(*) AS n FROM courts')).toBe(17);
  });

  it('migrates an old players table without demo, latitude, longitude, or home_facility_id and still seeds', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'court-replay-old-players-'));
    const store = new Store(path.join(dir, 'court.db'));
    stores.push(store);
    const db = store.db;
    db.exec(`
      CREATE TABLE players (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        language TEXT NOT NULL,
        skill TEXT,
        preferred_hand TEXT,
        pir_rating INTEGER NOT NULL,
        wins INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0,
        matches_played INTEGER NOT NULL DEFAULT 0,
        equipment_json TEXT,
        equipment_consent_at TEXT,
        recording_consent_at TEXT,
        is_demo INTEGER NOT NULL DEFAULT 0,
        is_guest INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE matches (
        id TEXT PRIMARY KEY,
        court_id TEXT NOT NULL,
        facility_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ratings_applied INTEGER NOT NULL DEFAULT 0,
        simulated INTEGER NOT NULL DEFAULT 0
      );
    `);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO players (
         id, display_name, language, pir_rating, wins, losses, matches_played, is_demo, is_guest, created_at, updated_at
       ) VALUES ('guest-real', 'Real Person', 'en', 1555, 3, 2, 5, 0, 1, ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO matches (id, court_id, facility_id, mode, status, created_at, updated_at)
       VALUES ('kept-match', 'court-1', 'demo-facility', 'singles', 'completed', ?, ?)`,
    ).run(now, now);

    ensureClubSchema(db);
    ensureClubSchema(db);

    const names = new Set((db.prepare('PRAGMA table_info(players)').all() as { name: string }[]).map((column) => column.name));
    expect([...names].filter((name) => ['demo', 'guest', 'latitude', 'longitude', 'home_facility_id'].includes(name)).sort()).toEqual([
      'demo',
      'guest',
      'home_facility_id',
      'latitude',
      'longitude',
    ]);
    expect(count(db, `SELECT pir_rating AS n FROM players WHERE id = 'guest-real'`)).toBeCloseTo(toPlayback(1555), 5);
    expect(count(db, `SELECT guest AS n FROM players WHERE id = 'guest-real'`)).toBe(1);
    expect(count(db, `SELECT demo AS n FROM players WHERE id = 'guest-real'`)).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM players WHERE demo = 1')).toBe(20);
    expect(count(db, `SELECT COUNT(*) AS n FROM matches WHERE id = 'kept-match'`)).toBe(1);
  });
});
