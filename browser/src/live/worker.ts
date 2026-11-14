// The worker: owns the simulation so the page stays responsive, and posts a
// snapshot about ten times a second.

import { RoadNetwork } from '../sim/network';
import type { TrafficProfile } from '../sim/traffic';
import { LiveSim } from './controller';
import type { FromWorker, ToWorker } from './protocol';

const TICK_MS = 100;
const scope = self as unknown as {
  postMessage(message: FromWorker): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
};

let live: LiveSim | null = null;
let last = 0;

function tick(): void {
  if (!live) return;
  const now = performance.now();
  live.step((now - last) / 1000);
  last = now;
  if (live.visible) scope.postMessage(live.state(now));
}

function guarded(work: () => void): void {
  try {
    work();
  } catch (error) {
    scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
}

scope.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === 'init') {
    scope.postMessage({ type: 'busy' });
    guarded(() => {
      const net = RoadNetwork.fromBinary(msg.network);
      live = new LiveSim(net, msg.profile as TrafficProfile, msg.config);
      scope.postMessage(live.hello());
      last = performance.now();
      setInterval(tick, TICK_MS);
    });
  } else if (msg.type === 'cmd' && live) {
    const sim = live;
    if (msg.cmd === 'restart') {
      // Tell the page first: building a day blocks this thread for about a second.
      scope.postMessage({ type: 'busy' });
      setTimeout(() => {
        guarded(() => sim.handle(msg));
        scope.postMessage(sim.hello());
        last = performance.now();
      }, 0);
    } else {
      guarded(() => sim.handle(msg));
      if (msg.cmd === 'visible' && msg.on) last = performance.now();
    }
  }
};
