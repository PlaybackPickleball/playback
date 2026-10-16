import type { DatabaseSync } from 'node:sqlite';
import { ClubError } from './club.js';
import {
  ALGORITHM_VERSION,
  COMPETITIVE_MIN_MATCHES,
  applyPlaybackResult,
  categoryOf,
  confidenceBand,
  isProvisional,
  parseGameScore,
  toPlayback,
  type ScoreTarget,
} from './playbackRating.js';
import type { TeamId } from './lifecycle.js';

type Slot = { playerId: string; team: TeamId };

type MatchBits = {
  id: string;
  mode: 'singles' | 'doubles';
  status: string;
  simulated: number | bigint;
  session_token: string | null;
  ratings_applied: number | bigint;
  result_status: string | null;
  submitted_by: string | null;
  verified_at: string | null;
  score_a: number | bigint | null;
  score_b: number | bigint | null;
  score_target: number | bigint | null;
  winner: TeamId | null;
};

function slotsOf(db: DatabaseSync, matchId: string): Slot[] {
  const rows = db.prepare('SELECT player_id, team FROM match_players WHERE match_id = ? ORDER BY rowid').all(matchId) as {
    player_id: string;
    team: TeamId;
  }[];
  return rows.map((row) => ({ playerId: row.player_id, team: row.team }));
}

function matchBits(db: DatabaseSync, matchId: string): MatchBits {
  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId) as MatchBits | undefined;
  if (!match) throw new ClubError('not_found');
  return match;
}

function samePlayers(slots: Slot[], teamA: string[], teamB: string[]): boolean {
  const roster = slots.map((slot) => slot.playerId).sort();
  const submitted = [...teamA, ...teamB].sort();
  if (new Set(submitted).size !== submitted.length) return false;
  return roster.length === submitted.length && roster.every((id, index) => id === submitted[index]);
}

function recorded(db: DatabaseSync, match: MatchBits): void {
  if (match.status !== 'recording' && match.status !== 'completed') throw new ClubError('not_recorded');
  if (Number(match.simulated) === 1) return;
  if (match.status === 'completed') return;
  const session = match.session_token
    ? (db.prepare('SELECT status FROM sessions WHERE public_token = ?').get(match.session_token) as { status: string } | undefined)
    : undefined;
  if (!session || session.status !== 'ready') throw new ClubError('recording_not_saved');
}

function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = fn();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already closed */
    }
    throw error;
  }
}

function writeTeams(db: DatabaseSync, matchId: string, teamA: string[], teamB: string[]) {
  db.prepare('DELETE FROM match_players WHERE match_id = ?').run(matchId);
  const insert = db.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)');
  for (const id of teamA) insert.run(matchId, id, 'A');
  for (const id of teamB) insert.run(matchId, id, 'B');
}

type PlayerBits = { id: string; pir_rating: number; matches_played: number; wins: number; losses: number };

function readPlayer(db: DatabaseSync, id: string): PlayerBits {
  const row = db.prepare('SELECT id, pir_rating, matches_played, wins, losses FROM players WHERE id = ?').get(id) as
    | { id: string; pir_rating: number | bigint; matches_played: number | bigint; wins: number | bigint; losses: number | bigint }
    | undefined;
  if (!row) throw new ClubError('not_found');
  return {
    id: row.id,
    pir_rating: Number(row.pir_rating),
    matches_played: Number(row.matches_played),
    wins: Number(row.wins),
    losses: Number(row.losses),
  };
}

