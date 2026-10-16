export type MatchStatus = 'scheduled' | 'ready' | 'recording' | 'completed' | 'verified';
export type TeamId = 'A' | 'B';
export type MatchMode = 'singles' | 'doubles';

export type RosterSlot = {
  playerId: string;
  team: TeamId;
};

const NEXT: Record<MatchStatus, MatchStatus[]> = {
  scheduled: ['ready'],
  ready: ['scheduled', 'recording'],
  recording: ['ready', 'completed'],
  completed: ['verified'],
  verified: [],
};

export function canTransition(from: MatchStatus, to: MatchStatus): boolean {
  return NEXT[from].includes(to);
}

export function teamCapacity(mode: MatchMode): number {
  return mode === 'singles' ? 1 : 2;
}

export function rosterComplete(mode: MatchMode, slots: RosterSlot[]): boolean {
  const capacity = teamCapacity(mode);
  const count = (team: TeamId) => slots.filter((slot) => slot.team === team).length;
  return count('A') === capacity && count('B') === capacity && slots.length === capacity * 2;
}

export function rosterStatus(mode: MatchMode, slots: RosterSlot[]): 'scheduled' | 'ready' {
  return rosterComplete(mode, slots) ? 'ready' : 'scheduled';
}

export function assignPlayer(
  mode: MatchMode,
  slots: RosterSlot[],
  playerId: string,
  team: TeamId,
): { ok: true; slots: RosterSlot[] } | { ok: false; error: 'duplicate_player' | 'team_full' } {
  if (slots.some((slot) => slot.playerId === playerId)) return { ok: false, error: 'duplicate_player' };
  const capacity = teamCapacity(mode);
  if (slots.filter((slot) => slot.team === team).length >= capacity) return { ok: false, error: 'team_full' };
  return { ok: true, slots: [...slots, { playerId, team }] };
}

export function removePlayer(slots: RosterSlot[], playerId: string): RosterSlot[] {
  return slots.filter((slot) => slot.playerId !== playerId);
}

export function confirmScore(
  scoreA: number,
  scoreB: number,
): { ok: true; winner: TeamId } | { ok: false; error: 'invalid_score' | 'tied_score' } {
  if (!Number.isInteger(scoreA) || !Number.isInteger(scoreB) || scoreA < 0 || scoreB < 0 || scoreA > 99 || scoreB > 99) {
    return { ok: false, error: 'invalid_score' };
  }
  if (scoreA === scoreB) return { ok: false, error: 'tied_score' };
  return { ok: true, winner: scoreA > scoreB ? 'A' : 'B' };
}

/** Verification is allowed once, from a completed match whose rating has not been applied. */
export function verifyGuard(
  status: MatchStatus,
  ratingsApplied: boolean,
): 'ok' | 'not_completed' | 'already_applied' {
  if (ratingsApplied || status === 'verified') return 'already_applied';
  if (status !== 'completed') return 'not_completed';
  return 'ok';
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0] ?? '';
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? '';
  return `${first[0] ?? ''}${last[0] ?? ''}`.toUpperCase();
}

/** Player check-in link. The id is public. There is no password. */
export function playerCheckInUrl(publicBaseUrl: string, playerId: string): string {
  const url = new URL(`${publicBaseUrl.replace(/\/$/, '')}/players/${encodeURIComponent(playerId)}`);
  url.search = '';
  url.hash = '';
  url.username = '';
  url.password = '';
  return url.toString();
}
