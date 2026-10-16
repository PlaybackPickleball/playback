/**
 * Smart Queue assignment policy. Pure: no database, no clock, no randomness.
 *
 * Input is the waiting entries of one facility (join order is `joinedAt`, ties by array order), the number of
 * players a court takes (4 for doubles, 2 for singles) and the facility settings. Output is the group to offer the
 * court to, plus a plain-words reason and which waiting entries were passed.
 *
 * Levels use the same scale as the rest of Play (3.5 + (PIR - 1500) / 200).
 *
 *  - fifo:   strictly by join time. The earliest waiter is always in the group, then the next earliest who still fit
 *            (a party of 3 cannot join 2 free seats, so only a too-big party is stepped over).
 *  - skill:  among the first POOL_LIMIT waiters, the group whose ratings are closest together. It must fit inside the
 *            skill band, otherwise no group is offered. Ties go to whoever has waited longer.
 *  - hybrid: start from the fifo group. A different group may jump ahead only when ALL of this holds:
 *              1. its rating spread is at least `minSkillGain` levels tighter than the fifo group's,
 *              2. its spread is inside the skill band,
 *              3. nobody left behind would have been passed by more than `maxBypass` later players in total,
 *                 counting the players already passed in earlier rounds (`bypassed`).
 *            So the longest waiters are protected and every skip is small, counted and explained.
 */

export type QueueMode = 'fifo' | 'skill' | 'hybrid';
export const QUEUE_MODES: readonly QueueMode[] = ['fifo', 'skill', 'hybrid'];

export const DEFAULT_MODE: QueueMode = 'hybrid';
/** Players within this many levels count as a good match. */
export const DEFAULT_SKILL_BAND = 0.5;
/** N: nobody waits behind more than this many later arrivals (players, not entries), across rounds. */
export const DEFAULT_MAX_BYPASS = 3;
/** A skip-ahead group must be at least this many levels tighter than the join-order group. */
export const DEFAULT_MIN_SKILL_GAIN = 0.3;
/** Group search only looks at the longest-waiting entries, which keeps it cheap and keeps long waiters in play. */
export const POOL_LIMIT = 16;

export type PolicyEntry = {
  id: string;
  /** Join time in ms. */
  joinedAt: number;
  level: number;
  partySize: number;
  /** Later players that already got ahead of this entry in earlier rounds. */
  bypassed: number;
};

export type PolicySettings = {
  mode: QueueMode;
  skillBand: number;
  maxBypass: number;
  minSkillGain: number;
};

export const DEFAULT_POLICY: PolicySettings = {
  mode: DEFAULT_MODE,
  skillBand: DEFAULT_SKILL_BAND,
  maxBypass: DEFAULT_MAX_BYPASS,
  minSkillGain: DEFAULT_MIN_SKILL_GAIN,
};

export type ReasonCode = 'fifo_order' | 'skill_match' | 'hybrid_in_order' | 'hybrid_skip_ahead';

export type Selection = {
  entryIds: string[];
  mode: QueueMode;
  reasonCode: ReasonCode;
  /** Plain words, shown in the offer. */
  reason: string;
  /** Largest rating difference inside the group, in levels. */
  spread: number;
  /** Waiting entries left behind, with how many players of this group joined after them. */
  passed: { entryId: string; passedBy: number }[];
  /** True when the group is not simply the earliest joiners. */
  skippedAhead: boolean;
};

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const EPS = 1e-9;

type Indexed = PolicyEntry & { pos: number };

const spreadOf = (group: Indexed[]) => {
  if (group.length === 0) return 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const e of group) {
    lo = Math.min(lo, e.level);
    hi = Math.max(hi, e.level);
  }
  return hi - lo;
};

/** Earliest joiners that fill the court exactly. The head always anchors the group. */
function fifoGroup(sorted: Indexed[], size: number): Indexed[] | null {
  const group: Indexed[] = [];
  let seats = size;
  for (const e of sorted) {
    if (e.partySize <= seats) {
      group.push(e);
      seats -= e.partySize;
      if (seats === 0) return group;
    } else if (group.length === 0) {
      // The head cannot fit at all (party bigger than the court). Nothing can be assigned in order.
      return null;
    }
  }
  return null;
}

/** Every combination of entries from the pool that fills the court exactly. */
function combos(pool: Indexed[], size: number): Indexed[][] {
  const out: Indexed[][] = [];
  const walk = (start: number, seats: number, chosen: Indexed[]) => {
    if (seats === 0) {
      out.push(chosen.slice());
      return;
    }
    for (let i = start; i < pool.length; i += 1) {
      const e = pool[i]!;
      if (e.partySize > seats) continue;
      chosen.push(e);
      walk(i + 1, seats - e.partySize, chosen);
      chosen.pop();
    }
  };
  walk(0, size, []);
  return out;
}

/** For each entry left behind: how many players of the group joined after it. */
export function passedBy(sorted: PolicyEntry[], chosenIds: string[]): { entryId: string; passedBy: number }[] {
  const chosen = new Set(chosenIds);
  const out: { entryId: string; passedBy: number }[] = [];
  sorted.forEach((e, i) => {
    if (chosen.has(e.id)) return;
    let n = 0;
    for (let j = i + 1; j < sorted.length; j += 1) {
      const later = sorted[j]!;
      if (chosen.has(later.id)) n += later.partySize;
    }
    if (n > 0) out.push({ entryId: e.id, passedBy: n });
  });
  return out;
}

