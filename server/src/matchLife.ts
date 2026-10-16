export type MatchStatus = 'scheduled' | 'ready' | 'recording' | 'completed' | 'verified';

const NEXT: Record<MatchStatus, MatchStatus[]> = {
  scheduled: ['ready'],
  ready: ['recording', 'scheduled'],
  recording: ['completed'],
  completed: ['verified'],
  verified: [],
};

export function canTransition(from: MatchStatus, to: MatchStatus): boolean {
  return NEXT[from].includes(to);
}

export function assertTransition(from: MatchStatus, to: MatchStatus): void {
  if (!canTransition(from, to)) throw new Error(`invalid_transition:${from}:${to}`);
}

export function lineupReady(mode: 'singles' | 'doubles', counts: { A: number; B: number }): boolean {
  const need = mode === 'singles' ? 1 : 2;
  return counts.A === need && counts.B === need;
}

export function winnerOf(scoreA: number, scoreB: number): 'A' | 'B' | null {
  if (scoreA === scoreB) return null;
  return scoreA > scoreB ? 'A' : 'B';
}

export function assertFirstRating(alreadyApplied: boolean): void {
  if (alreadyApplied) throw new Error('already_verified');
}
