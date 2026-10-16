/**
 * Playback Rating 1.0.
 *
 * One rating per player. This is the pickleball scale, not DUPR and not a raw Elo total.
 *   Beginner 2.0–2.9, Intermediate 3.0–3.9, Advanced 4.0–4.9, Expert 5.0+.
 *
 * Legacy rows may still store an Elo-style integer in `players.pir_rating` (1500 was the old start).
 *   playback = 3.5 + (elo - 1500) / 200
 *   so 1500 → 3.50 and 200 stored points → 1.00 level.
 * A stored value below 100 is already on this scale. New writes store the scale directly
 * (3.42, not 1484). `toPlayback` is the only read conversion. UI, matchmaking, and history
 * show the scale.
 *
 * Team rating = arithmetic mean of that side.
 *   ExpectedA = 1 / (1 + 10 ^ ((TeamB - TeamA) / 0.8))
 *   ExpectedB = 1 - ExpectedA
 *   rawDelta  = K * (actual - expected) * scoreModifier
 *   K = 0.08 while the player has fewer than 5 verified matches (provisional)
 *   K = 0.04 from the 5th verified match on (established)
 * Each player moves from their own pre-match rating and their own K.
 * The stored result is the rating rounded to 0.01. The history delta is
 * ratingAfter - ratingBefore, so the row adds up.
 *
 * Score modifier is always in [0.25, 1.25], so it cannot flip the sign of (actual - expected).
 *   marginRatio = |winner - loser| / target
 *   decisive    = 6/11          // 11–5
 *   raw         = marginRatio / decisive
 *   modifier    = clamp(raw, 0.25, 1.25)
 *   11–9 → 0.333 (close), 11–5 → 1 (decisive), 11–1 and 11–0 → 1.25 (dominant, strict cap).
 *   Games to 15 and 21 use the same ratio, including win-by-two past the target (12–10, 16–14, 22–20).
 *
 * Equal K is zero-sum before rounding: the two sides use opposite (actual - expected)
 * and the same K, so the four raw deltas sum to 0. Rounding to 0.01 can leave a residue
 * of at most 0.01 per player. Mixed K is not zero-sum. A provisional player (K 0.08)
 * moves twice as far as an established player (K 0.04) in the same match. That is the
 * deviation from equal weighting. Confidence does not scale the delta.
 *
 * Confidence is a separate label, not a probability:
 *   0–4 verified matches Low, 5–19 Medium, 20+ High.
 * Opponent reliability, recency, and opponent diversity are named only as future inputs.
 * They are not folded into the label or the K.
 *
 * Self-selected starts (Beginner 2.5, Intermediate 3.5, Advanced 4.5, Expert 5.0,
 * or a precise number from 2.00 to 8.00) are written with zero verified matches.
 * They are provisional and never established.
 *
 * This function does not read the database and does not treat a recording as a result.
 * Callers apply a verified result at most once.
 */

export const ALGORITHM_VERSION = 'playback-rating-1.0' as const;
export const RATING_SCALE = 0.8;
export const K_PROVISIONAL = 0.08;
export const K_ESTABLISHED = 0.04;
export const ESTABLISHED_MATCHES = 5;
export const MODIFIER_FLOOR = 0.25;
export const MODIFIER_CAP = 1.25;
export const ELO_PIVOT = 1500;
export const ELO_PER_LEVEL = 200;
export const ELO_LEVEL_AT_PIVOT = 3.5;
export const COMPETITIVE_MIN_MATCHES = 5;

export const START_RATINGS = {
  beginner: 2.5,
  intermediate: 3.5,
  advanced: 4.5,
  expert: 5.0,
} as const;

export type StartCategory = keyof typeof START_RATINGS;
export type ScoreTarget = 11 | 15 | 21;
export type ConfidenceBand = 'low' | 'medium' | 'high';
export type RatingCategory = 'beginner' | 'intermediate' | 'advanced' | 'expert';
export type ExplanationCode =
  | 'beat_stronger'
  | 'expected_win'
  | 'lost_to_weaker'
  | 'expected_loss'
  | 'increased'
  | 'decreased'
  | 'unchanged';

export type RatedSide = {
  id: string;
  rating: number;
  matchesPlayed: number;
};

export type RatingUpdate = {
  id: string;
  ratingBefore: number;
  ratingAfter: number;
  delta: number;
  confidenceBefore: ConfidenceBand;
  confidenceAfter: ConfidenceBand;
  matchesPlayed: number;
  won: boolean;
  k: number;
  expected: number;
  modifier: number;
  explanation: ExplanationCode;
  algorithmVersion: typeof ALGORITHM_VERSION;
};

const DECISIVE_RATIO = 6 / 11;

export function roundRating(value: number): number {
  return Math.round(value * 100) / 100;
}

export function isLegacyElo(value: number): boolean {
  return Number.isFinite(value) && value >= 100;
}

/** Elo integer → pickleball scale. Values already on the scale pass through, rounded to 0.01. */
export function toPlayback(stored: number): number {
  if (!Number.isFinite(stored)) return START_RATINGS.intermediate;
  if (isLegacyElo(stored)) return roundRating(ELO_LEVEL_AT_PIVOT + (stored - ELO_PIVOT) / ELO_PER_LEVEL);
  return roundRating(stored);
}

export function eloToPlayback(elo: number): number {
  return toPlayback(elo);
}

export function isProvisional(matchesPlayed: number): boolean {
  return Math.max(0, Math.floor(matchesPlayed)) < ESTABLISHED_MATCHES;
}

