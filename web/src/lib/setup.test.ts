import { describe, expect, it } from 'vitest';
import { validateSetup } from './setup';

describe('session setup validation', () => {
  it('accepts two trimmed singles names and consent, with no end switch, server, or camera', () => {
    expect(validateSetup({ mode: 'singles', names: [' Lan ', 'Minh', '', ''], consent: true })).toEqual([]);
  });

  it('accepts four trimmed doubles names and consent', () => {
    expect(validateSetup({ mode: 'doubles', names: [' A ', 'B', 'C', ' D '], consent: true })).toEqual([]);
  });

  it('highlights only the blank singles name and missing consent', () => {
    expect(validateSetup({ mode: 'singles', names: ['Lan', '   '], consent: false })).toEqual([
      { field: 'name-1', code: 'name_required' },
      { field: 'consent', code: 'consent_required' },
    ]);
  });

  it('requires the empty doubles slot and leaves the filled ones alone', () => {
    expect(validateSetup({ mode: 'doubles', names: ['A', 'B', '  ', 'D'], consent: true })).toEqual([
      { field: 'name-2', code: 'name_required' },
    ]);
  });
});
