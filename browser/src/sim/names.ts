// Made-up restaurant names. Locations are realistic; the businesses are not.

import type { Rng } from './rng';

const ADJECTIVES = [
  'Golden', 'Lucky', 'Blue', 'Little', 'Smoky', 'Sunny', 'Salty', 'Copper', 'Velvet', 'Crooked',
  'Sleepy', 'Wild', 'Humble', 'Bright', 'Mossy', 'Rusty', 'Jolly', 'Quiet', 'Amber', 'Foggy',
  'Drifting', 'Paper', 'Midnight', 'Tin',
]; // prettier-ignore
const NOUNS = [
  'Heron', 'Otter', 'Kettle', 'Lantern', 'Anchor', 'Fern', 'Orca', 'Spruce', 'Marmot', 'Ferry',
  'Compass', 'Sparrow', 'Cedar', 'Pebble', 'Raven', 'Tide', 'Salmon', 'Umbrella', 'Barnacle',
  'Juniper', 'Owl', 'Skillet', 'Pickle', 'Fox',
]; // prettier-ignore
const CUISINES = [
  'Thai', 'Tacos', 'Pho', 'Pizza', 'Burgers', 'Sushi', 'Teriyaki', 'Ramen', 'Dumplings', 'Curry',
  'Bagels', 'Poke', 'Falafel', 'BBQ', 'Noodles', 'Wings', 'Sandwiches', 'Banh Mi', 'Kebab', 'Salads',
]; // prettier-ignore

export function restaurantNames(n: number, rng: Rng): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const pick = (list: string[]): string => list[rng.integers(list.length)];
  while (out.length < n) {
    const name = `${pick(ADJECTIVES)} ${pick(NOUNS)} ${pick(CUISINES)}`;
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}
