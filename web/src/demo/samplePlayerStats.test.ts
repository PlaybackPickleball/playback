import { describe, expect, it } from 'vitest';
import { SAMPLE_MATCHES, SAMPLE_PLAYER } from './samplePlayerReport';
import {
  bestPartner,
  currentRating,
  currentStreak,
  ratingChangeSum,
  ratingConfidence,
  ratingSeries,
  recordOf,
  sampleSummary,
  toughestOpponent,
} from './samplePlayerStats';

describe('sample player report numbers', () => {
  const newestFirst = [...SAMPLE_MATCHES].sort((x, y) => Date.parse(y.playedAt) - Date.parse(x.playedAt));

  it('derives wins, losses and win rate from the match list', () => {
    const wins = SAMPLE_MATCHES.filter((m) => m.scoreFor > m.scoreAgainst).length;
    const record = recordOf(SAMPLE_MATCHES);
    expect(record.played).toBe(SAMPLE_MATCHES.length);
    expect(record.wins).toBe(wins);
    expect(record.losses).toBe(SAMPLE_MATCHES.length - wins);
    expect(record.winRatePercent).toBe(Math.round((wins / SAMPLE_MATCHES.length) * 100));
    expect(recordOf([]).winRatePercent).toBeNull();
  });

  it('counts the current streak from the newest match', () => {
    let expected = 0;
    const newestIsWin = newestFirst[0].scoreFor > newestFirst[0].scoreAgainst;
    for (const match of newestFirst) {
      if (match.scoreFor > match.scoreAgainst !== newestIsWin) break;
      expected += 1;
    }
    expect(currentStreak(SAMPLE_MATCHES)).toBe(newestIsWin ? expected : -expected);
    // Order of the input list does not change the answer.
    expect(currentStreak([...SAMPLE_MATCHES].reverse())).toBe(currentStreak(SAMPLE_MATCHES));
  });

  it('sums rating changes and the series ends at the current rating', () => {
    const sum = SAMPLE_MATCHES.map((m) => m.ratingChange).reduce((x, y) => x + y, 0);
    expect(ratingChangeSum(SAMPLE_MATCHES)).toBe(sum);
    expect(currentRating(SAMPLE_MATCHES)).toBe(SAMPLE_PLAYER.startRating + sum);
    const series = ratingSeries(SAMPLE_MATCHES);
    expect(series).toHaveLength(SAMPLE_MATCHES.length);
    expect(series[series.length - 1].rating).toBe(SAMPLE_PLAYER.startRating + sum);
  });

  it('keeps every win positive and every loss negative in rating change', () => {
    for (const match of SAMPLE_MATCHES) {
      expect(match.scoreFor).not.toBe(match.scoreAgainst);
      expect(match.ratingChange > 0).toBe(match.scoreFor > match.scoreAgainst);
    }
  });

  it('finds the best partner and toughest opponent from the matches', () => {
    const partner = bestPartner(SAMPLE_MATCHES);
    const opponent = toughestOpponent(SAMPLE_MATCHES);
    expect(partner).not.toBeNull();
    expect(opponent).not.toBeNull();
    const withPartner = SAMPLE_MATCHES.filter((m) => m.partner === partner!.name);
    expect(partner!.played).toBe(withPartner.length);
    expect(partner!.wins).toBe(withPartner.filter((m) => m.scoreFor > m.scoreAgainst).length);
    const highest = Math.max(...SAMPLE_MATCHES.flatMap((m) => m.opponents.map((o) => o.rating)));
    expect(opponent!.rating).toBe(highest);
  });

  it('maps verified matches to low, medium or high confidence', () => {
    expect(ratingConfidence(2).level).toBe('low');
    expect(ratingConfidence(SAMPLE_MATCHES.length).level).toBe('medium');
    expect(ratingConfidence(40).level).toBe('high');
    expect(sampleSummary().confidence.value).toBeCloseTo(12 / 20);
  });
});
