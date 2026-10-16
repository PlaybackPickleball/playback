import { confidence, toPlayback } from '../pir.js';
import { haversineKm, type LatLng } from '../geo.js';

/**
 * Play Now matching. Pure: no database, no clock, no randomness. Callers pass everything in.
 * Order of work: HARD FILTERS first (a failing target is dropped, never scored), then a deterministic
 * weighted ranking. Ratings are estimates, so every result carries that note.
 */

export const WEIGHTS = { skill: 0.45, schedule: 0.25, distance: 0.2, reliability: 0.1 } as const;
export const DEFAULT_RADIUS_KM = 5;
/** Completed plus no-show games needed before reliability moves the score. Below it the factor is neutral. */
export const MIN_RELIABILITY_SAMPLE = 5;
export const NEUTRAL = 0.5;
export const DISCLAIMER = 'Ratings are estimates, not guarantees. A new or provisional rating can be off by a full level.';

export type Format = 'doubles' | 'singles';
export type StartPref =
  | { kind: 'asap' }
  | { kind: 'target'; at: string } // venue-local YYYY-MM-DDTHH:MM
  | { kind: 'window'; date?: string; from?: string; to?: string };
export type AvailabilityWindow = { day: number; start: string; end: string }; // day 0 = Sunday, HH:MM

export type SearchContext = {
  nowLocal: string; // YYYY-MM-DDTHH:MM, venue local
  radiusKm: number;
  format: Format;
  start: StartPref;
};
export type Reliability = { sample: number; rate: number } | null;

export type Seeker = { id: string; pir: number; matchesPlayed: number; location: LatLng };

export type Target = {
  id: string;
  start: string; // venue-local YYYY-MM-DDTHH:MM
  end: string;
  location: LatLng;
  slotAvailable: boolean;
  verified: boolean;
  format: Format;
  openSeats: number;
  minLevel: number;
  maxLevel: number;
};

export type Candidate = {
  id: string;
  pir: number;
  matchesPlayed: number;
  location: LatLng | null;
  matchInviteOptIn: boolean;
  availabilityOptedIn: boolean;
  radiusKm: number;
  format: Format;
  windows: AvailabilityWindow[];
  busy: boolean;
  reliability: Reliability;
};

export type ExcludeReason =
  | 'slot_unavailable'
  | 'past'
  | 'outside_radius'
  | 'no_location'
  | 'no_open_seat'
  | 'busy'
  | 'format_mismatch'
  | 'not_opted_in'
  | 'level_outside_range';

export type Factor = { score: number; weight: number; note: string };
export type Explained = {
  score: number; // 0 to 100
  factors: { skill: Factor; schedule: Factor; distance: Factor; reliability: Factor };
  distanceKm: number;
  warnings: string[];
  explanation: string;
  disclaimer: string;
};
export type Evaluation = { eligible: true; result: Explained } | { eligible: false; reason: ExcludeReason };

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const pct = (n: number) => Math.round(clamp01(n) * 100);
const localMs = (value: string) => Date.parse(`${value.slice(0, 16)}:00Z`);
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Playback Rating on the 2.0–5.0 scale. A legacy Elo integer (1500 = 3.50, 200 points per level) still converts. */
export const levelFromPir = (pir: number) => toPlayback(pir);
export const displayLevel = (pir: number) => round1(levelFromPir(pir));
export const confidenceOf = (matchesPlayed: number) => confidence(matchesPlayed);
export const isProvisional = (matchesPlayed: number) => matchesPlayed < 5;

/** How far outside a level range a player may sit. Thin history widens it, so newcomers are never shut out. */
export function levelTolerance(conf: number): number {
  return 0.25 + 1.0 * (1 - clamp01(conf));
}

export function levelExcess(level: number, minLevel: number, maxLevel: number): number {
  return Math.max(0, minLevel - level, level - maxLevel);
}

