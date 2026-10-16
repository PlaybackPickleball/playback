import { teamStrength } from './pir.js';

export type MatchmakingPlayer = {
  id: string;
  displayName?: string;
  name?: string;
  rating: number;
};

export type PairingSide = {
  id: string;
  displayName: string;
  rating: number;
};

export type Pairing = {
  teamA: [PairingSide, PairingSide];
  teamB: [PairingSide, PairingSide];
  strengthA: number;
  strengthB: number;
  gap: number;
};

export type MatchmakingResult = {
  options: Pairing[];
  pairings: Pairing[];
  recommendedIndex: number;
  gap: number;
  /** A recommendation, not an assignment. The page translates this code. */
  reason: 'closest_average_split';
};

export type MatchmakingRecommendation = MatchmakingResult;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function side(player: MatchmakingPlayer): PairingSide {
  return { id: player.id, displayName: player.displayName || player.name || player.id, rating: player.rating };
}

function pairing(left: [MatchmakingPlayer, MatchmakingPlayer], right: [MatchmakingPlayer, MatchmakingPlayer]): Pairing {
  const strengthA = round1(teamStrength([left[0].rating, left[1].rating]));
  const strengthB = round1(teamStrength([right[0].rating, right[1].rating]));
  return {
    teamA: [side(left[0]), side(left[1])],
    teamB: [side(right[0]), side(right[1])],
    strengthA,
    strengthB,
    gap: round1(Math.abs(strengthA - strengthB)),
  };
}

/** Three unique doubles pairings. The recommendation is the closest average-rating split. */
export function recommendDoubles(players: MatchmakingPlayer[]): MatchmakingRecommendation {
  if (players.length !== 4) throw new Error('need_four_players');
  const ids = new Set(players.map((player) => player.id));
  if (ids.size !== 4) throw new Error('duplicate_player');
  const [a, b, c, d] = [...players].sort((left, right) => left.id.localeCompare(right.id));
  const pairings = [
    pairing([a, b], [c, d]),
    pairing([a, c], [b, d]),
    pairing([a, d], [b, c]),
  ];
  let recommendedIndex = 0;
  for (let index = 1; index < pairings.length; index += 1) {
    if (pairings[index].gap < pairings[recommendedIndex].gap) recommendedIndex = index;
  }
  return {
    options: pairings,
    pairings,
    recommendedIndex,
    gap: pairings[recommendedIndex].gap,
    reason: 'closest_average_split',
  };
}
