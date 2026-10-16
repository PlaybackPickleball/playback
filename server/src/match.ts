export type TeamId = 'A' | 'B';
export type EndId = 1 | 2;

export const GAME_TO = 11;

export type EndRule = 'none';
export const RALLY_TRIM_MS = 1500;
export const RALLY_MIN_MS = 500;
export const SEEK_LEAD_MS = 3000;

export type ScoreEvent = {
  team: TeamId;
  offsetMs: number;
};

export type Rally = {
  index: number;
  startMs: number;
  endMs: number;
  pointOffsetMs: number;
  scoringTeam: TeamId;
  starred: boolean;
};

export function tally(events: ScoreEvent[]): { A: number; B: number } {
  return {
    A: events.filter((event) => event.team === 'A').length,
    B: events.filter((event) => event.team === 'B').length,
  };
}

/** Games go to 11. Teams stay on the ends where they started, so a switch is never due. */
export function switchIsDue(scores: ScoreEvent[], switches: { offsetMs: number }[], rule: EndRule = 'none'): boolean {
  void scores;
  void switches;
  void rule;
  return false;
}

export function reconcileSwitch<T extends { offsetMs: number }>(scores: ScoreEvent[], switches: T[], rule: EndRule = 'none'): T[] {
  void scores;
  void switches;
  void rule;
  return [];
}

export function endForTeam(
  team: TeamId,
  starting: { A: EndId; B: EndId },
  switches: { offsetMs: number }[],
  atMs: number,
): EndId {
  void switches;
  void atMs;
  return starting[team];
}

export function normalizePhone(input: string): string | null {
  const trimmed = input.trim();
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

function inRawRally(offsetMs: number, rawStart: number, rawEnd: number): boolean {
  if (offsetMs < rawStart || offsetMs > rawEnd) return false;
  if (offsetMs === rawStart && rawStart !== 0) return false;
  return true;
}

export function deriveRallies(
  scores: ScoreEvent[],
  highlights: { offsetMs: number }[],
  trimMs = RALLY_TRIM_MS,
): Rally[] {
  const rallies: Rally[] = [];
  let previous = 0;
  scores.forEach((point, index) => {
    const rawStart = previous;
    const rawEnd = point.offsetMs;
    const span = rawEnd - rawStart;
    let trim = trimMs;
    if (span < trimMs * 2 + RALLY_MIN_MS) {
      trim = Math.max(0, Math.floor((span - RALLY_MIN_MS) / 2));
    }
    let startMs = rawStart + trim;
    let endMs = rawEnd - trim;
    if (span <= 0 || endMs < startMs) {
      startMs = rawStart;
      endMs = rawEnd;
    }
    const starred = highlights.some((highlight) => inRawRally(highlight.offsetMs, rawStart, rawEnd));
    rallies.push({
      index,
      startMs,
      endMs,
      pointOffsetMs: rawEnd,
      scoringTeam: point.team,
      starred,
    });
    previous = rawEnd;
  });
  return rallies;
}

export type PlaySpan = { startMs: number; endMs: number };

export function rallySpans(rallies: Rally[], mode: 'rallies' | 'starred'): PlaySpan[] {
  const chosen = mode === 'starred' ? rallies.filter((rally) => rally.starred) : rallies;
  return chosen
    .map((rally) => ({ startMs: rally.startMs, endMs: Math.max(rally.startMs, rally.endMs) }))
    .filter((span) => span.endMs > span.startMs);
}
