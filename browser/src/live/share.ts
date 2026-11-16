// A scenario as a web address: the settings a visitor can change, written
// into the query string so a link reopens the same scenario.
//
// The link carries settings, not results. The same settings give the same day
// in the same browser; another browser's maths may round differently in rare
// cases, and then the day can differ.

import type { SimConfig } from '../sim/sim';

/** Query name -> setting. Radius travels in km, as the form shows it. */
const FIELDS: [param: string, key: keyof SimConfig][] = [
  ['seed', 'seed'],
  ['day', 'startDay'],
  ['start', 'startHour'],
  ['drivers', 'nDrivers'],
  ['orders', 'peakOrdersPerHour'],
  ['traffic', 'trafficScale'],
  ['radius', 'deliveryRadiusM'],
  ['dispatcher', 'dispatcher'],
];

export function queryFromConfig(cfg: SimConfig): string {
  const q = new URLSearchParams();
  for (const [param, key] of FIELDS) {
    const value = key === 'deliveryRadiusM' ? cfg.deliveryRadiusM / 1000 : cfg[key];
    q.set(param, String(value));
  }
  return q.toString();
}

/**
 * Settings named in a query string. Values are passed on as written: the
 * simulator checks and clamps them (see applyChanges), so a mangled link
 * falls back to the defaults instead of breaking the page.
 */
export function changesFromQuery(search: string): Record<string, unknown> {
  const q = new URLSearchParams(search);
  const out: Record<string, unknown> = {};
  for (const [param, key] of FIELDS) {
    const value = q.get(param);
    if (value === null || value.trim() === '') continue;
    out[key] = key === 'deliveryRadiusM' ? Number(value) * 1000 : value;
  }
  return out;
}

/** The address that reopens this scenario on the page at `base`. */
export function scenarioUrl(base: string, cfg: SimConfig): string {
  const url = new URL(base);
  url.search = queryFromConfig(cfg);
  return url.toString();
}
