import { describe, expect, it } from 'vitest';
import { en } from '../i18n/en';
import { vi } from '../i18n/vi';
import {
  confirmedDoubles,
  confirmedTeamSplit,
  courtStartHref,
  facilityOptions,
  formatVnd,
  holdableSlots,
  paymentLabel,
  perPlayerVnd,
  priceParts,
  priceView,
  queueEntryHere,
  queueEstimateView,
  startOnCourtOne,
  venueDate,
  visibleBuildSlots,
  visibleJoinGames,
  visibleQueues,
  DEMO_FACILITY_OPTIONS,
} from './playNow';

const sides = {
  teamA: [{ displayName: 'Lan Phạm' }, { displayName: 'Quang Đỗ' }],
  teamB: [{ displayName: 'An Nguyễn' }, { displayName: 'Mai Bùi' }],
};

describe('Play Now money and payment', () => {
  it('formats integer VND with the vi-VN currency format', () => {
    const formatted = formatVnd(45000);
    expect(formatted).toBe(new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 }).format(45000));
    expect(formatted).toContain('45.000');
    expect(formatVnd(120000)).toContain('120.000');
  });

  it('splits a court price into the per-player amount open matches store', () => {
    expect(perPlayerVnd(170_000)).toBe(45_000);
    expect(perPlayerVnd(120_000)).toBe(30_000);
    expect(perPlayerVnd(150_000)).toBe(40_000);
  });

  it('shows a Smart Fill badge and a struck normal price only when both prices are present', () => {
    const offer = priceView({ normalPriceVnd: 150_000, promoPriceVnd: 120_000 }, 45_000);
    expect(offer).toEqual({ kind: 'smart_fill', normalPriceVnd: 150_000, promoPriceVnd: 120_000 });
    expect(priceParts(offer)).toEqual({
      badge: true,
      strike: formatVnd(150_000),
      current: formatVnd(120_000),
    });
    expect(priceView(null, 45_000)).toEqual({ kind: 'listed', priceVnd: 45_000 });
    expect(priceView(undefined, 45_000).kind).toBe('listed');
    expect(priceParts(priceView(undefined, 45_000)).strike).toBeNull();
    expect(priceView({ normalPriceVnd: 150_000 }, 45_000).kind).toBe('listed');
    expect(priceView('promo', null)).toEqual({ kind: 'none' });
  });

  it('labels every game pay at facility and never processed', () => {
    const pay = paymentLabel();
    expect(pay).toEqual({ method: 'pay_at_facility', processed: false, label: 'Pay at facility. Not paid yet' });
    expect(pay.label).toBe(en.pnPayAtFacility);
    expect(pay.label.toLowerCase()).not.toMatch(/payment (was|has been) (processed|taken|received|collected)/);
    expect(vi.pnPayAtFacility).toBe('Thanh toán tại sân. Chưa thanh toán');
  });
});

