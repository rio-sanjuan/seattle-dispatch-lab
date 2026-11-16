import { describe, expect, it } from 'vitest';
import {
  BatchedMatching, JustInTimeMatching, NearestDriver, type DispatchView,
} from '../src/sim/dispatch'; // prettier-ignore
import { Rng } from '../src/sim/rng';

interface Extra {
  now?: number;
  estReady?: number[];
  declined?: boolean[][];
  placed?: number[];
}

function view(pickup: number[][], extra: Extra = {}): DispatchView {
  const O = pickup.length;
  const D = pickup[0].length;
  const now = extra.now ?? 1000;
  return {
    now,
    driverIds: Int32Array.from({ length: D }, (_, j) => 100 + j),
    orderIds: Int32Array.from({ length: O }, (_, i) => i),
    pickup: Float64Array.from(pickup.flat()),
    dropoff: new Float64Array(O * D).fill(300),
    placed: Float64Array.from(extra.placed ?? Array(O).fill(now - 60)),
    estReady: Float64Array.from(extra.estReady ?? Array(O).fill(now)),
    promised: new Float64Array(O).fill(now + 3600),
    declined: Uint8Array.from((extra.declined ?? pickup.map((r) => r.map(() => false))).flat(), Number),
  };
}

// Order 0 is slightly closer to driver 100 than order 1 is, but driver 101 is
// hopeless for order 1. Greedy gives driver 100 to order 0 and strands order 1.
const TRAP = [[100, 200], [150, 2000]]; // prettier-ignore
const policies = () => [new NearestDriver(), new BatchedMatching(), new JustInTimeMatching()];

describe('dispatchers', () => {
  it('nearest is greedy', () => {
    expect(new NearestDriver().decide(view(TRAP, { placed: [900, 950] }))).toEqual([[100, 0], [101, 1]]); // prettier-ignore
  });

  it('matching avoids the greedy trap', () => {
    const offers = new BatchedMatching().decide(view(TRAP, { placed: [900, 950] }));
    expect(offers.sort()).toEqual([[100, 1], [101, 0]]); // prettier-ignore
  });

  it('never re-offers a declined pair', () => {
    const declined = [[true, false], [false, false]]; // prettier-ignore
    for (const policy of policies()) {
      const offers = policy.decide(view([[10, 500], [400, 20]], { declined })); // prettier-ignore
      expect(offers).not.toContainEqual([100, 0]);
    }
  });

  it('uses each driver and order once', () => {
    const rng = new Rng(0);
    for (const policy of policies()) {
      const pickup = Array.from({ length: 7 }, () => Array.from({ length: 4 }, () => rng.uniform(60, 900)));
      const offers = policy.decide(view(pickup));
      expect(offers.length).toBe(4);
      expect(new Set(offers.map((o) => o[0])).size).toBe(4);
      expect(new Set(offers.map((o) => o[1])).size).toBe(4);
    }
  });

  it('serves old orders first when drivers are scarce', () => {
    expect(new BatchedMatching().decide(view([[300], [300]], { placed: [0, 900] }))).toEqual([[100, 0]]);
  });

  it('just-in-time holds an order whose food is far from ready', () => {
    const now = 1000;
    const v = view([[120], [120]], { now, estReady: [now + 60, now + 1500] });
    expect(new BatchedMatching().decide(v).length).toBe(1);
    expect(new JustInTimeMatching().decide(v)).toEqual([[100, 0]]);
  });
});
