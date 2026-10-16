import { confidence, confidenceBand } from '../src/pir.js';
import { describe, expect, it } from 'vitest';

describe('rating confidence', () => {
  it('uses Low, Medium, and High instead of a probability', () => {
    expect(confidenceBand(0)).toBe('low');
    expect(confidenceBand(4)).toBe('low');
    expect(confidenceBand(5)).toBe('medium');
    expect(confidenceBand(19)).toBe('medium');
    expect(confidenceBand(20)).toBe('high');
    expect(confidence(1)).toBe(confidence(4));
    expect(confidence(4)).toBeLessThan(confidence(8));
    expect(confidence(8)).toBeLessThan(confidence(40));
  });
});
