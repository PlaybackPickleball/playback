import { describe, expect, it } from 'vitest';
import { canTransition, confirmScore, rosterComplete, verifyGuard } from '../src/lifecycle.js';

describe('match lifecycle', () => {
  it('walks scheduled, ready, recording, completed, verified', () => {
    expect(canTransition('scheduled', 'ready')).toBe(true);
    expect(canTransition('ready', 'recording')).toBe(true);
    expect(canTransition('recording', 'completed')).toBe(true);
    expect(canTransition('completed', 'verified')).toBe(true);
    expect(canTransition('scheduled', 'recording')).toBe(false);
    expect(canTransition('verified', 'completed')).toBe(false);
    expect(canTransition('recording', 'verified')).toBe(false);
  });

  it('lets a ready court return to scheduled when the roster is short', () => {
    expect(canTransition('ready', 'scheduled')).toBe(true);
    const full = [
      { playerId: 'a1', team: 'A' as const },
      { playerId: 'a2', team: 'A' as const },
      { playerId: 'b1', team: 'B' as const },
      { playerId: 'b2', team: 'B' as const },
    ];
    expect(rosterComplete('doubles', full)).toBe(true);
    expect(rosterComplete('doubles', full.slice(0, 3))).toBe(false);
    expect(rosterComplete('singles', full.slice(0, 2).map((slot, index) => ({ ...slot, team: index === 0 ? 'A' as const : 'B' as const })))).toBe(true);
  });

  it('verifies a completed result once', () => {
    expect(confirmScore(11, 7)).toEqual({ ok: true, winner: 'A' });
    expect(confirmScore(8, 11)).toEqual({ ok: true, winner: 'B' });
    expect(confirmScore(11, 11)).toEqual({ ok: false, error: 'tied_score' });
    expect(verifyGuard('completed', false)).toBe('ok');
    expect(verifyGuard('completed', true)).toBe('already_applied');
    expect(verifyGuard('recording', false)).toBe('not_completed');
    expect(verifyGuard('verified', false)).toBe('already_applied');
  });
});
