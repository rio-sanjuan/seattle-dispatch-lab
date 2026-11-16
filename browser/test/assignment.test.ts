import { describe, expect, it } from 'vitest';
import { linearSumAssignment } from '../src/sim/assignment';
import { fixture, readJSON } from './helpers';

interface Case {
  nr: number;
  nc: number;
  cost: number[];
  rows: number[];
  cols: number[];
}

describe('assignment solver', () => {
  const cases = readJSON<Case[]>(fixture('assignment.json'));

  it('gives the same pairs as scipy, ties included', () => {
    expect(cases.length).toBeGreaterThan(40);
    for (const c of cases) {
      const got = linearSumAssignment(c.cost, c.nr, c.nc);
      expect(Array.from(got.rows)).toEqual(c.rows);
      expect(Array.from(got.cols)).toEqual(c.cols);
    }
  });

  it('handles an empty side', () => {
    expect(linearSumAssignment([], 0, 3).rows.length).toBe(0);
    expect(linearSumAssignment([], 3, 0).rows.length).toBe(0);
  });
});
