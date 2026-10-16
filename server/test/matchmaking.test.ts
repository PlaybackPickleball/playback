import { describe, expect, it } from 'vitest';
import { recommendDoubles } from '../src/matchmaking.js';

const four = [
  { id: 'demo-tuan', displayName: 'Tuấn Hoàng', rating: 1605 },
  { id: 'demo-an', displayName: 'An Nguyễn', rating: 1410 },
  { id: 'demo-mai', displayName: 'Mai Bùi', rating: 1380 },
  { id: 'demo-lan', displayName: 'Lan Phạm', rating: 1680 },
];

describe('doubles matchmaking', () => {
  it('returns three pairings and recommends the closest average split', () => {
    const result = recommendDoubles(four);
    expect(result.pairings).toHaveLength(3);
    expect(result.reason).toBe('closest_average_split');
    expect(result.options).toHaveLength(3);
    const gaps = result.pairings.map((option) => option.gap);
    expect(result.pairings[result.recommendedIndex].gap).toBe(Math.min(...gaps));
    expect(result.gap).toBe(result.pairings[result.recommendedIndex].gap);
  });

  it('does not depend on input order', () => {
    const forward = recommendDoubles(four);
    const backward = recommendDoubles([...four].reverse());
    expect(backward.pairings.map((option) => option.gap)).toEqual(forward.pairings.map((option) => option.gap));
    expect(backward.recommendedIndex).toBe(forward.recommendedIndex);
    const even = recommendDoubles([
      { id: 'a', displayName: 'A', rating: 1600 },
      { id: 'b', displayName: 'B', rating: 1500 },
      { id: 'c', displayName: 'C', rating: 1400 },
      { id: 'd', displayName: 'D', rating: 1300 },
    ]);
    expect(even.pairings[even.recommendedIndex].gap).toBe(0);
    expect(even.pairings.map((option) => option.gap).sort((left, right) => left - right)).toEqual([0, 100, 200]);
  });

  it('rejects anything other than four distinct players', () => {
    expect(() => recommendDoubles(four.slice(0, 3))).toThrow(/need_four_players/);
    expect(() => recommendDoubles([...four.slice(0, 3), four[0]])).toThrow(/duplicate_player/);
  });
});