export function levelFits(pir: number, matchesPlayed: number, minLevel: number, maxLevel: number): boolean {
  const excess = levelExcess(levelFromPir(pir), minLevel, maxLevel);
  return excess <= levelTolerance(confidenceOf(matchesPlayed)) + 1e-9;
}

/** 0 to 1. Inside the range scores 0.75 to 1 (best at the middle). Rating confidence pulls it toward a neutral 0.7. */
export function skillScore(pir: number, matchesPlayed: number, minLevel: number, maxLevel: number): number {
  const level = levelFromPir(pir);
  const conf = confidenceOf(matchesPlayed);
  const mid = (minLevel + maxLevel) / 2;
  const half = Math.max((maxLevel - minLevel) / 2, 0.25);
  const excess = levelExcess(level, minLevel, maxLevel);
  const base = excess === 0 ? 1 - (0.25 * Math.abs(level - mid)) / half : 0.75 * Math.max(0, 1 - excess / 1.5);
  const trust = 0.5 + 0.5 * conf;
  return trust * base + (1 - trust) * 0.7;
}

export const distanceScore = (km: number, radiusKm: number) => clamp01(1 - km / Math.max(radiusKm, 0.1));

/** Closeness of a start time to what the player asked for. */
export function startPreferenceScore(startLocal: string, ctx: Pick<SearchContext, 'nowLocal' | 'start'>): number {
  const start = ctx.start;
  const startMs = localMs(startLocal);
  if (start.kind === 'asap') {
    const hours = (startMs - localMs(ctx.nowLocal)) / 3_600_000;
    return clamp01(1 - Math.max(0, hours - 1) / 71);
  }
  if (start.kind === 'target') {
    return clamp01(1 - Math.abs(startMs - localMs(start.at)) / 3_600_000 / 6);
  }
  if (start.date && startLocal.slice(0, 10) !== start.date) return 0.1;
  const at = minutesOf(startLocal.slice(11, 16));
  const from = start.from ? minutesOf(start.from) : 0;
  const to = start.to ? minutesOf(start.to) : 24 * 60;
  const outside = at < from ? from - at : at > to ? at - to : 0;
  return clamp01(1 - outside / 180);
}

export function windowFits(startLocal: string, endLocal: string, windows: AvailabilityWindow[]): boolean {
  const day = new Date(localMs(startLocal)).getUTCDay();
  const s = minutesOf(startLocal.slice(11, 16));
  const e = minutesOf(endLocal.slice(11, 16));
  return windows.some((w) => w.day === day && minutesOf(w.start) <= s && minutesOf(w.end) >= e);
}

function reliabilityFactor(reliability: Reliability): { score: number; known: boolean } {
  if (reliability && reliability.sample >= MIN_RELIABILITY_SAMPLE) return { score: clamp01(reliability.rate), known: true };
  return { score: NEUTRAL, known: false };
}

function whenWords(startLocal: string, nowLocal: string): string {
  const mins = Math.round((localMs(startLocal) - localMs(nowLocal)) / 60_000);
  if (mins < 90) return `starts in ${Math.max(mins, 0)} minutes`;
  if (mins < 48 * 60) return `starts in about ${Math.round(mins / 60)} hours`;
  return `starts in about ${Math.round(mins / 1440)} days`;
}

type ScoreInput = {
  pir: number;
  matchesPlayed: number;
  minLevel: number;
  maxLevel: number;
  distanceKm: number;
  radiusKm: number;
  start: string;
  windowFactor: number | null; // null when the player gave no windows
  nowLocal: string;
  startPref: StartPref;
  reliability: Reliability;
  verified: boolean;
  who: 'you' | 'player';
};

