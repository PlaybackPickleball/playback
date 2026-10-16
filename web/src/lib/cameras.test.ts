import { describe, expect, it } from 'vitest';
import { assignEnds, moveCamera } from './cameras';

describe('end camera assignment', () => {
  it('gives two different devices to the two ends', () => {
    expect(assignEnds(['cam-a', 'cam-b', 'cam-c'])).toEqual({ 1: 'cam-a', 2: 'cam-b' });
  });

  it('leaves the other end empty when only one camera exists', () => {
    expect(assignEnds(['only'])).toEqual({ 1: 'only', 2: null });
    expect(assignEnds([])).toEqual({ 1: null, 2: null });
  });

  it('does not copy one device onto both ends', () => {
    expect(assignEnds(['same', 'same'])).toEqual({ 1: 'same', 2: null });
    const swapped = moveCamera({ 1: 'same', 2: null }, 2, 'same');
    expect(swapped).toEqual({ 1: null, 2: 'same' });
    expect(swapped[1]).not.toBe(swapped[2]);
  });

  it('swaps ends when the chosen camera is already on the other end', () => {
    expect(moveCamera({ 1: 'cam-a', 2: 'cam-b' }, 1, 'cam-b')).toEqual({ 1: 'cam-b', 2: 'cam-a' });
  });
});