export function kFactor(matchesPlayed: number): number {
  return isProvisional(matchesPlayed) ? K_PROVISIONAL : K_ESTABLISHED;
}

export function confidenceBand(matchesPlayed: number): ConfidenceBand {
  const n = Math.max(0, Math.floor(matchesPlayed));
  if (n >= 20) return 'high';
  if (n >= 5) return 'medium';
  return 'low';
}

/**
 * Ranking weight for Play Now tolerance only. Not a probability and not shown as one.
 * Low history keeps the wide window so beginners are not filtered out.
 */
export function confidenceWeight(matchesPlayed: number): number {
  const band = confidenceBand(matchesPlayed);
  if (band === 'high') return 0.85;
  if (band === 'medium') return 0.55;
  return 0.15;
}

export function categoryOf(rating: number): RatingCategory {
  if (rating >= 5) return 'expert';
  if (rating >= 4) return 'advanced';
  if (rating >= 3) return 'intermediate';
  return 'beginner';
}

export function teamStrength(ratings: number[]): number {
  if (ratings.length === 0) throw new Error('empty_team');
  return ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length;
}

export function expectedScore(teamRating: number, opponentRating: number): number {
  return 1 / (1 + 10 ** ((opponentRating - teamRating) / RATING_SCALE));
}

export function scoreModifier(scoreA: number, scoreB: number, target: ScoreTarget): number {
  const margin = Math.abs(scoreA - scoreB);
  const raw = margin / target / DECISIVE_RATIO;
  return Math.min(MODIFIER_CAP, Math.max(MODIFIER_FLOOR, raw));
}

export function explainResult(won: boolean, expected: number, delta: number): ExplanationCode {
  if (Math.abs(delta) < 0.005) {
    if (won && expected >= 0.5) return 'expected_win';
    if (!won && expected <= 0.5) return 'expected_loss';
    return 'unchanged';
  }
  if (won && expected < 0.5) return 'beat_stronger';
  if (won && expected >= 0.6) return 'expected_win';
  if (!won && expected > 0.5) return 'lost_to_weaker';
  if (!won && expected <= 0.4) return 'expected_loss';
  return won ? 'increased' : 'decreased';
}

export function startingRating(category: StartCategory, precise?: number): number {
  if (precise === undefined) return START_RATINGS[category];
  if (!Number.isFinite(precise) || precise < 2 || precise > 8) throw new Error('invalid_start');
  return roundRating(precise);
}

export type ParsedScore = { ok: true; winner: 'A' | 'B'; target: ScoreTarget } | { ok: false; error: 'invalid_target' | 'invalid_score' | 'win_by_two' };

export function parseGameScore(scoreA: number, scoreB: number, target: number): ParsedScore {
  if (target !== 11 && target !== 15 && target !== 21) return { ok: false, error: 'invalid_target' };
  if (!Number.isInteger(scoreA) || !Number.isInteger(scoreB) || scoreA < 0 || scoreB < 0) return { ok: false, error: 'invalid_score' };
  if (scoreA === scoreB) return { ok: false, error: 'win_by_two' };
  const hi = Math.max(scoreA, scoreB);
  const lo = Math.min(scoreA, scoreB);
  if (hi < target || hi > target + 40) return { ok: false, error: 'invalid_score' };
  if (hi - lo < 2) return { ok: false, error: 'win_by_two' };
  if (hi > target && hi - lo !== 2) return { ok: false, error: 'invalid_score' };
  return { ok: true, winner: scoreA > scoreB ? 'A' : 'B', target };
}

export function applyPlaybackResult(
  teamA: RatedSide[],
  teamB: RatedSide[],
  scoreA: number,
  scoreB: number,
  target: ScoreTarget,
): RatingUpdate[] {
  if (teamA.length === 0 || teamB.length === 0) throw new Error('empty_team');
  const parsed = parseGameScore(scoreA, scoreB, target);
  if (!parsed.ok) throw new Error(parsed.error);
  const strengthA = teamStrength(teamA.map((player) => player.rating));
  const strengthB = teamStrength(teamB.map((player) => player.rating));
  const expectedA = expectedScore(strengthA, strengthB);
  const expectedB = 1 - expectedA;
  const modifier = scoreModifier(scoreA, scoreB, target);
  if (modifier <= 0) throw new Error('modifier_not_positive');

  const side = (players: RatedSide[], expected: number, won: boolean): RatingUpdate[] =>
    players.map((player) => {
      const actual = won ? 1 : 0;
      const k = kFactor(player.matchesPlayed);
      const raw = k * (actual - expected) * modifier;
      if (raw !== 0 && Math.sign(raw) !== Math.sign(actual - expected)) throw new Error('modifier_flipped_sign');
      const ratingBefore = roundRating(player.rating);
      const ratingAfter = roundRating(ratingBefore + raw);
      const delta = roundRating(ratingAfter - ratingBefore);
      const played = Math.max(0, Math.floor(player.matchesPlayed)) + 1;
      return {
        id: player.id,
        ratingBefore,
        ratingAfter,
        delta,
        confidenceBefore: confidenceBand(player.matchesPlayed),
        confidenceAfter: confidenceBand(played),
        matchesPlayed: played,
        won,
        k,
        expected,
        modifier,
        explanation: explainResult(won, expected, delta),
        algorithmVersion: ALGORITHM_VERSION,
      };
    });

  return [
    ...side(teamA, expectedA, parsed.winner === 'A'),
    ...side(teamB, expectedB, parsed.winner === 'B'),
  ];
}
