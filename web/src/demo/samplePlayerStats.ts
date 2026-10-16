import {
  SAMPLE_MATCHES,
  SAMPLE_PLAYER,
  type SampleMatch,
  type SampleOpponent,
} from './samplePlayerReport';

/** Pure helpers. Every number on the sample report comes from the match list through these. */

export function isWin(match: SampleMatch): boolean {
  return match.scoreFor > match.scoreAgainst;
}

export function recordOf(matches: readonly SampleMatch[]) {
  const wins = matches.filter(isWin).length;
  const losses = matches.length - wins;
  const played = matches.length;
  const winRatePercent = played === 0 ? null : Math.round((wins / played) * 100);
  return { wins, losses, played, winRatePercent };
}

/** Current streak from the newest match backwards. Positive = wins, negative = losses. */
export function currentStreak(matches: readonly SampleMatch[]): number {
  const ordered = [...matches].sort((x, y) => Date.parse(y.playedAt) - Date.parse(x.playedAt));
  if (ordered.length === 0) return 0;
  const first = isWin(ordered[0]);
  let count = 0;
  for (const match of ordered) {
    if (isWin(match) !== first) break;
    count += 1;
  }
  return first ? count : -count;
}

export function ratingChangeSum(matches: readonly SampleMatch[]): number {
  return matches.reduce((sum, match) => sum + match.ratingChange, 0);
}

export function currentRating(matches: readonly SampleMatch[], startRating = SAMPLE_PLAYER.startRating): number {
  return startRating + ratingChangeSum(matches);
}

/** Rating after each match, oldest first. */
export function ratingSeries(matches: readonly SampleMatch[], startRating = SAMPLE_PLAYER.startRating) {
  const ordered = [...matches].sort((x, y) => Date.parse(x.playedAt) - Date.parse(y.playedAt));
  let rating = startRating;
  return ordered.map((match) => {
    rating += match.ratingChange;
    return { at: match.playedAt, rating };
  });
}

/** Same shape as the live PIR confidence: n / (n + 8). */
export function ratingConfidence(verifiedMatches: number) {
  const value = verifiedMatches / (verifiedMatches + 8);
  const level: 'low' | 'medium' | 'high' = value < 0.4 ? 'low' : value < 0.7 ? 'medium' : 'high';
  return { value, level };
}

export function bestPartner(matches: readonly SampleMatch[], minMatches = 2) {
  const byPartner = new Map<string, SampleMatch[]>();
  for (const match of matches) byPartner.set(match.partner, [...(byPartner.get(match.partner) ?? []), match]);
  let best: { name: string; played: number; wins: number; winRatePercent: number } | null = null;
  for (const [name, list] of byPartner) {
    if (list.length < minMatches) continue;
    const { wins, played, winRatePercent } = recordOf(list);
    const rate = winRatePercent ?? 0;
    if (!best || rate > best.winRatePercent || (rate === best.winRatePercent && played > best.played)) {
      best = { name, played, wins, winRatePercent: rate };
    }
  }
  return best;
}

/** Highest rated opponent the player has faced, with the record against that opponent. */
export function toughestOpponent(matches: readonly SampleMatch[]) {
  const seen = new Map<string, { opponent: SampleOpponent; matches: SampleMatch[] }>();
  for (const match of matches) {
    for (const opponent of match.opponents) {
      const entry = seen.get(opponent.name) ?? { opponent, matches: [] };
      entry.matches.push(match);
      seen.set(opponent.name, entry);
    }
  }
  let top: { name: string; rating: number; played: number; wins: number } | null = null;
  for (const { opponent, matches: list } of seen.values()) {
    if (!top || opponent.rating > top.rating) {
      top = { name: opponent.name, rating: opponent.rating, played: list.length, wins: list.filter(isWin).length };
    }
  }
  return top;
}

export function sampleSummary() {
  return {
    matches: SAMPLE_MATCHES,
    record: recordOf(SAMPLE_MATCHES),
    streak: currentStreak(SAMPLE_MATCHES),
    rating: currentRating(SAMPLE_MATCHES),
    series: ratingSeries(SAMPLE_MATCHES),
    confidence: ratingConfidence(SAMPLE_MATCHES.length),
    partner: bestPartner(SAMPLE_MATCHES),
    opponent: toughestOpponent(SAMPLE_MATCHES),
  };
}
