import { describe, expect, it } from 'vitest';
import { applyChanges } from '../src/live/controller';
import { changesFromQuery, queryFromConfig, scenarioUrl } from '../src/live/share';
import { makeConfig } from '../src/sim/sim';

describe('scenario links', () => {
  const cfg = makeConfig({
    seed: 42, startDay: 'Sat', startHour: 16, nDrivers: 120, peakOrdersPerHour: 520,
    trafficScale: 1.5, deliveryRadiusM: 2500, dispatcher: 'nearest',
  }); // prettier-ignore

  it('round-trips every setting a visitor can change', () => {
    const query = queryFromConfig(cfg);
    expect(query).toBe('seed=42&day=Sat&start=16&drivers=120&orders=520&traffic=1.5&radius=2.5&dispatcher=nearest');
    expect(applyChanges(makeConfig(), changesFromQuery(`?${query}`))).toEqual(cfg);
  });

  it('ignores what it does not know and survives a mangled link', () => {
    const changes = changesFromQuery('?drivers=lots&day=Caturday&utm_source=x&seed=&dispatcher=fastest&radius=99');
    expect(Object.keys(changes).sort()).toEqual(['deliveryRadiusM', 'dispatcher', 'nDrivers', 'startDay']);
    expect(applyChanges(makeConfig(), changes)).toEqual(makeConfig({ deliveryRadiusM: 8000 }));
    expect(changesFromQuery('')).toEqual({});
  });

  it('builds a link to another page', () => {
    expect(scenarioUrl('https://example.org/lab/dispatch/?old=1#top', makeConfig())).toBe(
      'https://example.org/lab/dispatch/?seed=7&day=Fri&start=10&drivers=220&orders=400&traffic=1&radius=4.5&dispatcher=matching_jit#top',
    );
  });
});
