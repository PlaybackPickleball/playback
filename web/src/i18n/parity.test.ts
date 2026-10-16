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
});
