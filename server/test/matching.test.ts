import { describe, expect, it } from 'vitest';
import { haversineKm } from '../src/geo.js';
import {
  WEIGHTS,
  evaluateCandidate,
  evaluateMatch,
  levelFits,
  levelFromPir,
  rankCandidates,
  rankMatches,
  slotFit,
  type Candidate,
  type SearchContext,
  type Seeker,
  type Target,
} from '../src/play/matching.js';

const MAIN = { latitude: 10.803, longitude: 106.741 };
const BINH_THANH = { latitude: 10.791, longitude: 106.716 }; // about 3 km
const QUAN_7 = { latitude: 10.738, longitude: 106.71 }; // about 8 km
const NOW = '2030-06-01T10:00';

const ctx = (over: Partial<SearchContext> = {}): SearchContext => ({
  nowLocal: NOW,
  radiusKm: 5,
  format: 'doubles',
  start: { kind: 'asap' },
  ...over,
});
const seeker = (over: Partial<Seeker> = {}): Seeker => ({ id: 'me', pir: 1500, matchesPlayed: 20, location: MAIN, ...over });
const target = (over: Partial<Target> = {}): Target => ({
  id: 't1',
  start: '2030-06-01T18:00',
  end: '2030-06-01T19:00',
  location: MAIN,
  slotAvailable: true,
  verified: true,
  format: 'doubles',
  openSeats: 1,
  minLevel: 3.0,
  maxLevel: 3.5,
  ...over,
});
const asMatch = (t: Target) => ({ ...t, busy: false, hostReliability: null });
const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  id: 'c1',
  pir: 1480,
  matchesPlayed: 20,
  location: MAIN,
  matchInviteOptIn: true,
  availabilityOptedIn: true,
  radiusKm: 5,
  format: 'doubles',
  windows: [],
  busy: false,
  reliability: null,
  ...over,
});

describe('matching: hard filters', () => {
  it('the demo facilities sit about 3 km and 8 km from the main one', () => {
    expect(haversineKm(MAIN, BINH_THANH)).toBeGreaterThan(2.5);
    expect(haversineKm(MAIN, BINH_THANH)).toBeLessThan(3.5);
    expect(haversineKm(MAIN, QUAN_7)).toBeGreaterThan(7);
  });

  it('excludes the facility beyond 5 km, keeps the 3 km one, and widening the radius brings the far one back', () => {
    const matches = [
      asMatch(target({ id: 'near', location: BINH_THANH })),
      asMatch(target({ id: 'far', location: QUAN_7 })),
    ];
    const narrow = rankMatches(seeker(), matches, ctx());
    expect(narrow.ranked.map((r) => r.item.id)).toEqual(['near']);
    expect(narrow.excluded.outside_radius).toBe(1);
    const wide = rankMatches(seeker(), matches, ctx({ radiusKm: 10 }));
    expect(wide.ranked.map((r) => r.item.id).sort()).toEqual(['far', 'near']);
  });

  it('drops unavailable slots, full matches, busy players, wrong format and past starts', () => {
    const cases: [Partial<Target> & { busy?: boolean }, string][] = [
      [{ slotAvailable: false }, 'slot_unavailable'],
      [{ openSeats: 0 }, 'no_open_seat'],
      [{ busy: true }, 'busy'],
      [{ format: 'singles' }, 'format_mismatch'],
      [{ start: '2030-06-01T09:00', end: '2030-06-01T10:00' }, 'past'],
      [{ minLevel: 5, maxLevel: 6 }, 'level_outside_range'],
    ];
    for (const [over, reason] of cases) {
      const { busy, ...rest } = over;
      const out = evaluateMatch(seeker(), target(rest), ctx(), { busy: busy ?? false, hostReliability: null });
      expect(out).toEqual({ eligible: false, reason });
    }
  });

  it('keeps an unverified slot but warns about it', () => {
    const out = evaluateMatch(seeker(), target({ verified: false }), ctx(), { busy: false, hostReliability: null });
    expect(out.eligible).toBe(true);
    if (out.eligible) expect(out.result.warnings.join(' ')).toMatch(/not verified/i);
  });

  it('excludes candidates who are opted out, unavailable, busy, in the wrong format, or too far', () => {
    const slot = target({ openSeats: 3 });
    const bad: [Partial<Candidate>, string][] = [
      [{ matchInviteOptIn: false }, 'not_opted_in'],
      [{ availabilityOptedIn: false }, 'not_opted_in'],
      [{ busy: true }, 'busy'],
      [{ format: 'singles' }, 'format_mismatch'],
      [{ location: QUAN_7 }, 'outside_radius'],
      [{ radiusKm: 1, location: BINH_THANH }, 'outside_radius'],
    ];
    for (const [over, reason] of bad) {
      expect(evaluateCandidate(candidate(over), slot, ctx())).toEqual({ eligible: false, reason });
    }
    expect(evaluateCandidate(candidate(), slot, ctx()).eligible).toBe(true);
    const ranked = rankCandidates([candidate({ id: 'ok' }), candidate({ id: 'out', matchInviteOptIn: false }), candidate({ id: 'busy', busy: true })], slot, ctx());
    expect(ranked.ranked.map((r) => r.item.id)).toEqual(['ok']);
  });

  it('does not exclude beginners or players with few matches for limited history', () => {
    const range = { minLevel: 3.0, maxLevel: 3.5 };
    expect(levelFromPir(1350)).toBeCloseTo(2.75);
    expect(levelFits(1350, 0, range.minLevel, range.maxLevel)).toBe(true); // brand new, level 2.75
    expect(levelFits(1300, 4, range.minLevel, range.maxLevel)).toBe(true); // beginner, 4 matches
    // An established player who is truly far outside the range is still out.
    expect(levelFits(1300, 60, range.minLevel, range.maxLevel)).toBe(false);
    const asCandidate = evaluateCandidate(candidate({ id: 'new', pir: 1350, matchesPlayed: 0 }), target({ openSeats: 3 }), ctx());
    expect(asCandidate.eligible).toBe(true);
    const asSeeker = evaluateMatch(seeker({ pir: 1350, matchesPlayed: 0 }), target(), ctx(), { busy: false, hostReliability: null });
    expect(asSeeker.eligible).toBe(true);
  });
});

