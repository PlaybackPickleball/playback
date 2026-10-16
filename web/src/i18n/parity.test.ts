import { describe, expect, it } from 'vitest';
import { en } from './en';
import { vi } from './vi';

const sameInBoth = new Set(['appName', 'langEnglish', 'langVietnamese', 'demoBadge']);

describe('translation parity', () => {
  it('uses the same keys in English and Vietnamese', () => {
    expect(Object.keys(vi).sort()).toEqual(Object.keys(en).sort());
  });

  it('has no empty strings and translates Vietnamese', () => {
    let accents = 0;
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(en[key].trim().length).toBeGreaterThan(0);
      expect(vi[key].trim().length).toBeGreaterThan(0);
      if (!sameInBoth.has(key)) expect(vi[key]).not.toBe(en[key]);
      accents += (vi[key].match(/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/gi) ?? []).length;
    }
    expect(accents).toBeGreaterThan(40);
  });

  it('has Playback Rating phrases in both dictionaries', () => {
    expect(en.pbRating).toBe('Playback Rating');
    expect(vi.pbRating).toBe('Điểm xếp hạng Playback');
    expect(vi.pbProvisional).toBe('Điểm xếp hạng tạm thời');
    expect(vi.pbVerifiedMatches).toBe('Trận đấu đã xác nhận');
    expect(vi.pbConfidence).toBe('Độ tin cậy của điểm xếp hạng');
    expect(vi.pbHistory).toBe('Lịch sử trận đấu');
    expect(vi.pbWinRate).toBe('Tỷ lệ thắng');
    expect(vi.pbRatingUp).toBe('Điểm xếp hạng tăng');
    expect(vi.pbRatingDown).toBe('Điểm xếp hạng giảm');
    expect(vi.pbConfirmResult).toBe('Xác nhận kết quả trận đấu');
    expect(vi.pbDisputeResult).toBe('Khiếu nại kết quả');
    for (const key of [
      'pbRating',
      'pbProvisional',
      'pbVerifiedMatches',
      'pbConfidence',
      'pbHistory',
      'pbWinRate',
      'pbRatingUp',
      'pbRatingDown',
      'pbConfirmResult',
      'pbDisputeResult',
    ] as const) {
      expect(en[key].length).toBeGreaterThan(0);
      expect(vi[key].length).toBeGreaterThan(0);
    }
  });
});