/** Writes one verified result. Caller holds the transaction and has already claimed ratings_applied. */
export function writeRatingUpdate(db: DatabaseSync, matchId: string, verifiedAt: string): void {
  const match = matchBits(db, matchId);
  const target = Number(match.score_target);
  const scoreA = Number(match.score_a);
  const scoreB = Number(match.score_b);
  const parsed = parseGameScore(scoreA, scoreB, target);
  if (!parsed.ok) throw new ClubError(parsed.error);
  const slots = slotsOf(db, matchId);
  const load = (team: TeamId) =>
    slots
      .filter((slot) => slot.team === team)
      .map((slot) => {
        const player = readPlayer(db, slot.playerId);
        return { id: player.id, rating: toPlayback(player.pir_rating), matchesPlayed: player.matches_played, wins: player.wins, losses: player.losses };
      });
  const teamA = load('A');
  const teamB = load('B');
  if (teamA.length === 0 || teamB.length === 0) throw new ClubError('not_recorded');
  const updates = applyPlaybackResult(teamA, teamB, scoreA, scoreB, parsed.target);
  const history = db.prepare(
    `INSERT INTO rating_history (
      match_id, player_id, rating_before, rating_after, confidence_before, confidence_after, created_at,
      algorithm_version, delta, won, explanation, band_before, band_after
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const apply = db.prepare(
    `UPDATE players SET pir_rating = ?, wins = ?, losses = ?, matches_played = ?, updated_at = ? WHERE id = ?`,
  );
  const weight = (band: string) => (band === 'high' ? 0.85 : band === 'medium' ? 0.55 : 0.15);
  const prior = new Map([...teamA, ...teamB].map((player) => [player.id, player]));
  for (const update of updates) {
    const before = prior.get(update.id);
    if (!before) throw new ClubError('not_found');
    history.run(
      matchId,
      update.id,
      update.ratingBefore,
      update.ratingAfter,
      weight(update.confidenceBefore),
      weight(update.confidenceAfter),
      verifiedAt,
      ALGORITHM_VERSION,
      update.delta,
      update.won ? 1 : 0,
      update.explanation,
      update.confidenceBefore,
      update.confidenceAfter,
    );
    apply.run(
      update.ratingAfter,
      before.wins + (update.won ? 1 : 0),
      before.losses + (update.won ? 0 : 1),
      update.matchesPlayed,
      verifiedAt,
      update.id,
    );
  }
  const info = db
    .prepare(
      `UPDATE matches SET status = 'verified', verified_at = ?, ratings_applied = 1, result_status = 'verified', updated_at = ?
       WHERE id = ? AND ratings_applied = 0`,
    )
    .run(verifiedAt, verifiedAt, matchId);
  if (Number(info.changes) !== 1) throw new ClubError('already_verified');
}

export function submitResult(
  db: DatabaseSync,
  matchId: string,
  playerId: string,
  teamA: string[],
  teamB: string[],
  scoreA: number,
  scoreB: number,
  target: number,
): void {
  const parsed = parseGameScore(scoreA, scoreB, target);
  if (!parsed.ok) throw new ClubError(parsed.error);
  const match = matchBits(db, matchId);
  if (Number(match.ratings_applied) === 1 || match.status === 'verified') throw new ClubError('already_verified');
  recorded(db, match);
  const slots = slotsOf(db, matchId);
  if (!slots.some((slot) => slot.playerId === playerId)) throw new ClubError('not_participant');
  if (!samePlayers(slots, teamA, teamB)) throw new ClubError('players_not_in_match');
  const capacity = match.mode === 'singles' ? 1 : 2;
  if (teamA.length !== capacity || teamB.length !== capacity) throw new ClubError('players_not_in_match');
  for (const id of [...teamA, ...teamB]) {
    if (!db.prepare('SELECT 1 FROM players WHERE id = ?').get(id)) throw new ClubError('players_not_in_match');
  }
  const now = new Date().toISOString();
  let duration: number | null = null;
  if (match.session_token) {
    const session = db.prepare('SELECT duration_ms FROM sessions WHERE public_token = ?').get(match.session_token) as
      | { duration_ms: number | null }
      | undefined;
    if (session?.duration_ms != null) duration = Number(session.duration_ms);
  }
  tx(db, () => {
    const current = matchBits(db, matchId);
    if (Number(current.ratings_applied) === 1) throw new ClubError('already_verified');
    writeTeams(db, matchId, teamA, teamB);
    db.prepare(
      `UPDATE matches SET status = 'completed', score_a = ?, score_b = ?, winner = ?, score_target = ?,
        result_status = 'pending', submitted_by = ?, confirmed_by = NULL, disputed_by = NULL,
        ended_at = COALESCE(ended_at, ?), duration_ms = COALESCE(duration_ms, ?), score_confirmed_at = COALESCE(score_confirmed_at, ?),
        updated_at = ? WHERE id = ? AND ratings_applied = 0`,
    ).run(scoreA, scoreB, parsed.winner, parsed.target, playerId, now, duration, now, now, matchId);
  });
}

export function confirmResult(db: DatabaseSync, matchId: string, playerId: string): { replayed: boolean } {
  const peek = matchBits(db, matchId);
  const slots = slotsOf(db, peek.id);
  if (!slots.some((slot) => slot.playerId === playerId)) throw new ClubError('not_participant');
  if (Number(peek.ratings_applied) === 1 || peek.result_status === 'verified') return { replayed: true };
  if (peek.result_status === 'disputed') throw new ClubError('disputed');
  if (peek.result_status !== 'pending') throw new ClubError('not_pending');
  if (peek.submitted_by === playerId) throw new ClubError('cannot_confirm_own');
  const submitter = slots.find((slot) => slot.playerId === peek.submitted_by);
  const confirmer = slots.find((slot) => slot.playerId === playerId);
  if (!submitter || !confirmer || submitter.team === confirmer.team) throw new ClubError('cannot_confirm_own');
  const now = new Date().toISOString();
  return tx(db, () => {
    const current = matchBits(db, matchId);
    if (Number(current.ratings_applied) === 1 || current.result_status === 'verified') return { replayed: true };
    if (current.result_status !== 'pending') throw new ClubError(current.result_status === 'disputed' ? 'disputed' : 'not_pending');
    db.prepare(`UPDATE matches SET confirmed_by = ? WHERE id = ?`).run(playerId, matchId);
    writeRatingUpdate(db, matchId, now);
    return { replayed: false };
  });
}

export function disputeResult(db: DatabaseSync, matchId: string, playerId: string): void {
  const match = matchBits(db, matchId);
  const slots = slotsOf(db, matchId);
  if (!slots.some((slot) => slot.playerId === playerId)) throw new ClubError('not_participant');
  if (Number(match.ratings_applied) === 1 || match.status === 'verified') throw new ClubError('already_verified');
  if (match.result_status !== 'pending') throw new ClubError('not_pending');
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `UPDATE matches SET result_status = 'disputed', disputed_by = ?, updated_at = ?
       WHERE id = ? AND result_status = 'pending' AND ratings_applied = 0`,
    )
    .run(playerId, now, matchId);
  if (Number(info.changes) !== 1) throw new ClubError('not_pending');
}

export function resolveDispute(
  db: DatabaseSync,
  matchId: string,
  scoreA: number,
  scoreB: number,
  target: number,
): void {
  const parsed = parseGameScore(scoreA, scoreB, target);
  if (!parsed.ok) throw new ClubError(parsed.error);
  const now = new Date().toISOString();
  tx(db, () => {
    const current = matchBits(db, matchId);
    if (Number(current.ratings_applied) === 1) throw new ClubError('already_verified');
    if (current.result_status !== 'disputed') throw new ClubError('not_disputed');
    db.prepare(
      `UPDATE matches SET score_a = ?, score_b = ?, winner = ?, score_target = ?, result_status = 'pending', updated_at = ? WHERE id = ?`,
    ).run(scoreA, scoreB, parsed.winner, parsed.target, now, matchId);
    writeRatingUpdate(db, matchId, now);
  });
}

function roster(db: DatabaseSync, matchId: string): string[] {
  return slotsOf(db, matchId).map((slot) => slot.playerId);
}

/** Replays the corrected match and every later verified match that shares a player, in time order. */
export function correctVerifiedResult(db: DatabaseSync, matchId: string, scoreA: number, scoreB: number, target: number): void {
  const parsed = parseGameScore(scoreA, scoreB, target);
  if (!parsed.ok) throw new ClubError(parsed.error);
  const ordered = db
    .prepare(`SELECT id, verified_at FROM matches WHERE status = 'verified' AND ratings_applied = 1 ORDER BY verified_at, id`)
    .all() as { id: string; verified_at: string | null }[];
  const start = ordered.findIndex((row) => row.id === matchId);
  if (start < 0) throw new ClubError('not_verified');
  const affected = new Set(roster(db, matchId));
  const replay: { id: string; verifiedAt: string }[] = [];
  for (const row of ordered.slice(start)) {
    const players = roster(db, row.id);
    if (!players.some((id) => affected.has(id))) continue;
    replay.push({ id: row.id, verifiedAt: row.verified_at ?? new Date().toISOString() });
    for (const id of players) affected.add(id);
  }
  const now = new Date().toISOString();
  tx(db, () => {
    const marks = replay.map(() => '?').join(', ');
    for (const playerId of affected) {
      const rows = db
        .prepare(
          `SELECT rating_before, won FROM rating_history WHERE player_id = ? AND match_id IN (${marks}) ORDER BY created_at, rowid`,
        )
        .all(playerId, ...replay.map((row) => row.id)) as { rating_before: number; won: number | bigint | null }[];
      if (rows.length === 0) continue;
      const wins = rows.filter((row) => Number(row.won) === 1).length;
      const losses = rows.length - wins;
      const player = readPlayer(db, playerId);
      db.prepare(
        `UPDATE players SET pir_rating = ?, wins = ?, losses = ?, matches_played = ?, updated_at = ? WHERE id = ?`,
      ).run(
        Number(rows[0].rating_before),
        Math.max(0, player.wins - wins),
        Math.max(0, player.losses - losses),
        Math.max(0, player.matches_played - rows.length),
        now,
        playerId,
      );
    }
    db.prepare(`DELETE FROM rating_history WHERE match_id IN (${marks})`).run(...replay.map((row) => row.id));
    db.prepare(
      `UPDATE matches SET ratings_applied = 0, status = 'completed', result_status = 'pending', verified_at = NULL, updated_at = ? WHERE id IN (${marks})`,
    ).run(now, ...replay.map((row) => row.id));
    db.prepare(`UPDATE matches SET score_a = ?, score_b = ?, winner = ?, score_target = ? WHERE id = ?`).run(
      scoreA,
      scoreB,
      parsed.winner,
      parsed.target,
      matchId,
    );
    for (const row of replay) writeRatingUpdate(db, row.id, row.verifiedAt);
  });
}

export function leaderboard(
  db: DatabaseSync,
  scope: 'overall' | 'facility',
  facilityId: string | null,
  sort: 'rating' | 'improved' | 'matches',
) {
  const rows = db
    .prepare(
      `SELECT id, display_name, pir_rating, matches_played, wins, losses, demo, home_facility_id, leaderboard_opt_out
       FROM players WHERE COALESCE(leaderboard_opt_out, 0) = 0`,
    )
    .all() as {
    id: string;
    display_name: string;
    pir_rating: number;
    matches_played: number | bigint;
    wins: number | bigint;
    losses: number | bigint;
    demo: number | bigint;
    home_facility_id: string | null;
    leaderboard_opt_out: number | bigint;
  }[];
  const firstRating = db
    .prepare(
      `SELECT player_id, rating_before FROM rating_history h
       WHERE rowid = (SELECT rowid FROM rating_history WHERE player_id = h.player_id ORDER BY created_at, rowid LIMIT 1)`,
    )
    .all() as { player_id: string; rating_before: number }[];
  const start = new Map(firstRating.map((row) => [row.player_id, toPlayback(Number(row.rating_before))]));
  const facilities = db.prepare('SELECT id, name FROM facilities ORDER BY name').all() as { id: string; name: string }[];
  let list = rows.map((row) => {
    const rating = toPlayback(Number(row.pir_rating));
    const matches = Number(row.matches_played);
    const began = start.get(row.id);
    return {
      id: row.id,
      displayName: row.display_name,
      rating,
      category: categoryOf(rating),
      confidence: confidenceBand(matches),
      matchesPlayed: matches,
      provisional: isProvisional(matches),
      established: !isProvisional(matches),
      demo: Number(row.demo) === 1 || row.id.startsWith('demo-'),
      improvement: began === undefined ? 0 : Math.round((rating - began) * 100) / 100,
      homeFacilityId: row.home_facility_id,
    };
  });
  if (scope === 'facility' && facilityId) list = list.filter((row) => row.homeFacilityId === facilityId);
  const competitive = list.filter((row) => row.matchesPlayed >= COMPETITIVE_MIN_MATCHES);
  const provisional = list.filter((row) => row.matchesPlayed < COMPETITIVE_MIN_MATCHES);
  const compare = (a: (typeof list)[number], b: (typeof list)[number]) => {
    const primary =
      sort === 'improved' ? b.improvement - a.improvement : sort === 'matches' ? b.matchesPlayed - a.matchesPlayed : b.rating - a.rating;
    if (primary !== 0) return primary;
    return a.id.localeCompare(b.id);
  };
  competitive.sort(compare);
  provisional.sort(compare);
  return {
    scope,
    sort,
    minimumMatches: COMPETITIVE_MIN_MATCHES,
    facilities,
    competitive: competitive.map((row, index) => ({ rank: index + 1, ...row })),
    provisional: provisional.map((row) => ({ rank: null, ...row })),
  };
}

export type { ScoreTarget };
