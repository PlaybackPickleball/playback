import { type ScoreEvent, type TeamId } from './score';

export type EndId = 1 | 2;
export type { ScoreEvent, TeamId };

export const GAME_TO = 11;

export type EndRule = 'none';
export const RALLY_TRIM_MS = 1500;
export const RALLY_MIN_MS = 500;
export const SEEK_LEAD_MS = 3000;

export type Rally = {
  index: number;
  startMs: number;
  endMs: number;
  pointOffsetMs: number;
  scoringTeam: TeamId;
  starred: boolean;
};

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

/** End 1 is the left side of the scoreboard. End 2 is the right. */
export function sidesAt(
  starting: { A: EndId; B: EndId },
  switches: { offsetMs: number }[],
  atMs: number,
): { left: TeamId; right: TeamId } {
  const left: TeamId = endForTeam('A', starting, switches, atMs) === 1 ? 'A' : 'B';
  return { left, right: left === 'A' ? 'B' : 'A' };
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

export function seekSeconds(offsetMs: number): number {
  return Math.max(0, offsetMs / 1000 - SEEK_LEAD_MS / 1000);
}

export type LastPointWindow = {
  /** Trimmed rally start. The first point instead starts a few seconds before the score. */
  startMs: number;
  /** Trimmed rally end. The first point ends at the score. */
  endMs: number;
  /** Playback start. Saved video seeks here, a few seconds before the rally when it can. */
  playStartMs: number;
  pointOffsetMs: number;
  scoringTeam: TeamId;
};

/** Time range for “watch last point”. Null until a point has been scored. */
export function lastPointWindow(scores: ScoreEvent[], leadMs = SEEK_LEAD_MS): LastPointWindow | null {
  if (scores.length === 0) return null;
  const latest = scores[scores.length - 1];
  if (scores.length === 1) {
    const startMs = Math.max(0, latest.offsetMs - leadMs);
    return {
      startMs,
      endMs: Math.max(startMs, latest.offsetMs),
      playStartMs: startMs,
      pointOffsetMs: latest.offsetMs,
      scoringTeam: latest.team,
    };
  }
  const last = deriveRallies(scores, []).at(-1);
  if (!last) return null;
  const endMs = last.endMs > last.startMs ? last.endMs : Math.max(last.startMs, last.pointOffsetMs);
  return {
    startMs: last.startMs,
    endMs,
    playStartMs: Math.max(0, last.startMs - leadMs),
    pointOffsetMs: last.pointOffsetMs,
    scoringTeam: last.scoringTeam,
  };
}
