/**
 * PlayBack Internal Rating (PIR).
 *
 * Elo-style rating for the functional MVP. This is not DUPR and it does not
 * use the DUPR scale (about 2.000 to 8.000). PIR starts at 1500 and moves
 * by whole points.
 *
 * Expected score:
 *   1 / (1 + 10 ^ ((opponentStrength - teamStrength) / 400))
 *
 * Update, with K = 24:
 *   rating + round(K * (actual - expected))
 *   actual is 1 for a win and 0 for a loss
 *
 * Doubles: a team's strength is the arithmetic mean of its players' ratings.
 * The expected score uses those two means. Each teammate receives the same
 * point change from that team expected score, added to their own rating.
 *
 * Confidence is matchesPlayed / (matchesPlayed + 8). It is lower with few
 * matches. It is reported beside the rating and is not an input to the
 * point change.
 *
 * `winner` is the host-confirmed result. This function accepts no video,
 * rally, line-call, or other computer-vision input. Future CV signals must
 * not be added as arguments and must not change the number.
 */

export const PIR_START = 1500;
export const PIR_SCALE = 400;
export const PIR_K = 24;
export const RATING_SYSTEM = 'PIR' as const;

export type PirPlayer = {
  id: string;
  rating: number;
  matchesPlayed: number;
};

export type RatingUpdate = {
  id: string;
  ratingBefore: number;
  ratingAfter: number;
  confidenceBefore: number;
  confidenceAfter: number;
  matchesPlayed: number;
  won: boolean;
};

export function expectedScore(teamStrength: number, opponentStrength: number): number {
  return 1 / (1 + 10 ** ((opponentStrength - teamStrength) / PIR_SCALE));
}

export function confidence(matchesPlayed: number): number {
  const played = Math.max(0, Math.floor(matchesPlayed));
  return played / (played + 8);
}

export function teamStrength(ratings: number[]): number {
  if (ratings.length === 0) throw new Error('empty_team');
  return ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length;
}

export function applyMatchResult(teamA: PirPlayer[], teamB: PirPlayer[], winner: 'A' | 'B', k = PIR_K): RatingUpdate[] {
  if (teamA.length === 0 || teamB.length === 0) throw new Error('empty_team');
  if (winner !== 'A' && winner !== 'B') throw new Error('winner_required');
  const strengthA = teamStrength(teamA.map((player) => player.rating));
  const strengthB = teamStrength(teamB.map((player) => player.rating));
  const expectedA = expectedScore(strengthA, strengthB);
  const actualA = winner === 'A' ? 1 : 0;
  const deltaA = k * (actualA - expectedA);
  const deltaB = -deltaA;

  const update = (players: PirPlayer[], delta: number, won: boolean): RatingUpdate[] =>
    players.map((player) => {
      const played = player.matchesPlayed + 1;
      return {
        id: player.id,
        ratingBefore: player.rating,
        ratingAfter: Math.round(player.rating + delta),
        confidenceBefore: confidence(player.matchesPlayed),
        confidenceAfter: confidence(played),
        matchesPlayed: played,
        won,
      };
    });

  return [...update(teamA, deltaA, winner === 'A'), ...update(teamB, deltaB, winner === 'B')];
}

export const GUEST_START_RATING = PIR_START;
export type TeamId = 'A' | 'B';

export function confidenceFromMatches(matchesPlayed: number): number {
  return confidence(matchesPlayed);
}

export type RatedPlayer = PirPlayer & { team: TeamId };

export type RatedRow = {
  id: string;
  previous: number;
  rating: number;
  confidence: number;
  matchesPlayed: number;
  won: boolean;
};

/** Host-confirmed winner only. Computer-vision signals are not an input. */
export function rateMatch(players: RatedPlayer[], winner: TeamId): RatedRow[] {
  return applyMatchResult(
    players.filter((player) => player.team === 'A'),
    players.filter((player) => player.team === 'B'),
    winner,
  ).map((update) => ({
    id: update.id,
    previous: update.ratingBefore,
    rating: update.ratingAfter,
    confidence: update.confidenceAfter,
    matchesPlayed: update.matchesPlayed,
    won: update.won,
  }));
}
