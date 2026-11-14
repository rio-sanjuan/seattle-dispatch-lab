// Public entry points.
//
//   mountDispatchLab(element, { dataUrl })   the live view, ready to put on a page
//   Simulation, makeConfig, ...              the simulator alone, for other uses

export { mountDispatchLab, type MountOptions, type Mounted } from './ui/app';
export { LiveSim, SPEEDS } from './live/controller';
export { DISPATCHERS, DISPATCHER_LIST, type DispatchView, type Dispatcher } from './sim/dispatch';
export { METRICS, summarize, type Metric, type Summary } from './sim/metrics';
export { RoadNetwork, Route, TRAFFIC_CLASSES } from './sim/network';
export { DEFAULT_CONFIG, Simulation, makeConfig, type SimConfig } from './sim/sim';
export { Traffic, type TrafficProfile } from './sim/traffic';
