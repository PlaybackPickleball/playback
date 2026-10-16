import { describe, expect, it } from 'vitest';
import { haversineKm, withinRadiusKm } from '../src/geo.js';

const hanoi = { latitude: 21.0285, longitude: 105.8542 };
const hcmc = { latitude: 10.8231, longitude: 106.6297 };

describe('haversine distance', () => {
  it('is zero for the same point', () => {
    expect(haversineKm(hcmc, hcmc)).toBe(0);
  });

  it('matches a known long distance (Hanoi to Ho Chi Minh City, about 1,137 km)', () => {
    expect(haversineKm(hanoi, hcmc)).toBeGreaterThan(1125);
    expect(haversineKm(hanoi, hcmc)).toBeLessThan(1150);
    expect(haversineKm(hanoi, hcmc)).toBeCloseTo(haversineKm(hcmc, hanoi), 9);
  });

  it('matches one degree of latitude (about 111.19 km)', () => {
    expect(haversineKm({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 })).toBeCloseTo(111.19, 1);
  });

  it('separates points inside and outside a 5 km radius', () => {
    const near = { latitude: hcmc.latitude + 0.03, longitude: hcmc.longitude }; // ~3.3 km
    const far = { latitude: hcmc.latitude + 0.06, longitude: hcmc.longitude }; // ~6.7 km
    expect(withinRadiusKm(hcmc, near, 5)).toBe(true);
    expect(withinRadiusKm(hcmc, far, 5)).toBe(false);
    expect(withinRadiusKm(hcmc, hcmc, 5)).toBe(true);
  });
});