describe('matching: ranking', () => {
  it('uses weights of 45/25/20/10', () => {
    expect(WEIGHTS).toEqual({ skill: 0.45, schedule: 0.25, distance: 0.2, reliability: 0.1 });
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  it('ranks a closer match with closer skill higher', () => {
    const best = asMatch(target({ id: 'best', location: MAIN, minLevel: 3.3, maxLevel: 3.7 }));
    const worse = asMatch(target({ id: 'worse', location: BINH_THANH, minLevel: 3.05, maxLevel: 3.4 }));
    const out = rankMatches(seeker(), [worse, best], ctx());
    expect(out.ranked.map((r) => r.item.id)).toEqual(['best', 'worse']);
    expect(out.ranked[0].result.score).toBeGreaterThan(out.ranked[1].result.score);
    const [a, b] = out.ranked.map((r) => r.result.factors);
    expect(a.skill.score).toBeGreaterThan(b.skill.score);
    expect(a.distance.score).toBeGreaterThan(b.distance.score);
  });

  it('is deterministic whatever the input order, and ties break by id', () => {
    const items = ['d', 'b', 'a', 'c'].map((id) => asMatch(target({ id })));
    const first = rankMatches(seeker(), items, ctx()).ranked.map((r) => r.item.id);
    const second = rankMatches(seeker(), [...items].reverse(), ctx()).ranked.map((r) => r.item.id);
    expect(first).toEqual(['a', 'b', 'c', 'd']);
    expect(second).toEqual(first);
    const again = rankMatches(seeker(), items, ctx());
    expect(JSON.stringify(again)).toBe(JSON.stringify(rankMatches(seeker(), items, ctx())));
  });

  it('counts reliability only with enough real history, otherwise neutral', () => {
    const slot = target({ openSeats: 3 });
    const thin = evaluateCandidate(candidate({ reliability: { sample: 2, rate: 0 } }), slot, ctx());
    const none = evaluateCandidate(candidate({ reliability: null }), slot, ctx());
    const solid = evaluateCandidate(candidate({ reliability: { sample: 12, rate: 0.5 } }), slot, ctx());
    const poor = evaluateCandidate(candidate({ reliability: { sample: 12, rate: 0.1 } }), slot, ctx());
    if (!thin.eligible || !none.eligible || !solid.eligible || !poor.eligible) throw new Error('expected eligible');
    expect(thin.result.factors.reliability.score).toBe(50);
    expect(thin.result.score).toBe(none.result.score); // a 0% record on 2 games does not count against anyone
    expect(solid.result.factors.reliability.score).toBe(50);
    expect(poor.result.score).toBeLessThan(solid.result.score);
  });

  it('lets rating confidence pull skill toward neutral', () => {
    const slot = target({ openSeats: 3, minLevel: 3.3, maxLevel: 3.7 });
    const sure = evaluateCandidate(candidate({ pir: 1500, matchesPlayed: 80 }), slot, ctx());
    const unsure = evaluateCandidate(candidate({ pir: 1500, matchesPlayed: 0 }), slot, ctx());
    if (!sure.eligible || !unsure.eligible) throw new Error('expected eligible');
    expect(sure.result.factors.skill.score).toBeGreaterThan(unsure.result.factors.skill.score);
    expect(unsure.result.explanation).toMatch(/provisional/);
  });

  it('explains every result in plain words with per-factor scores and the estimate note', () => {
    const out = evaluateMatch(seeker(), target(), ctx(), { busy: false, hostReliability: null });
    if (!out.eligible) throw new Error('expected eligible');
    const { factors, explanation, disclaimer } = out.result;
    for (const key of ['skill', 'schedule', 'distance', 'reliability'] as const) {
      expect(factors[key].score).toBeGreaterThanOrEqual(0);
      expect(factors[key].score).toBeLessThanOrEqual(100);
      expect(factors[key].note.length).toBeGreaterThan(10);
    }
    expect(factors.reliability.note).toMatch(/not enough game history/i);
    expect(explanation).toMatch(/km away/);
    expect(disclaimer).toMatch(/estimates, not guarantees/);
    expect(explanation).toContain(disclaimer);
  });

  it('prefers a start closer to the requested time', () => {
    const out = rankMatches(
      seeker(),
      [asMatch(target({ id: 'late', start: '2030-06-01T21:00', end: '2030-06-01T22:00' })), asMatch(target({ id: 'on', start: '2030-06-01T18:00' }))],
      ctx({ start: { kind: 'target', at: '2030-06-01T18:00' } }),
    );
    expect(out.ranked[0].item.id).toBe('on');
  });

  it('slotFit rescales schedule and distance, and drops slots out of range', () => {
    const near = slotFit(target(), seeker(), ctx());
    const far = slotFit(target({ location: QUAN_7 }), seeker(), ctx());
    expect('fit' in near && near.fit > 0).toBe(true);
    expect(far).toEqual({ excluded: 'outside_radius' });
  });
});
