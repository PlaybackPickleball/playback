import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY,
  passedBy,
  selectGroup,
  type PolicyEntry,
  type PolicySettings,
} from '../src/play/queuePolicy.js';

const T0 = Date.parse('2030-06-01T03:00:00Z');
const e = (id: string, minute: number, level: number, partySize = 1, bypassed = 0): PolicyEntry => ({
  id,
  joinedAt: T0 + minute * 60_000,
  level,
  partySize,
  bypassed,
});
const settings = (patch: Partial<PolicySettings>): PolicySettings => ({ ...DEFAULT_POLICY, ...patch });

describe('queue policy: fifo', () => {
  it('takes the four longest waiters in join order, whatever the input order', () => {
    const entries = [e('e', 5, 3.5), e('c', 3, 4.5), e('a', 1, 2.5), e('d', 4, 3.0), e('b', 2, 4.0)];
    const sel = selectGroup(entries, 4, settings({ mode: 'fifo' }))!;
    expect(sel.entryIds).toEqual(['a', 'b', 'c', 'd']);
    expect(sel.skippedAhead).toBe(false);
    expect(sel.passed).toEqual([]);
    expect(sel.reasonCode).toBe('fifo_order');
    expect(sel.reason).toMatch(/join order/);
  });

  it('returns null until four players are waiting', () => {
    expect(selectGroup([e('a', 1, 3), e('b', 2, 3), e('c', 3, 3)], 4, settings({ mode: 'fifo' }))).toBeNull();
    expect(selectGroup([], 4, settings({ mode: 'fifo' }))).toBeNull();
  });

  it('keeps the head and only steps over a party that does not fit', () => {
    const entries = [e('a', 1, 3, 2), e('b', 2, 3, 3), e('c', 3, 3, 1), e('d', 4, 3, 1)];
    const sel = selectGroup(entries, 4, settings({ mode: 'fifo' }))!;
    expect(sel.entryIds).toEqual(['a', 'c', 'd']);
    expect(sel.passed).toEqual([{ entryId: 'b', passedBy: 2 }]);
  });

  it('handles singles (two players)', () => {
    const sel = selectGroup([e('a', 1, 3), e('b', 2, 4), e('c', 3, 3)], 2, settings({ mode: 'fifo' }))!;
    expect(sel.entryIds).toEqual(['a', 'b']);
  });
});

describe('queue policy: skill', () => {
  const pool = [e('a', 1, 2.5), e('b', 2, 4.5), e('c', 3, 4.25), e('d', 4, 2.75), e('f', 5, 4.5), e('g', 6, 2.5), e('h', 7, 4.5), e('i', 8, 2.5)];

  it('groups the four closest ratings inside the band, ignoring join order', () => {
    const sel = selectGroup(pool, 4, settings({ mode: 'skill', skillBand: 0.5 }))!;
    // The low group a, d, g, i spans 0.25 (2.5 to 2.75); the high group b, c, f, h spans 0.25 as well. The group that joined earlier overall wins the tie (b, c, f, h are queue places 2, 3, 5, 7).
    expect(sel.entryIds).toEqual(['b', 'c', 'f', 'h']);
    expect(sel.spread).toBeCloseTo(0.25, 5);
    expect(sel.reasonCode).toBe('skill_match');
    expect(sel.skippedAhead).toBe(true);
  });

  it('prefers the tightest group over an earlier looser one', () => {
    const entries = [e('a', 1, 3.0), e('b', 2, 3.4), e('c', 3, 3.8), e('d', 4, 3.1), e('x', 5, 3.2), e('y', 6, 3.05)];
    const sel = selectGroup(entries, 4, settings({ mode: 'skill', skillBand: 0.5 }))!;
    expect(sel.entryIds).toEqual(['a', 'd', 'x', 'y']);
  });

  it('offers nothing when no four are inside the band', () => {
    const wide = [e('a', 1, 2.0), e('b', 2, 3.0), e('c', 3, 4.0), e('d', 4, 5.0)];
    expect(selectGroup(wide, 4, settings({ mode: 'skill', skillBand: 0.5 }))).toBeNull();
    expect(selectGroup(wide, 4, settings({ mode: 'skill', skillBand: 3 }))).not.toBeNull();
  });
});

