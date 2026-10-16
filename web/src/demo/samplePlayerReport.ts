/**
 * DEMO DATA ONLY.
 *
 * Everything in this file is fictional. It is used by the "Sample player report"
 * screen to show what a player will receive after playing. It is never read from
 * or written to the real player, match or rating tables, and none of these names
 * belong to real people. Win, loss, streak and rating totals are NOT stored here:
 * they are derived from SAMPLE_MATCHES in samplePlayerStats.ts so they always agree.
 */

export const DEMO_DATA_LABEL = 'Demo data';

export type SampleOpponent = { name: string; rating: number };

export type SampleMatch = {
  id: string;
  /** ISO time with the Vietnam offset. */
  playedAt: string;
  facility: string;
  court: number;
  partner: string;
  opponents: [SampleOpponent, SampleOpponent];
  /** Points scored by the demo player's side (Team A, red) and by the other side (Team B, blue). */
  scoreFor: number;
  scoreAgainst: number;
  /** PIR change after this verified match. */
  ratingChange: number;
};

export const SAMPLE_PLAYER = {
  id: 'demo-sample-player',
  displayName: 'Minh Anh Demo',
  initials: 'MA',
  hand: 'right' as 'right' | 'left',
  homeFacility: 'Demo Pickleball Club, District 1',
  /** PIR before the first match listed in SAMPLE_MATCHES. */
  startRating: 1480,
};

const a = { name: 'Tuấn Demo', rating: 1560 };
const b = { name: 'Lan Demo', rating: 1510 };
const c = { name: 'Hải Demo', rating: 1620 };
const d = { name: 'Thảo Demo', rating: 1475 };
const e = { name: 'Quân Demo', rating: 1440 };
const f = { name: 'Vy Demo', rating: 1530 };

const club1 = 'Demo Pickleball Club, District 1';
const club2 = 'Demo Pickleball Binh Thanh';

/** Oldest first. Twelve verified matches. */
export const SAMPLE_MATCHES: readonly SampleMatch[] = [
  { id: 's1', playedAt: '2026-08-22T18:00:00+07:00', facility: club1, court: 2, partner: 'Bảo Demo', opponents: [a, b], scoreFor: 11, scoreAgainst: 8, ratingChange: 9 },
  { id: 's2', playedAt: '2026-08-29T19:00:00+07:00', facility: club1, court: 3, partner: 'Bảo Demo', opponents: [c, d], scoreFor: 7, scoreAgainst: 11, ratingChange: -6 },
  { id: 's3', playedAt: '2026-09-05T18:00:00+07:00', facility: club2, court: 1, partner: 'Khoa Demo', opponents: [e, f], scoreFor: 11, scoreAgainst: 5, ratingChange: 7 },
  { id: 's4', playedAt: '2026-09-12T17:00:00+07:00', facility: club1, court: 2, partner: 'Bảo Demo', opponents: [a, e], scoreFor: 11, scoreAgainst: 9, ratingChange: 8 },
  { id: 's5', playedAt: '2026-09-19T19:00:00+07:00', facility: club1, court: 1, partner: 'Khoa Demo', opponents: [c, b], scoreFor: 9, scoreAgainst: 11, ratingChange: -7 },
  { id: 's6', playedAt: '2026-09-23T18:00:00+07:00', facility: club2, court: 4, partner: 'Bảo Demo', opponents: [d, f], scoreFor: 11, scoreAgainst: 6, ratingChange: 6 },
  { id: 's7', playedAt: '2026-09-27T18:00:00+07:00', facility: club1, court: 3, partner: 'Khoa Demo', opponents: [c, a], scoreFor: 8, scoreAgainst: 11, ratingChange: -8 },
  { id: 's8', playedAt: '2026-10-01T19:00:00+07:00', facility: club1, court: 2, partner: 'Bảo Demo', opponents: [b, e], scoreFor: 11, scoreAgainst: 4, ratingChange: 5 },
  { id: 's9', playedAt: '2026-10-04T17:00:00+07:00', facility: club2, court: 2, partner: 'Bảo Demo', opponents: [a, f], scoreFor: 11, scoreAgainst: 10, ratingChange: 9 },
  { id: 's10', playedAt: '2026-10-08T18:00:00+07:00', facility: club1, court: 1, partner: 'Khoa Demo', opponents: [c, d], scoreFor: 11, scoreAgainst: 7, ratingChange: 12 },
  { id: 's11', playedAt: '2026-10-11T19:00:00+07:00', facility: club1, court: 3, partner: 'Bảo Demo', opponents: [a, b], scoreFor: 11, scoreAgainst: 6, ratingChange: 6 },
  { id: 's12', playedAt: '2026-10-13T18:00:00+07:00', facility: club1, court: 2, partner: 'Khoa Demo', opponents: [c, f], scoreFor: 11, scoreAgainst: 9, ratingChange: 8 },
];

export const SAMPLE_EQUIPMENT: { paddle?: string; shoes?: string; apparel?: string } = {
  paddle: 'Sample Carbon 16 mm paddle',
  shoes: 'Sample court shoes, size 41',
  apparel: undefined,
};

export const SAMPLE_UPCOMING = {
  booking: {
    startsAt: '2026-10-17T18:00:00+07:00',
    facility: club1,
    court: 3,
    /** Integer VND, pay at the facility. */
    priceVnd: 180000,
  },
  invitation: {
    from: 'Khoa Demo',
    startsAt: '2026-10-18T07:00:00+07:00',
    facility: club2,
    level: '3.0 to 3.5',
    spotsOpen: 1,
    priceVnd: 60000,
  },
  queue: {
    facility: club1,
    position: 3,
    waitMinutes: 20,
  },
};

/** Stats that need computer vision on real court footage. Names only, never numbers. */
export const NOT_AVAILABLE_STATS = [
  'serveConsistency',
  'shotPlacement',
  'unforcedErrors',
  'courtPositioning',
  'movement',
  'ballSpeed',
] as const;

export type NotAvailableStat = (typeof NOT_AVAILABLE_STATS)[number];