function explain(input: ScoreInput): Explained {
  const level = levelFromPir(input.pir);
  const skill = skillScore(input.pir, input.matchesPlayed, input.minLevel, input.maxLevel);
  const prefScore = startPreferenceScore(input.start, { nowLocal: input.nowLocal, start: input.startPref });
  const schedule = prefScore * (input.windowFactor ?? 0.8);
  const distance = distanceScore(input.distanceKm, input.radiusKm);
  const reliability = reliabilityFactor(input.reliability);

  const inside = levelExcess(level, input.minLevel, input.maxLevel) === 0;
  const provisional = isProvisional(input.matchesPlayed);
  const subject = input.who === 'you' ? 'Your' : 'Their';
  const skillNote = `${subject} level is about ${round1(level)}, ${inside ? 'inside' : 'close to'} the ${input.minLevel.toFixed(1)} to ${input.maxLevel.toFixed(1)} range${
    provisional ? '; the rating is still provisional, so this fit counts for less' : ''
  }.`;
  const scheduleNote = `The game ${whenWords(input.start, input.nowLocal)}${
    input.windowFactor == null ? '' : input.windowFactor === 1 ? ' and fits the stated availability' : ' and falls outside the stated availability'
  }.`;
  const distanceNote = `The court is ${round1(input.distanceKm)} km away (search radius ${round1(input.radiusKm)} km).`;
  const reliabilityNote = reliability.known
    ? `${Math.round(reliability.score * 100)}% of past games were completed.`
    : 'Not enough game history yet, so reliability is neutral and does not count against anyone.';

  const factors = {
    skill: { score: pct(skill), weight: WEIGHTS.skill, note: skillNote },
    schedule: { score: pct(schedule), weight: WEIGHTS.schedule, note: scheduleNote },
    distance: { score: pct(distance), weight: WEIGHTS.distance, note: distanceNote },
    reliability: { score: pct(reliability.score), weight: WEIGHTS.reliability, note: reliabilityNote },
  };
  const total =
    100 *
    (WEIGHTS.skill * skill + WEIGHTS.schedule * schedule + WEIGHTS.distance * distance + WEIGHTS.reliability * reliability.score);
  const warnings: string[] = [];
  if (!input.verified) warnings.push('Availability not verified recently. Check with the facility before travelling.');
  return {
    score: round2(total),
    factors,
    distanceKm: round2(input.distanceKm),
    warnings,
    explanation: `${skillNote} ${scheduleNote} ${distanceNote} ${reliabilityNote} ${DISCLAIMER}`,
    disclaimer: DISCLAIMER,
  };
}

/** Hard filters shared by matches and slots: court free, in the future, in range. */
function targetFilter(target: Target, ctx: SearchContext, from: LatLng | null, radiusKm: number): ExcludeReason | null {
  if (!target.slotAvailable) return 'slot_unavailable';
  if (localMs(target.start) <= localMs(ctx.nowLocal)) return 'past';
  if (!from) return 'no_location';
  if (haversineKm(from, target.location) > radiusKm + 1e-9) return 'outside_radius';
  if (target.format !== ctx.format) return 'format_mismatch';
  return null;
}

/** An open match for a seeker. `busy` is whether the seeker already has a booking that overlaps it. */
export function evaluateMatch(
  seeker: Seeker,
  match: Target,
  ctx: SearchContext,
  extra: { busy: boolean; hostReliability: Reliability },
): Evaluation {
  const reason = targetFilter(match, ctx, seeker.location, ctx.radiusKm);
  if (reason) return { eligible: false, reason };
  if (match.openSeats <= 0) return { eligible: false, reason: 'no_open_seat' };
  if (extra.busy) return { eligible: false, reason: 'busy' };
  if (!levelFits(seeker.pir, seeker.matchesPlayed, match.minLevel, match.maxLevel)) {
    return { eligible: false, reason: 'level_outside_range' };
  }
  return {
    eligible: true,
    result: explain({
      pir: seeker.pir,
      matchesPlayed: seeker.matchesPlayed,
      minLevel: match.minLevel,
      maxLevel: match.maxLevel,
      distanceKm: haversineKm(seeker.location, match.location),
      radiusKm: ctx.radiusKm,
      start: match.start,
      windowFactor: null,
      nowLocal: ctx.nowLocal,
      startPref: ctx.start,
      reliability: extra.hostReliability,
      verified: match.verified,
      who: 'you',
    }),
  };
}