export function sortByJoin(entries: PolicyEntry[]): PolicyEntry[] {
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.joinedAt - b.e.joinedAt || a.i - b.i)
    .map(({ e }) => e);
}

const order = (group: Indexed[]) => group.slice().sort((a, b) => a.pos - b.pos);
const posKey = (group: Indexed[]) => order(group).map((e) => e.pos);
function comparePos(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}
const sumPos = (group: Indexed[]) => group.reduce((n, e) => n + e.pos, 0);

function build(
  sorted: Indexed[],
  group: Indexed[],
  mode: QueueMode,
  reasonCode: ReasonCode,
  reason: string,
): Selection {
  const ids = order(group).map((e) => e.id);
  const passed = passedBy(sorted, ids);
  return {
    entryIds: ids,
    mode,
    reasonCode,
    reason,
    spread: r2(spreadOf(group)),
    passed,
    skippedAhead: passed.length > 0,
  };
}

/**
 * Picks the group to offer a free court to, or null when no valid group exists yet.
 * `size` is the number of players the court takes (doubles 4, singles 2).
 */
export function selectGroup(entries: PolicyEntry[], size: number, settings: PolicySettings = DEFAULT_POLICY): Selection | null {
  const sorted: Indexed[] = sortByJoin(entries.filter((e) => e.partySize >= 1 && e.partySize <= size)).map((e, pos) => ({ ...e, pos }));
  if (sorted.length === 0) return null;
  const base = fifoGroup(sorted, size);

  if (settings.mode === 'fifo') {
    if (!base) return null;
    return build(
      sorted,
      base,
      'fifo',
      'fifo_order',
      `Offered in join order: this group has waited the longest. Ratings are up to ${r1(spreadOf(base))} levels apart, and that is not used to choose.`,
    );
  }

  const pool = sorted.slice(0, POOL_LIMIT);

  if (settings.mode === 'skill') {
    let best: { group: Indexed[]; spread: number } | null = null;
    for (const group of combos(pool, size)) {
      const spread = spreadOf(group);
      if (spread > settings.skillBand + EPS) continue;
      if (
        !best ||
        spread < best.spread - EPS ||
        (Math.abs(spread - best.spread) <= EPS && (sumPos(group) < sumPos(best.group) || (sumPos(group) === sumPos(best.group) && comparePos(posKey(group), posKey(best.group)) < 0)))
      ) {
        best = { group, spread };
      }
    }
    if (!best) return null;
    return build(
      sorted,
      best.group,
      'skill',
      'skill_match',
      `Grouped by closest rating: these players are within ${r1(best.spread)} levels of each other (the limit is ${r1(settings.skillBand)}). Join time only breaks ties.`,
    );
  }

  // hybrid
  if (!base) return null;
  const baseSpread = spreadOf(base);
  const baseIds = posKey(base).join(',');
  let pick: { group: Indexed[]; spread: number; passTotal: number } | null = null;
  for (const group of combos(pool, size)) {
    if (posKey(group).join(',') === baseIds) continue;
    const spread = spreadOf(group);
    if (spread > settings.skillBand + EPS) continue;
    if (baseSpread - spread < settings.minSkillGain - EPS) continue;
    const ids = group.map((e) => e.id);
    const passed = passedBy(sorted, ids);
    const byId = new Map(sorted.map((e) => [e.id, e]));
    if (passed.some((p) => byId.get(p.entryId)!.bypassed + p.passedBy > settings.maxBypass)) continue;
    const passTotal = passed.reduce((n, p) => n + p.passedBy, 0);
    if (
      !pick ||
      spread < pick.spread - EPS ||
      (Math.abs(spread - pick.spread) <= EPS &&
        (passTotal < pick.passTotal || (passTotal === pick.passTotal && comparePos(posKey(group), posKey(pick.group)) < 0)))
    ) {
      pick = { group, spread, passTotal };
    }
  }

  if (pick) {
    return build(
      sorted,
      pick.group,
      'hybrid',
      'hybrid_skip_ahead',
      `Skipped ahead a little for a better match: this group is ${r1(pick.spread)} levels apart instead of ${r1(baseSpread)} in join order. ` +
        `Skips are limited: nobody waits behind more than ${settings.maxBypass} later players in total, and ${sel_passedText(sorted, pick.group)}.`,
    );
  }
  const tail =
    baseSpread <= settings.skillBand + EPS
      ? `Everyone is within ${r1(baseSpread)} levels.`
      : `Ratings are ${r1(baseSpread)} levels apart, wider than the ${r1(settings.skillBand)} band, but no other group was clearly better within the skip limit.`;
  return build(sorted, base, 'hybrid', 'hybrid_in_order', `Offered in join order, because no skip-ahead group was clearly better. ${tail}`);
}

function sel_passedText(sorted: Indexed[], group: Indexed[]): string {
  const passed = passedBy(sorted, group.map((e) => e.id));
  const players = passed.length;
  return players === 1 ? '1 waiting entry was passed' : `${players} waiting entries were passed`;
}
