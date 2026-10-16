import { describe, expect, it } from 'vitest';
import { applyMatchResult, confidence, expectedScore, PIR_K, teamStrength } from '../src/pir.js';

describe('PIR rating', () => {
  it('uses the documented Elo expected score', () => {
    expect(expectedScore(1600, 1400)).toBeCloseTo(1 / (1 + 10 ** ((1400 - 1600) / 400)), 12);
  });

  it('updates singles from opponent strength and is reproducible', () => {
    const teamA = [{ id: 'a', rating: 1600, matchesPlayed: 0 }];
    const teamB = [{ id: 'b', rating: 1400, matchesPlayed: 3 }];
    const once = applyMatchResult(teamA, teamB, 'A');
    expect(applyMatchResult(teamA, teamB, 'A')).toEqual(once);
    const winner = once.find((row) => row.id === 'a')!;
    const loser = once.find((row) => row.id === 'b')!;
    expect(winner.won).toBe(true);
    expect(winner.ratingAfter).toBe(1606);
    expect(loser.ratingAfter).toBe(1394);
    expect(winner.matchesPlayed).toBe(1);
    expect(winner.confidenceAfter).toBe(confidence(1));
    expect(loser.confidenceAfter).toBe(confidence(4));
  });

  it('rates doubles from average team strength and gives teammates the same point change', () => {
    expect(teamStrength([1600, 1500])).toBe(1550);
    const update = applyMatchResult(
      [
        { id: 'a1', rating: 1600, matchesPlayed: 2 },
        { id: 'a2', rating: 1500, matchesPlayed: 2 },
      ],
      [
        { id: 'b1', rating: 1400, matchesPlayed: 2 },
        { id: 'b2', rating: 1500, matchesPlayed: 2 },
      ],
      'A',
    );
    const first = update.find((row) => row.id === 'a1')!;
    const second = update.find((row) => row.id === 'a2')!;
    expect(first.ratingAfter - first.ratingBefore).toBe(second.ratingAfter - second.ratingBefore);
    const expected = expectedScore(1550, 1450);
    expect(first.ratingAfter).toBe(Math.round(1600 + PIR_K * (1 - expected)));
  });

  it('keeps confidence lower with fewer verified matches', () => {
    expect(confidence(0)).toBe(0);
    expect(confidence(1)).toBeLessThan(confidence(8));
    expect(confidence(8)).toBeLessThan(confidence(40));
    expect(confidence(1)).toBeCloseTo(1 / 9);
  });

  it('honors a different K factor', () => {
    const soft = applyMatchResult(
      [{ id: 'a', rating: 1500, matchesPlayed: 0 }],
      [{ id: 'b', rating: 1500, matchesPlayed: 0 }],
      'A',
      10,
    );
    const hard = applyMatchResult(
      [{ id: 'a', rating: 1500, matchesPlayed: 0 }],
      [{ id: 'b', rating: 1500, matchesPlayed: 0 }],
      'A',
      40,
    );
    const softDelta = soft[0].ratingAfter - soft[0].ratingBefore;
    const hardDelta = hard[0].ratingAfter - hard[0].ratingBefore;
    expect(softDelta).toBeLessThan(hardDelta);
  });
});
