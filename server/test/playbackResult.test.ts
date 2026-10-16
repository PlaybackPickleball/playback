import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureClubSchema, getPlayer, joinCourt, setMatchMode, setStartingRating, startSimulated, createGuest } from '../src/club.js';
import { Store } from '../src/db.js';
import { ALGORITHM_VERSION } from '../src/playbackRating.js';
import { confirmResult, correctVerifiedResult, disputeResult, leaderboard, resolveDispute, submitResult } from '../src/results.js';
import { ClubError } from '../src/club.js';

const url = 'http://x';
const stores: Store[] = [];

function open() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'court-replay-rating-'));
  const dbPath = path.join(dir, 'court.db');
  const store = new Store(dbPath);
  stores.push(store);
  ensureClubSchema(store.db);
  return { db: store.db, dbPath, dir };
}

afterEach(() => {
  while (stores.length) stores.pop()?.close();
});

function ratingOf(db: ReturnType<typeof open>['db'], id: string) {
  return Number((db.prepare('SELECT pir_rating AS n FROM players WHERE id = ?').get(id) as { n: number }).n);
}

function played(db: ReturnType<typeof open>['db'], court: string, players: { id: string; team: 'A' | 'B' }[]) {
  const first = players[0];
  if (!first) throw new Error('roster');
  let match = joinCourt(db, court, first.id, first.team, url);
  setMatchMode(db, match.id, 'doubles', url);
  for (const player of players.slice(1)) match = joinCourt(db, court, player.id, player.team, url);
  startSimulated(db, match.id, url);
  return match.id;
}

const DEMO = [
  { id: 'demo-minh', team: 'A' as const },
  { id: 'demo-an', team: 'A' as const },
  { id: 'demo-khoa', team: 'B' as const },
  { id: 'demo-ha', team: 'B' as const },
];

