// The worker: owns the simulation so the page stays responsive, and posts a
// snapshot about ten times a second.

import { RoadNetwork } from '../sim/network';
import type { TrafficProfile } from '../sim/traffic';
import { DISPATCHER_LIST } from '../sim/dispatch';
import type { Summary } from '../sim/metrics';
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

/** Run the day on screen under each dispatcher, reporting after each one. */
function compare(sim: LiveSim): void {
  const generation = sim.generation;
  const summaries: Summary[] = [];
  const report = (): void =>
    scope.postMessage({
      type: 'comparison', generation, dispatchers: DISPATCHER_LIST, done: summaries.length, summaries,
    }); // prettier-ignore
  const next = (): void => {
    if (sim.generation !== generation) return; // the day was restarted meanwhile
    guarded(() => {
      summaries.push(sim.compareUnder(DISPATCHER_LIST[summaries.length].name));
      report();
      last = performance.now(); // the live day did not advance while this ran
      if (summaries.length < DISPATCHER_LIST.length) setTimeout(next, 0);
    });
  };
  report();
  setTimeout(next, 0);
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
      live = new LiveSim(net, msg.profile as TrafficProfile, msg.config, msg.changes);
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
    } else if (msg.cmd === 'compare') {
      compare(sim);
    } else {
      guarded(() => sim.handle(msg));
      if (msg.cmd === 'visible' && msg.on) last = performance.now();
    }
  }
};
