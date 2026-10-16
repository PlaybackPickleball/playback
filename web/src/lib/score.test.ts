import { describe, expect, it } from 'vitest';
import { canMarkHighlight, scoreTap, tally, undoLast } from './score';

describe('manual score', () => {
  it('adds points and undoes the last one', () => {
    const events = [
      { team: 'A' as const, offsetMs: 1000 },
      { team: 'B' as const, offsetMs: 2000 },
      { team: 'A' as const, offsetMs: 3000 },
    ];
    expect(tally(events)).toEqual({ A: 2, B: 1 });
    expect(tally(undoLast(events))).toEqual({ A: 1, B: 1 });
    expect(undoLast([])).toEqual([]);
  });

  it('scores the team on the tapped side and ignores a second tap inside 400ms', () => {
    const sides = { left: 'A' as const, right: 'B' as const };
    const first = scoreTap({ scores: [], lastTapAt: null }, 'left', sides, 1000, 8000);
    expect(first.scores).toEqual([{ team: 'A', offsetMs: 8000 }]);
    const doubled = scoreTap(first, 'left', sides, 1399, 8200);
    expect(doubled).toBe(first);
    expect(doubled.scores).toEqual([{ team: 'A', offsetMs: 8000 }]);
    const swapped = { left: 'B' as const, right: 'A' as const };
    const right = scoreTap(first, 'right', swapped, 1400, 9000);
    expect(right.scores).toEqual([
      { team: 'A', offsetMs: 8000 },
      { team: 'A', offsetMs: 9000 },
    ]);
    const otherSide = scoreTap({ scores: [], lastTapAt: null }, 'right', sides, 5000, 12000);
    expect(otherSide.scores).toEqual([{ team: 'B', offsetMs: 12000 }]);
  });

  it('blocks highlight marks that are too close', () => {
    expect(canMarkHighlight([], 1000)).toBe(true);
    expect(canMarkHighlight([{ offsetMs: 1000 }], 2000)).toBe(false);
    expect(canMarkHighlight([{ offsetMs: 1000 }], 2500)).toBe(true);
  });
});
