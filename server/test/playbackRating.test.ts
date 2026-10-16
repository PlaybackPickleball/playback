import { describe, expect, it } from 'vitest';
import {
  ESTABLISHED_MATCHES,
  K_ESTABLISHED,
  K_PROVISIONAL,
  MODIFIER_CAP,
  START_RATINGS,
  applyPlaybackResult,
  categoryOf,
  confidenceBand,
  expectedScore,
  isProvisional,
  parseGameScore,
  roundRating,
  scoreModifier,
  startingRating,
  teamStrength,
  toPlayback,
} from '../src/playbackRating.js';
import { levelFits, levelFromPir } from '../src/play/matching.js';

const side = (id: string, rating: number, matchesPlayed = 0) => ({ id, rating, matchesPlayed });

describe('Playback Rating scale', () => {
  it('maps a legacy Elo integer and leaves a scale value alone', () => {
    expect(toPlayback(1500)).toBeCloseTo(3.5, 5);
    expect(toPlayback(1300)).toBeCloseTo(2.5, 5);
    expect(toPlayback(1700)).toBeCloseTo(4.5, 5);
    expect(toPlayback(3.42)).toBeCloseTo(3.42, 5);
  });

  it('starts provisional at the self-selected marks and never established', () => {
    expect(START_RATINGS).toEqual({ beginner: 2.5, intermediate: 3.5, advanced: 4.5, expert: 5.0 });
    expect(startingRating('beginner')).toBe(2.5);
    expect(startingRating('intermediate')).toBe(3.5);
    expect(startingRating('advanced')).toBe(4.5);
    expect(startingRating('expert')).toBe(5.0);
    expect(startingRating('intermediate', 3.25)).toBeCloseTo(3.25, 5);
    expect(isProvisional(0)).toBe(true);
    expect(isProvisional(ESTABLISHED_MATCHES - 1)).toBe(true);
    expect(isProvisional(ESTABLISHED_MATCHES)).toBe(false);
    expect(categoryOf(2.9)).toBe('beginner');
    expect(categoryOf(3)).toBe('intermediate');
    expect(categoryOf(3.9)).toBe('intermediate');
    expect(categoryOf(4)).toBe('advanced');
    expect(categoryOf(4.9)).toBe('advanced');
    expect(categoryOf(5)).toBe('expert');
  });

  it('bands confidence from verified matches only', () => {
    expect(confidenceBand(0)).toBe('low');
    expect(confidenceBand(4)).toBe('low');
    expect(confidenceBand(5)).toBe('medium');
    expect(confidenceBand(19)).toBe('medium');
    expect(confidenceBand(20)).toBe('high');
    expect(confidenceBand(40)).toBe('high');
  });
});

describe('Playback Rating updates', () => {
  it('gives a bigger gain for beating a stronger team than a weaker one', () => {
    const upset = applyPlaybackResult([side('a', 2.5)], [side('b', 4.5, 30)], 11, 5, 11);
    const favorite = applyPlaybackResult([side('a', 3.8, 30)], [side('b', 3.2)], 11, 5, 11);
    const up = upset.find((row) => row.id === 'a')!;
    const fav = favorite.find((row) => row.id === 'a')!;
    expect(up.won).toBe(true);
    expect(up.delta).toBeGreaterThan(0);
    expect(fav.delta).toBeGreaterThan(0);
    expect(up.delta).toBeGreaterThan(fav.delta);
    expect(up.explanation).toBe('beat_stronger');
    expect(fav.explanation).toBe('expected_win');
    expect(fav.k).toBe(K_ESTABLISHED);
    expect(upset.find((row) => row.id === 'b')!.delta).toBeLessThan(0);
    expect(favorite.find((row) => row.id === 'b')!.explanation).toBe('expected_loss');
  });

  it('rates doubles from the average of the two ratings', () => {
    expect(teamStrength([3.4, 3.6])).toBeCloseTo(3.5, 5);
    const update = applyPlaybackResult(
      [side('a1', 3.4), side('a2', 3.6)],
      [side('b1', 3.2), side('b2', 3.2)],
      11,
      7,
      11,
    );
    const first = update.find((row) => row.id === 'a1')!;
    const second = update.find((row) => row.id === 'a2')!;
    expect(first.delta).toBe(second.delta);
    const expected = expectedScore(3.5, 3.2);
    const modifier = scoreModifier(11, 7, 11);
    expect(first.ratingAfter).toBe(roundRating(3.4 + K_PROVISIONAL * (1 - expected) * modifier));
  });

  it('caps a blowout without flipping the sign of the win or the loss', () => {
    expect(scoreModifier(11, 9, 11)).toBeCloseTo(2 / 6, 5);
    expect(scoreModifier(11, 5, 11)).toBeCloseTo(1, 5);
    expect(scoreModifier(11, 1, 11)).toBe(MODIFIER_CAP);
    expect(scoreModifier(11, 0, 11)).toBe(MODIFIER_CAP);
    expect(scoreModifier(15, 13, 15)).toBeGreaterThan(0);
    expect(parseGameScore(12, 10, 11).ok).toBe(true);
    expect(parseGameScore(11, 10, 11).ok).toBe(false);
    expect(parseGameScore(13, 10, 11).ok).toBe(false);
    const close = applyPlaybackResult([side('a', 3.5)], [side('b', 3.5)], 11, 9, 11);
    const blowout = applyPlaybackResult([side('a', 3.5)], [side('b', 3.5)], 11, 0, 11);
    expect(close[0].delta).toBeGreaterThan(0);
    expect(blowout[0].delta).toBeGreaterThan(close[0].delta);
    expect(close[1].delta).toBeLessThan(0);
    expect(blowout[1].delta).toBeLessThan(0);
    const favoriteClose = applyPlaybackResult([side('a', 3.7)], [side('b', 3.3)], 11, 9, 11);
    expect(favoriteClose[0].delta).toBeGreaterThan(0);
    expect(favoriteClose[1].delta).toBeLessThan(0);
    expect(favoriteClose[0].k).toBe(K_PROVISIONAL);
    expect(favoriteClose[1].k).toBe(K_PROVISIONAL);
  });

  it('stays near zero-sum when every player has the same K', () => {
    const update = applyPlaybackResult(
      [side('a1', 3.4), side('a2', 3.52)],
      [side('b1', 3.71), side('b2', 3.63)],
      11,
      7,
      11,
    );
    const sum = update.reduce((total, row) => total + row.delta, 0);
    expect(Math.abs(sum)).toBeLessThanOrEqual(0.04);
    expect(update.every((row) => row.k === K_PROVISIONAL)).toBe(true);
  });

  it('moves a provisional player further than an established player in the same match', () => {
    const update = applyPlaybackResult(
      [side('prov', 3.5, 0)],
      [side('est', 3.5, 20)],
      11,
      5,
      11,
    );
    const prov = update.find((row) => row.id === 'prov')!;
    const est = update.find((row) => row.id === 'est')!;
    expect(prov.delta).toBeGreaterThan(0);
    expect(est.delta).toBeLessThan(0);
    expect(prov.delta).toBeCloseTo(-2 * est.delta, 1);
    expect(prov.delta + est.delta).not.toBe(0);
  });
});

describe('Play Now on the playback scale', () => {
  it('reads the scale and still lets a new player into a nearby game', () => {
    expect(levelFromPir(3.4)).toBeCloseTo(3.4, 5);
    expect(levelFromPir(1500)).toBeCloseTo(3.5, 5);
    expect(levelFits(2.5, 0, 3.2, 4.0)).toBe(true);
    expect(levelFits(3.4, 8, 3.2, 3.8)).toBe(true);
  });
});