/** A player who could be invited into a game on a free slot. Never scored when any hard filter fails. */
export function evaluateCandidate(candidate: Candidate, slot: Target, ctx: SearchContext): Evaluation {
  if (!slot.slotAvailable) return { eligible: false, reason: 'slot_unavailable' };
  if (!candidate.matchInviteOptIn || !candidate.availabilityOptedIn) return { eligible: false, reason: 'not_opted_in' };
  if (candidate.busy) return { eligible: false, reason: 'busy' };
  if (candidate.format !== slot.format) return { eligible: false, reason: 'format_mismatch' };
  if (!candidate.location) return { eligible: false, reason: 'no_location' };
  const km = haversineKm(candidate.location, slot.location);
  if (km > Math.min(ctx.radiusKm, candidate.radiusKm) + 1e-9) return { eligible: false, reason: 'outside_radius' };
  if (!levelFits(candidate.pir, candidate.matchesPlayed, slot.minLevel, slot.maxLevel)) {
    return { eligible: false, reason: 'level_outside_range' };
  }
  const windowFactor = candidate.windows.length ? (windowFits(slot.start, slot.end, candidate.windows) ? 1 : 0.4) : null;
  return {
    eligible: true,
    result: explain({
      pir: candidate.pir,
      matchesPlayed: candidate.matchesPlayed,
      minLevel: slot.minLevel,
      maxLevel: slot.maxLevel,
      distanceKm: km,
      radiusKm: Math.min(ctx.radiusKm, candidate.radiusKm),
      start: slot.start,
      windowFactor,
      nowLocal: ctx.nowLocal,
      startPref: ctx.start,
      reliability: candidate.reliability,
      verified: slot.verified,
      who: 'player',
    }),
  };
}

export type Ranked<T> = { item: T; result: Explained };
export type RankOutcome<T> = { ranked: Ranked<T>[]; excluded: Partial<Record<ExcludeReason, number>> };

/** Highest score first. Ties break by id so the same input always gives the same order. */
export function rankBy<T extends { id: string }>(items: T[], evaluate: (item: T) => Evaluation): RankOutcome<T> {
  const ranked: Ranked<T>[] = [];
  const excluded: Partial<Record<ExcludeReason, number>> = {};
  for (const item of items) {
    const evaluation = evaluate(item);
    if (evaluation.eligible) ranked.push({ item, result: evaluation.result });
    else excluded[evaluation.reason] = (excluded[evaluation.reason] ?? 0) + 1;
  }
  ranked.sort((a, b) => b.result.score - a.result.score || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0));
  return { ranked, excluded };
}

export const rankMatches = (
  seeker: Seeker,
  matches: (Target & { busy: boolean; hostReliability: Reliability })[],
  ctx: SearchContext,
) => rankBy(matches, (m) => evaluateMatch(seeker, m, ctx, { busy: m.busy, hostReliability: m.hostReliability }));

export const rankCandidates = (candidates: Candidate[], slot: Target, ctx: SearchContext) =>
  rankBy(candidates, (c) => evaluateCandidate(c, slot, ctx));

/** A free slot for "build my game": only schedule and distance apply, so the weights are rescaled over those two. */
export function slotFit(
  slot: Target,
  seeker: Seeker,
  ctx: SearchContext,
): { fit: number; distanceKm: number } | { excluded: ExcludeReason } {
  const reason = targetFilter(slot, ctx, seeker.location, ctx.radiusKm);
  if (reason) return { excluded: reason };
  const km = haversineKm(seeker.location, slot.location);
  const schedule = startPreferenceScore(slot.start, ctx);
  const distance = distanceScore(km, ctx.radiusKm);
  const fit = (WEIGHTS.schedule * schedule + WEIGHTS.distance * distance) / (WEIGHTS.schedule + WEIGHTS.distance);
  return { fit: round2(fit * 100), distanceKm: round2(km) };
}
