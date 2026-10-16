import { describe, expect, it } from 'vitest';
import { deriveRallies, endForTeam, lastPointWindow, normalizePhone, rallySpans, reconcileSwitch, SEEK_LEAD_MS, switchIsDue } from './match';

describe('end switch', () => {
  it('never asks to switch ends, including when a team reaches 6 in a game to 11', () => {
    const five = Array.from({ length: 5 }, () => ({ team: 'A' as const, offsetMs: 1000 }));
    const sixA = [...five, { team: 'A' as const, offsetMs: 2000 }];
    const sixB = Array.from({ length: 6 }, (_, index) => ({ team: 'B' as const, offsetMs: index * 1000 }));
    const split = [
      ...Array.from({ length: 3 }, () => ({ team: 'A' as const, offsetMs: 1000 })),
      ...Array.from({ length: 3 }, () => ({ team: 'B' as const, offsetMs: 2000 })),
    ];
    expect(switchIsDue(five, [])).toBe(false);
    expect(switchIsDue(split, [])).toBe(false);
    expect(switchIsDue(sixA, [])).toBe(false);
    expect(switchIsDue(sixB, [])).toBe(false);
    expect(switchIsDue(sixA, [{ offsetMs: 2100 }])).toBe(false);
    expect(switchIsDue(sixB, [{ offsetMs: 2100 }], 'none')).toBe(false);
  });

  it('drops any stored switch so the score cannot move a team', () => {
    const six = Array.from({ length: 6 }, (_, index) => ({ team: 'A' as const, offsetMs: index * 1000 }));
    const stored = [{ offsetMs: 5000 }];
    expect(reconcileSwitch(six, stored)).toEqual([]);
    expect(reconcileSwitch(six.slice(0, 5), stored)).toEqual([]);
  });

  it('keeps each team on its starting end for the whole match', () => {
    const starting = { A: 1 as const, B: 2 as const };
    const switches = [{ offsetMs: 8000 }];
    expect(endForTeam('A', starting, switches, 7999)).toBe(1);
    expect(endForTeam('A', starting, switches, 8000)).toBe(1);
    expect(endForTeam('B', starting, switches, 8000)).toBe(2);
    expect(endForTeam('B', starting, [], 0)).toBe(2);
  });
});

describe('rally windows', () => {
  it('trims a short pause at each end and stars only the rally that contains the mark', () => {
    const rallies = deriveRallies(
      [
        { team: 'A', offsetMs: 8000 },
        { team: 'B', offsetMs: 16000 },
      ],
      [{ offsetMs: 4000 }, { offsetMs: 8000 }],
    );
    expect(rallies).toEqual([
      { index: 0, startMs: 1500, endMs: 6500, pointOffsetMs: 8000, scoringTeam: 'A', starred: true },
      { index: 1, startMs: 9500, endMs: 14500, pointOffsetMs: 16000, scoringTeam: 'B', starred: false },
    ]);
  });

  it('shrinks the trim when the rally is short', () => {
    const [rally] = deriveRallies([{ team: 'A', offsetMs: 2000 }], []);
    expect(rally.startMs).toBe(750);
    expect(rally.endMs).toBe(1250);
  });

  it('keeps starred rallies only when that mode is selected', () => {
    const rallies = deriveRallies(
      [
        { team: 'A', offsetMs: 8000 },
        { team: 'B', offsetMs: 16000 },
      ],
      [{ offsetMs: 2000 }],
    );
    expect(rallySpans(rallies, 'rallies')).toEqual([
      { startMs: 1500, endMs: 6500 },
      { startMs: 9500, endMs: 14500 },
    ]);
    expect(rallySpans(rallies, 'starred')).toEqual([{ startMs: 1500, endMs: 6500 }]);
  });
});

describe('last point replay', () => {
  it('selects the trimmed span since the previous point, or a few seconds before a first point', () => {
    expect(lastPointWindow([])).toBeNull();

    const only = [{ team: 'A' as const, offsetMs: 9000 }];
    expect(deriveRallies(only, [])[0]?.startMs).toBe(1500);
    expect(lastPointWindow(only)).toEqual({
      startMs: 6000,
      endMs: 9000,
      playStartMs: 6000,
      pointOffsetMs: 9000,
      scoringTeam: 'A',
    });
    expect(lastPointWindow([{ team: 'B', offsetMs: 2000 }])).toEqual({
      startMs: 0,
      endMs: 2000,
      playStartMs: 0,
      pointOffsetMs: 2000,
      scoringTeam: 'B',
    });

    const scores = [
      { team: 'A' as const, offsetMs: 8000 },
      { team: 'B' as const, offsetMs: 16000 },
    ];
    const rally = deriveRallies(scores, [])[1];
    expect(rally).toMatchObject({ startMs: 9500, endMs: 14500 });
    expect(lastPointWindow(scores)).toEqual({
      startMs: rally.startMs,
      endMs: rally.endMs,
      playStartMs: rally.startMs - SEEK_LEAD_MS,
      pointOffsetMs: 16000,
      scoringTeam: 'B',
    });

    const shortScores = [
      { team: 'A' as const, offsetMs: 8000 },
      { team: 'A' as const, offsetMs: 10000 },
    ];
    const short = deriveRallies(shortScores, [])[1];
    expect(short).toMatchObject({ startMs: 8750, endMs: 9250 });
    expect(lastPointWindow(shortScores)).toEqual({
      startMs: short.startMs,
      endMs: short.endMs,
      playStartMs: short.startMs - SEEK_LEAD_MS,
      pointOffsetMs: 10000,
      scoringTeam: 'A',
    });

    const early = [
      { team: 'A' as const, offsetMs: 1000 },
      { team: 'B' as const, offsetMs: 4000 },
    ];
    expect(lastPointWindow(early)?.playStartMs).toBe(0);
  });
});

describe('phone numbers', () => {
  it('keeps 8 to 15 digits and rejects anything else', () => {
    expect(normalizePhone('090 123 4567')).toBe('0901234567');
    expect(normalizePhone('+84 90 123 4567')).toBe('84901234567');
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('call me')).toBeNull();
  });
});
