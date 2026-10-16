import { describe, expect, it } from 'vitest';
import {
  assignPlayer,
  confirmScore,
  initials,
  playerCheckInUrl,
  removePlayer,
  rosterStatus,
  verifyGuard,
} from '../src/lifecycle.js';

describe('match lifecycle', () => {
  it('marks singles ready only when each team has one player', () => {
    const first = assignPlayer('singles', [], 'minh', 'A');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(rosterStatus('singles', first.slots)).toBe('scheduled');
    const second = assignPlayer('singles', first.slots, 'lan', 'B');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(rosterStatus('singles', second.slots)).toBe('ready');
  });

  it('rejects a duplicate player and a full team', () => {
    const seated = assignPlayer('singles', [{ playerId: 'minh', team: 'A' }], 'minh', 'B');
    expect(seated).toEqual({ ok: false, error: 'duplicate_player' });
    const full = assignPlayer('doubles', [
      { playerId: 'a', team: 'A' },
      { playerId: 'b', team: 'A' },
    ], 'c', 'A');
    expect(full).toEqual({ ok: false, error: 'team_full' });
  });

  it('returns to scheduled when a player leaves a ready roster', () => {
    const slots = [
      { playerId: 'minh', team: 'A' as const },
      { playerId: 'lan', team: 'B' as const },
    ];
    expect(rosterStatus('singles', removePlayer(slots, 'lan'))).toBe('scheduled');
  });

  it('takes the winner from the host score and refuses a tie', () => {
    expect(confirmScore(11, 7)).toEqual({ ok: true, winner: 'A' });
    expect(confirmScore(8, 11)).toEqual({ ok: true, winner: 'B' });
    expect(confirmScore(11, 11)).toEqual({ ok: false, error: 'tied_score' });
    expect(confirmScore(1.5, 0)).toEqual({ ok: false, error: 'invalid_score' });
  });

  it('allows verification once, only after the score is confirmed', () => {
    expect(verifyGuard('recording', false)).toBe('not_completed');
    expect(verifyGuard('completed', false)).toBe('ok');
    expect(verifyGuard('completed', true)).toBe('already_applied');
    expect(verifyGuard('verified', false)).toBe('already_applied');
  });

  it('builds initials and a check-in URL with no password', () => {
    expect(initials('Minh Trần')).toBe('MT');
    expect(initials('Lan')).toBe('LA');
    const href = playerCheckInUrl('http://127.0.0.1:5173', 'demo-minh');
    const url = new URL(href);
    expect(url.pathname).toBe('/players/demo-minh');
    expect(url.password).toBe('');
    expect(url.search).toBe('');
    expect(href.toLowerCase()).not.toContain('password');
  });
});
