export type TeamId = 'A' | 'B';

export type ScoreEvent = {
  team: TeamId;
  offsetMs: number;
};

export type HighlightMark = {
  offsetMs: number;
};

export function tally(events: ScoreEvent[]): { A: number; B: number } {
  return {
    A: events.filter((event) => event.team === 'A').length,
    B: events.filter((event) => event.team === 'B').length,
  };
}

export function undoLast(events: ScoreEvent[]): ScoreEvent[] {
  return events.slice(0, -1);
}

export const TAP_GUARD_MS = 400;

export type TapSide = 'left' | 'right';

export type TapBoardState = {
  scores: ScoreEvent[];
  lastTapAt: number | null;
};

/** One tap scores the team on that side. A second tap inside the guard window counts once. */
export function scoreTap(
  board: TapBoardState,
  side: TapSide,
  sides: { left: TeamId; right: TeamId },
  now: number,
  offsetMs: number,
  gapMs = TAP_GUARD_MS,
): TapBoardState {
  if (board.lastTapAt != null && now - board.lastTapAt < gapMs) return board;
  return {
    scores: [...board.scores, { team: sides[side], offsetMs }],
    lastTapAt: now,
  };
}

export function canMarkHighlight(highlights: HighlightMark[], offsetMs: number, gapMs = 1500): boolean {
  const previous = highlights[highlights.length - 1];
  if (!previous) return true;
  return offsetMs - previous.offsetMs >= gapMs;
}