describe('queue policy: hybrid', () => {
  // Join order: a b c d e f. Order-based group a b c d spans 1.5 levels; a c d e spans 0.2.
  const queue = (bypassedB = 0) => [
    e('a', 1, 3.0),
    e('b', 2, 4.5, 1, bypassedB),
    e('c', 3, 3.1),
    e('d', 4, 3.2),
    e('e', 5, 3.05),
    e('f', 6, 4.4),
  ];

  it('is the default mode, and keeps join order when nothing is clearly better', () => {
    expect(DEFAULT_POLICY.mode).toBe('hybrid');
    const even = [e('a', 1, 3.0), e('b', 2, 3.1), e('c', 3, 3.2), e('d', 4, 3.0), e('x', 5, 3.1)];
    const sel = selectGroup(even, 4)!;
    expect(sel.entryIds).toEqual(['a', 'b', 'c', 'd']);
    expect(sel.reasonCode).toBe('hybrid_in_order');
    expect(sel.skippedAhead).toBe(false);
  });

  it('skips ahead only within the documented limit, and says so', () => {
    const sel = selectGroup(queue(), 4, settings({ maxBypass: 3 }))!;
    expect(sel.entryIds).toEqual(['a', 'c', 'd', 'e']);
    expect(sel.reasonCode).toBe('hybrid_skip_ahead');
    expect(sel.passed).toEqual([{ entryId: 'b', passedBy: 3 }]);
    expect(sel.reason).toMatch(/Skipped ahead/);
    expect(sel.reason).toMatch(/nobody waits behind more than 3 later players/);
    expect(sel.reason).toMatch(/0\.2 levels apart instead of 1\.5/);
  });

  it('never lets anyone wait behind more than N later arrivals', () => {
    const tight = selectGroup(queue(), 4, settings({ maxBypass: 2 }))!;
    expect(tight.entryIds).toEqual(['a', 'b', 'c', 'd']); // skipping b would pass it by 3 players
    expect(tight.reasonCode).toBe('hybrid_in_order');
    // Earlier skips count: b was already passed once, so a further 3 would make 4 > 3.
    const history = selectGroup(queue(1), 4, settings({ maxBypass: 3 }))!;
    expect(history.entryIds).toEqual(['a', 'b', 'c', 'd']);
    expect(selectGroup(queue(), 4, settings({ maxBypass: 0 }))!.entryIds).toEqual(['a', 'b', 'c', 'd']);
  });

  it('needs a clear gain, so a tiny improvement does not move anyone', () => {
    const entries = [e('a', 1, 3.0), e('b', 2, 3.4), e('c', 3, 3.1), e('d', 4, 3.1), e('x', 5, 3.05)];
    // In order: a b c d spans 0.4. Skipping b gives a c d x spanning 0.1: gain 0.3 is enough at the default.
    expect(selectGroup(entries, 4, settings({ minSkillGain: 0.3 }))!.entryIds).toEqual(['a', 'c', 'd', 'x']);
    expect(selectGroup(entries, 4, settings({ minSkillGain: 0.35 }))!.entryIds).toEqual(['a', 'b', 'c', 'd']);
  });

  it('is deterministic', () => {
    const a = selectGroup(queue(), 4, DEFAULT_POLICY);
    const b = selectGroup(queue().reverse(), 4, DEFAULT_POLICY);
    expect(b).toEqual(a);
  });

  it('property: with single players nobody is ever passed by more than N later players', () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let run = 0; run < 300; run += 1) {
      const size = 4 + Math.floor(rnd() * 6);
      const maxBypass = Math.floor(rnd() * 6);
      const entries = Array.from({ length: size }, (_, i) => e(`p${i}`, i, 2.5 + Math.round(rnd() * 20) / 10, 1, Math.floor(rnd() * 2)));
      const sel = selectGroup(entries, 4, settings({ maxBypass }));
      if (!sel) continue;
      expect(sel.entryIds).toHaveLength(4);
      if (sel.skippedAhead) {
        for (const p of sel.passed) {
          const entry = entries.find((x) => x.id === p.entryId)!;
          expect(entry.bypassed + p.passedBy).toBeLessThanOrEqual(maxBypass);
        }
      }
    }
  });
});

describe('passedBy', () => {
  it('counts the players of the group who joined after each entry left behind', () => {
    const sorted = [e('a', 1, 3), e('b', 2, 3), e('c', 3, 3, 2), e('d', 4, 3)];
    expect(passedBy(sorted, ['a', 'c', 'd'])).toEqual([{ entryId: 'b', passedBy: 3 }]);
    expect(passedBy(sorted, ['a', 'b', 'c'])).toEqual([]);
  });
});