describe('verified result updates', () => {
  it('requires the other team, applies once, and keeps history', () => {
    const { db, dbPath } = open();
    const before = DEMO.map((player) => ratingOf(db, player.id));
    const joined = ratingOf(db, 'demo-minh');
    const id = played(db, 'court-2', DEMO);
    expect(ratingOf(db, 'demo-minh')).toBe(joined);

    submitResult(db, id, 'demo-minh', ['demo-minh', 'demo-an'], ['demo-khoa', 'demo-ha'], 11, 7, 11);
    expect(ratingOf(db, 'demo-minh')).toBe(before[0]);
    expect(() => confirmResult(db, id, 'demo-minh')).toThrow(ClubError);
    expect(ratingOf(db, 'demo-minh')).toBe(before[0]);

    const first = confirmResult(db, id, 'demo-khoa');
    expect(first.replayed).toBe(false);
    const after = DEMO.map((player) => ratingOf(db, player.id));
    expect(after[0]).not.toBe(before[0]);
    expect(after[2]).not.toBe(before[2]);

    const again = confirmResult(db, id, 'demo-ha');
    expect(again.replayed).toBe(true);
    expect(DEMO.map((player) => ratingOf(db, player.id))).toEqual(after);

    const rows = db.prepare('SELECT algorithm_version, explanation, delta FROM rating_history WHERE match_id = ?').all(id) as {
      algorithm_version: string;
      explanation: string;
      delta: number;
    }[];
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.algorithm_version === ALGORITHM_VERSION)).toBe(true);
    expect(rows.some((row) => row.explanation === 'beat_stronger')).toBe(true);
    expect(() =>
      db.prepare('INSERT INTO rating_history (match_id, player_id, rating_before, rating_after, confidence_before, confidence_after, created_at) VALUES (?, ?, 1, 1, 0, 0, ?)').run(
        id,
        'demo-minh',
        new Date().toISOString(),
      ),
    ).toThrow();

    const detail = getPlayer(db, 'demo-minh', url);
    expect(detail.provisional).toBe(true);
    expect(detail.matchesPlayed).toBe(1);
    expect(detail.wins).toBe(1);
    expect(detail.ratedMatches[0]?.explanation).toBeTruthy();
    expect(detail.ratedMatches[0]?.opponents.map((player) => player.id).sort()).toEqual(['demo-ha', 'demo-khoa']);
    expect(detail.ratedMatches[0]?.teammate?.id).toBe('demo-an');
    expect(detail.history).toHaveLength(1);

    stores.pop()?.close();
    const reopened = new Store(dbPath);
    stores.push(reopened);
    expect(
      Number((reopened.db.prepare('SELECT COUNT(*) AS n FROM rating_history WHERE match_id = ?').get(id) as { n: number }).n),
    ).toBe(4);
  });

  it('rejects a fabricated roster, blocks a dispute, and lets an admin resolve it', () => {
    const { db } = open();
    const id = played(db, 'court-3', DEMO);
    const before = ratingOf(db, 'demo-minh');
    expect(() => submitResult(db, id, 'demo-minh', ['demo-minh', 'demo-lan'], ['demo-khoa', 'demo-ha'], 11, 7, 11)).toThrow(ClubError);
    expect(ratingOf(db, 'demo-minh')).toBe(before);
    submitResult(db, id, 'demo-minh', ['demo-minh', 'demo-an'], ['demo-khoa', 'demo-ha'], 11, 7, 11);
    disputeResult(db, id, 'demo-ha');
    expect(() => confirmResult(db, id, 'demo-khoa')).toThrow(ClubError);
    expect(ratingOf(db, 'demo-minh')).toBe(before);
    resolveDispute(db, id, 11, 5, 11);
    const after = ratingOf(db, 'demo-minh');
    expect(after).not.toBe(before);
    expect(() => resolveDispute(db, id, 11, 5, 11)).toThrow(ClubError);
    expect(ratingOf(db, 'demo-minh')).toBe(after);
  });

  it('applies concurrent confirms once', async () => {
    const { db, dbPath } = open();
    const id = played(db, 'court-4', DEMO);
    submitResult(db, id, 'demo-minh', ['demo-minh', 'demo-an'], ['demo-khoa', 'demo-ha'], 11, 7, 11);
    const before = ratingOf(db, 'demo-minh');
    stores.pop()?.close();
    const tsx = createRequire(import.meta.url).resolve('tsx');
    const worker = fileURLToPath(new URL('./confirmWorker.ts', import.meta.url));
    const run = (playerId: string) =>
      new Promise<{ ok: boolean; replayed?: boolean; code?: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', tsx, worker], {
          env: { ...process.env, DB_PATH: dbPath, MATCH_ID: id, PLAYER_ID: playerId },
        });
        let out = '';
        let err = '';
        child.stdout.on('data', (chunk) => {
          out += String(chunk);
        });
        child.stderr.on('data', (chunk) => {
          err += String(chunk);
        });
        child.on('error', reject);
        child.on('exit', (code) => {
          if (code !== 0) {
            reject(new Error(err || out || `exit ${code}`));
            return;
          }
          resolve(JSON.parse(out.trim().split('\n').pop() || '{}'));
        });
      });
    const [left, right] = await Promise.all([run('demo-khoa'), run('demo-ha')]);
    expect(left.ok && right.ok).toBe(true);
    expect([left.replayed, right.replayed].filter((value) => value === false)).toHaveLength(1);
    const check = new Store(dbPath);
    stores.push(check);
    expect(Number((check.db.prepare('SELECT pir_rating AS n FROM players WHERE id = ?').get('demo-minh') as { n: number }).n)).not.toBe(before);
    expect(Number((check.db.prepare('SELECT COUNT(*) AS n FROM rating_history WHERE match_id = ?').get(id) as { n: number }).n)).toBe(4);
    expect(Number((check.db.prepare('SELECT ratings_applied AS n FROM matches WHERE id = ?').get(id) as { n: number }).n)).toBe(1);
  });

  it('replays later matches after a correction instead of subtracting the old delta', () => {
    const { db } = open();
    const first = played(db, 'court-5', DEMO);
    submitResult(db, first, 'demo-minh', ['demo-minh', 'demo-an'], ['demo-khoa', 'demo-ha'], 11, 1, 11);
    confirmResult(db, first, 'demo-khoa');
    const second = played(db, 'court-6', DEMO);
    submitResult(db, second, 'demo-minh', ['demo-minh', 'demo-an'], ['demo-khoa', 'demo-ha'], 11, 5, 11);
    confirmResult(db, second, 'demo-ha');
    db.prepare(`UPDATE matches SET verified_at = ? WHERE id = ?`).run('2026-01-01T00:00:00.000Z', first);
    db.prepare(`UPDATE matches SET verified_at = ? WHERE id = ?`).run('2026-01-02T00:00:00.000Z', second);
    db.prepare(`UPDATE rating_history SET created_at = ? WHERE match_id = ?`).run('2026-01-01T00:00:00.000Z', first);
    db.prepare(`UPDATE rating_history SET created_at = ? WHERE match_id = ?`).run('2026-01-02T00:00:00.000Z', second);
    const oldSecond = db.prepare('SELECT rating_before, delta FROM rating_history WHERE match_id = ? AND player_id = ?').get(second, 'demo-minh') as {
      rating_before: number;
      delta: number;
    };
    correctVerifiedResult(db, first, 9, 11, 11);
    const newFirst = db.prepare('SELECT rating_after FROM rating_history WHERE match_id = ? AND player_id = ?').get(first, 'demo-minh') as {
      rating_after: number;
    };
    const newSecond = db.prepare('SELECT rating_before, delta FROM rating_history WHERE match_id = ? AND player_id = ?').get(second, 'demo-minh') as {
      rating_before: number;
      delta: number;
    };
    expect(newSecond.rating_before).toBeCloseTo(newFirst.rating_after, 5);
    expect(newSecond.rating_before).not.toBeCloseTo(oldSecond.rating_before, 5);
    expect(Number((db.prepare('SELECT COUNT(*) AS n FROM rating_history WHERE player_id = ?').get('demo-minh') as { n: number }).n)).toBe(2);
  });

  it('keeps a self-selected start provisional', () => {
    const { db } = open();
    const guest = createGuest(db, 'New Player', 'en', url, { category: 'beginner' });
    expect(guest.rating).toBeCloseTo(2.5, 5);
    expect(guest.provisional).toBe(true);
    expect(guest.established).toBe(false);
    expect(guest.confidence).toBe('low');
    expect(guest.matchesPlayed).toBe(0);
    const precise = setStartingRating(db, guest.id, 'intermediate', 3.25, url);
    expect(precise.rating).toBeCloseTo(3.25, 5);
    expect(precise.provisional).toBe(true);
    expect(precise.established).toBe(false);
  });

  it('ranks the competitive list by rating, not win rate, and honors opt-out', () => {
    const { db } = open();
    const board = leaderboard(db, 'overall', null, 'rating');
    expect(board.minimumMatches).toBe(5);
    expect(board.competitive.length).toBeGreaterThan(0);
    expect(board.competitive.every((row) => row.matchesPlayed >= 5 && row.rank !== null)).toBe(true);
    expect(board.provisional.every((row) => row.provisional && row.rank === null)).toBe(true);
    expect(board.competitive[0]?.id).toBe('demo-dung');
    db.prepare('UPDATE players SET leaderboard_opt_out = 1 WHERE id = ?').run('demo-dung');
    const hidden = leaderboard(db, 'overall', null, 'rating');
    expect(hidden.competitive.some((row) => row.id === 'demo-dung')).toBe(false);
    const byMatches = leaderboard(db, 'facility', 'demo-facility-quan-7', 'matches');
    expect(byMatches.competitive[0]?.id).toBe('demo-phuong');
    const improved = leaderboard(db, 'overall', null, 'improved');
    expect(improved.sort).toBe('improved');
    expect(improved.competitive.every((row) => row.matchesPlayed >= 5)).toBe(true);
  });
});