describe('Play Now teams, queue, and filters', () => {
  it('splits a confirmed doubles game into Team A red and Team B blue', () => {
    const split = confirmedTeamSplit({ status: 'confirmed', format: 'doubles', teamSplit: { recommended: sides } });
    expect(split).toEqual({
      teamA: { color: 'red', names: ['Lan Phạm', 'Quang Đỗ'] },
      teamB: { color: 'blue', names: ['An Nguyễn', 'Mai Bùi'] },
    });
    expect(confirmedTeamSplit({ status: 'open', format: 'doubles', teamSplit: { recommended: sides } })).toBeNull();
    expect(confirmedTeamSplit({ status: 'confirmed', format: 'singles', teamSplit: { recommended: sides } })).toBeNull();
    expect(confirmedTeamSplit({ status: 'confirmed', format: 'doubles', teamSplit: null })).toBeNull();
  });

  it('links Court 1 to the court page and keeps the exact start label for court 1', () => {
    expect(courtStartHref('court-1')).toBe('/court/court-1');
    expect(courtStartHref(null)).toBeNull();
    expect(startOnCourtOne(1, 'demo-binh-thanh-court-1')).toBe(true);
    expect(startOnCourtOne(null, 'court-1')).toBe(true);
    expect(startOnCourtOne(3, 'court-3')).toBe(false);
    expect(en.pnStartCourt1).toBe('Start on Court 1');
    expect(vi.pnStartCourt1).toBe('Bắt đầu ở Sân 1');
  });

  it('says the estimate is unavailable until a real range exists', () => {
    expect(queueEstimateView({ status: 'not_available_yet', waitMinutes: null })).toEqual({ available: false });
    expect(queueEstimateView(null)).toEqual({ available: false });
    expect(queueEstimateView(undefined)).toEqual({ available: false });
    expect(queueEstimateView({ status: 'estimated', waitMinutes: null })).toEqual({ available: false });
    expect(queueEstimateView({ status: 'estimated', waitMinutes: null, typicalMinutes: { low: 10, high: 25 } })).toEqual({
      available: true,
      low: 10,
      high: 25,
    });
    expect(en.pnEstimateUnavailable).toBe('Estimate not available yet');
    expect(vi.pnEstimateUnavailable).toBe('Chưa có ước tính');
  });

  it('keeps the three Play Now tab phrases in English and Vietnamese', () => {
    expect(vi.pnTitle).toBe('Chơi ngay');
    expect(en.pnJoinExisting).toBe('Join a game');
    expect(vi.pnJoinExisting).toBe('Vào trận có sẵn');
    expect(en.pnBuildGame).toBe('Build my game');
    expect(vi.pnBuildGame).toBe('Tạo trận');
    expect(en.pnJoinQueue).toBe('Queue');
    expect(vi.pnJoinQueue).toBe('Xếp hàng');
    expect(en.pnSmartFillPrice).toBe('Smart Fill price');
    expect(vi.pnSmartFillPrice).toBe('Giá lấp sân');
    expect(en.pnRequestJoin).toBe('Request to join');
    expect(vi.pnRequestJoin).toBe('Xin vào trận');
    expect(en.pnWaitingApproval).toBe('Waiting for facility approval');
    expect(vi.pnWaitingApproval).toBe('Chờ sân duyệt');
    expect(vi.pnSeats).toBe('Còn {n} chỗ');
    expect(en.pnConfirmed).toBe('Game confirmed');
    expect(vi.pnConfirmed).toBe('Trận đã chốt');
    expect(en.pnTeamA).toBe('Team A (red)');
    expect(vi.pnTeamA).toBe('Đội A (đỏ)');
    expect(en.pnTeamB).toBe('Team B (blue)');
    expect(vi.pnTeamB).toBe('Đội B (xanh dương)');
  });

  it('filters games, courts to build, and the queue by facility and date', () => {
    const join = visibleJoinGames(
      [
        { match: { facilityId: 'demo-facility', start: '2026-10-17T19:00' } },
        { match: { facilityId: 'demo-facility', start: '2026-10-18T19:00' } },
        { match: { facilityId: 'demo-facility-quan-7', start: '2026-10-17T18:00' } },
      ],
      'demo-facility',
      '2026-10-17',
    );
    expect(join).toEqual([{ match: { facilityId: 'demo-facility', start: '2026-10-17T19:00' } }]);
    expect(visibleBuildSlots([{ slot: { facilityId: 'demo-facility', start: '2026-10-17T17:00' } }, { slot: { facilityId: 'other', start: '2026-10-17T17:00' } }], 'demo-facility', '2026-10-17')).toHaveLength(1);
    expect(visibleQueues([{ facilityId: 'demo-facility' }, { facilityId: 'demo-facility-binh-thanh' }], 'demo-facility')).toEqual([{ facilityId: 'demo-facility' }]);
    expect(holdableSlots(
      [
        { id: 'open', bookable: true, status: 'available' },
        { id: 'shown', bookable: true, status: 'available' },
        { id: 'held', bookable: false, status: 'held' },
      ],
      ['shown'],
    )).toEqual([{ id: 'open', bookable: true, status: 'available' }]);
    expect(confirmedDoubles(
      [{ facilityId: 'demo-facility', status: 'confirmed', format: 'doubles', teamSplit: { recommended: sides } }, { facilityId: 'other', status: 'confirmed', format: 'doubles', teamSplit: { recommended: sides } }],
      'demo-facility',
    )).toHaveLength(1);
    expect(queueEntryHere({ facilityId: 'demo-facility', status: 'waiting' }, 'demo-facility')?.status).toBe('waiting');
    expect(queueEntryHere({ facilityId: 'demo-facility', status: 'cancelled' }, 'demo-facility')).toBeNull();
    expect(facilityOptions(DEMO_FACILITY_OPTIONS, [{ facilityId: 'demo-facility', facilityName: 'ignored' }, { facilityId: 'club-2', facilityName: 'Night Club' }])).toEqual([
      { id: 'demo-facility', name: 'PlayBack Demo Club', demo: true },
      { id: 'demo-facility-binh-thanh', name: 'Bình Thạnh Pickleball (Demo)', demo: true },
      { id: 'demo-facility-quan-7', name: 'Quận 7 Pickleball (Demo)', demo: true },
      { id: 'club-2', name: 'Night Club', demo: false },
    ]);
    expect(venueDate(new Date('2026-10-15T17:30:00Z'))).toBe('2026-10-16');
    expect(venueDate(new Date('2026-10-15T16:30:00Z'))).toBe('2026-10-15');
  });
});
