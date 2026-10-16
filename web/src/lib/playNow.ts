/** Pure Play Now helpers. Prices are integer VND. Payment is never taken in the app. */

const PRICE_STEP_VND = 5_000;
const DOUBLES_SEATS = 4;
const VND_FORMAT = new Intl.NumberFormat('vi-VN', {
  style: 'currency',
  currency: 'VND',
  maximumFractionDigits: 0,
});

export const PLAY_SEARCH_RADIUS_KM = 50;

export const DEMO_FACILITY_OPTIONS = [
  { id: 'demo-facility', name: 'PlayBack Demo Club', demo: true },
  { id: 'demo-facility-binh-thanh', name: 'Bình Thạnh Pickleball (Demo)', demo: true },
  { id: 'demo-facility-quan-7', name: 'Quận 7 Pickleball (Demo)', demo: true },
] as const;

export function venueDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function isVenueDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function isDemoId(id: string): boolean {
  return id.startsWith('demo-');
}

export function formatVnd(amountVnd: number): string {
  return VND_FORMAT.format(amountVnd);
}

/** Court price split the way open matches store `price_per_player_vnd`. */
export function perPlayerVnd(courtPriceVnd: number, seats = DOUBLES_SEATS): number {
  if (!Number.isInteger(courtPriceVnd) || courtPriceVnd < 0 || !Number.isInteger(seats) || seats < 1) return 0;
  return Math.ceil(courtPriceVnd / seats / PRICE_STEP_VND) * PRICE_STEP_VND;
}

function isVnd(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100_000_000;
}

export type PriceView =
  | { kind: 'smart_fill'; normalPriceVnd: number; promoPriceVnd: number }
  | { kind: 'listed'; priceVnd: number }
  | { kind: 'none' };

/**
 * `smartFill` is optional. The server does not send it on matches yet.
 * A complete pair shows the Smart Fill badge; anything else keeps the listed price.
 */
export function priceView(smartFill: unknown, listedPriceVnd?: number | null): PriceView {
  if (smartFill && typeof smartFill === 'object') {
    const row = smartFill as { normalPriceVnd?: unknown; promoPriceVnd?: unknown };
    if (isVnd(row.normalPriceVnd) && isVnd(row.promoPriceVnd)) {
      return { kind: 'smart_fill', normalPriceVnd: row.normalPriceVnd, promoPriceVnd: row.promoPriceVnd };
    }
  }
  if (isVnd(listedPriceVnd)) return { kind: 'listed', priceVnd: listedPriceVnd };
  return { kind: 'none' };
}

export function priceParts(view: PriceView): { badge: boolean; strike: string | null; current: string | null } {
  if (view.kind === 'smart_fill') {
    return { badge: true, strike: formatVnd(view.normalPriceVnd), current: formatVnd(view.promoPriceVnd) };
  }
  if (view.kind === 'listed') return { badge: false, strike: null, current: formatVnd(view.priceVnd) };
  return { badge: false, strike: null, current: null };
}

export function paymentLabel(): { method: 'pay_at_facility'; processed: false; label: 'Pay at facility. Not paid yet' } {
  return { method: 'pay_at_facility', processed: false, label: 'Pay at facility. Not paid yet' };
}

export type QueueEstimate = {
  status?: string;
  waitMinutes?: number | null;
  typicalMinutes?: { low: number; high: number } | null;
} | null | undefined;

export function queueEstimateView(estimate: QueueEstimate): { available: false } | { available: true; low: number; high: number } {
  const low = estimate?.typicalMinutes?.low;
  const high = estimate?.typicalMinutes?.high;
  if (estimate?.status === 'estimated' && typeof low === 'number' && typeof high === 'number' && Number.isFinite(low) && Number.isFinite(high)) {
    return { available: true, low, high };
  }
  return { available: false };
}

type Named = { displayName: string };

export function confirmedTeamSplit(match: {
  status?: string | null;
  format?: string | null;
  teamSplit?: { recommended?: { teamA?: Named[] | null; teamB?: Named[] | null } | null } | null;
}): { teamA: { color: 'red'; names: string[] }; teamB: { color: 'blue'; names: string[] } } | null {
  if (match.status !== 'confirmed' || match.format !== 'doubles') return null;
  const teamA = match.teamSplit?.recommended?.teamA ?? [];
  const teamB = match.teamSplit?.recommended?.teamB ?? [];
  if (teamA.length === 0 || teamB.length === 0) return null;
  return {
    teamA: { color: 'red', names: teamA.map((player) => player.displayName) },
    teamB: { color: 'blue', names: teamB.map((player) => player.displayName) },
  };
}

export function courtStartHref(courtId: string | null | undefined): string | null {
  if (!courtId) return null;
  return `/court/${encodeURIComponent(courtId)}`;
}

export function startOnCourtOne(courtNumber: number | null | undefined, courtId?: string | null): boolean {
  return courtNumber === 1 || courtId === 'court-1';
}

export function onSelectedDay(start: string, date: string): boolean {
  return start.slice(0, 10) === date;
}

export function visibleJoinGames<T extends { match: { facilityId?: string; start: string } }>(rows: T[], facilityId: string, date: string): T[] {
  return rows.filter((row) => row.match.facilityId === facilityId && onSelectedDay(row.match.start, date));
}

export function visibleBuildSlots<T extends { slot: { facilityId: string; start: string } }>(rows: T[], facilityId: string, date: string): T[] {
  return rows.filter((row) => row.slot.facilityId === facilityId && onSelectedDay(row.slot.start, date));
}

export function visibleQueues<T extends { facilityId: string }>(rows: T[], facilityId: string): T[] {
  return rows.filter((row) => row.facilityId === facilityId);
}

export function holdableSlots<T extends { id: string; bookable: boolean; status: string }>(slots: T[], shownSlotIds: Iterable<string>): T[] {
  const shown = new Set(shownSlotIds);
  return slots.filter((slot) => slot.bookable && slot.status === 'available' && !shown.has(slot.id));
}

export function confirmedDoubles<T extends Parameters<typeof confirmedTeamSplit>[0] & { facilityId?: string }>(games: T[], facilityId: string): T[] {
  return games.filter((game) => game.facilityId === facilityId && confirmedTeamSplit(game) !== null);
}

const ACTIVE_QUEUE = new Set(['waiting', 'offered', 'confirmed']);

export function queueEntryHere<T extends { facilityId: string; status: string }>(entry: T | null | undefined, facilityId: string): T | null {
  if (!entry || entry.facilityId !== facilityId || !ACTIVE_QUEUE.has(entry.status)) return null;
  return entry;
}

export function facilityOptions(
  known: readonly { id: string; name: string; demo?: boolean }[],
  extra: { facilityId: string; facilityName: string }[],
): { id: string; name: string; demo: boolean }[] {
  const map = new Map<string, { id: string; name: string; demo: boolean }>();
  for (const item of known) map.set(item.id, { id: item.id, name: item.name, demo: Boolean(item.demo) });
  for (const item of extra) {
    if (!map.has(item.facilityId)) map.set(item.facilityId, { id: item.facilityId, name: item.facilityName, demo: false });
  }
  return [...map.values()];
}
