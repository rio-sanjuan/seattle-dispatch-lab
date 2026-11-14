// The live view: puts the widget on the page, starts the worker, and draws
// what the worker reports. A port of web/app.js that needs no server.

import type { Detail, FromWorker, Hello, State, ToWorker } from '../live/protocol';
import { RoadNetwork } from '../sim/network';
import type { FeedItem, SimConfig } from '../sim/sim';
import { DAYS } from '../sim/traffic';
import { Charts, fmt } from './charts';
import { MapView, type Hit } from './map';
import { TEMPLATE } from './template';

export interface MountOptions {
  /** Folder that holds network.bin and traffic_profile.json. */
  dataUrl: string;
  /** Load and start at once, instead of waiting for the visitor to press Start. */
  autostart?: boolean;
  /**
   * 'modifier' (the default) zooms on ctrl/cmd + wheel or a pinch, so an
   * ordinary scroll moves the page. 'always' suits a page that is only the map.
   */
  wheelZoom?: 'always' | 'modifier';
  /** Settings for the first day. */
  config?: Partial<SimConfig>;
  /** Make the worker yourself, if your bundler needs a different form. */
  createWorker?: () => Worker;
}

export interface Mounted {
  destroy(): void;
}

// Driver states: 0 offline, 1 idle, 2 offered, 3 to restaurant, 4 at restaurant, 5 to customer, 6 at door
const DRIVER_LABEL = ['Off shift', 'Free', 'Deciding on an offer', 'Heading to restaurant',
  'Waiting at restaurant', 'Delivering', "At the customer's door"]; // prettier-ignore
const ORDER_LABEL = ['Waiting for a driver', 'Offered to a driver', 'Driver on the way to restaurant',
  'Driver at restaurant', 'On the way to customer', 'Delivered']; // prettier-ignore
const TRAFFIC_NAME: Record<string, string> = {
  I5_N: 'I-5 northbound',
  I5_S: 'I-5 southbound',
  arterial: 'Main city streets (estimated)',
  local: 'Side streets (estimated)',
};
let instances = 0;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string | null, cls?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (text != null) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}

export function mountDispatchLab(root: HTMLElement, options: MountOptions): Mounted {
  const uid = `sdl${++instances}`;
  root.classList.add('sdl');
  root.innerHTML = TEMPLATE;
  const find = <T extends HTMLElement = HTMLElement>(name: string): T => {
    const node = root.querySelector<T>(`[data-el="${name}"]`);
    if (!node) throw new Error(`dispatch lab: missing element "${name}"`);
    return node;
  };
  // Tie each label to its control with ids that stay unique if the page has two widgets.
  for (const label of root.querySelectorAll<HTMLLabelElement>('label[data-for]')) {
    const target = find(label.dataset.for as string);
    target.id = `${uid}-${label.dataset.for}`;
    label.htmlFor = target.id;
  }

  let meta: Hello | null = null;
  let last: State | null = null;
  let worker: Worker | null = null;
  let selected: number | null = null;
  let started = false;
  let onScreen = true;
  const undo: (() => void)[] = [];

  const clock = (simSeconds: number): string => {
    const h = (meta?.config.startHour ?? 0) + simSeconds / 3600;
    const hh = Math.floor(h) % 24;
    const mm = Math.floor((h % 1) * 60 + 1e-6);
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  };
  const send = (msg: ToWorker): void => worker?.postMessage(msg);
  const banner = (text: string | null): void => {
    find('banner').hidden = text === null;
    find('banner').textContent = text ?? '';
  };
  const setValue = (name: string, main: string, unit?: string): void => {
    const n = find(name);
    n.textContent = main;
    if (unit) n.append(el('small', ` ${unit}`));
  };

  const describe = (hit: Hit): string => {
    if (hit.kind === 'driver') {
      return `Driver ${hit.id}: ${DRIVER_LABEL[hit.status]}${hit.order >= 0 ? `, order #${hit.order}` : ''}`;
    }
    if (hit.kind === 'order') {
      return `Order #${hit.id}: ${ORDER_LABEL[hit.status]}. Promised by ${clock(hit.promised)}${hit.late ? ' (late)' : ''}`;
    }
    return `${hit.name} (food usually ready in ${hit.prep} min)`;
  };
  const select = (id: number | null): void => {
    selected = id;
    send({ type: 'cmd', cmd: 'select', id: id ?? -1 });
    if (id === null) {
      find('detail').hidden = true;
      map.setSelection(null, null);
    } else {
      map.setSelection(id, null);
    }
  };
  const map = new MapView(root, find('map'), { onSelect: select, describe }, options.wheelZoom ?? 'modifier');
  const charts = new Charts(root, find, clock);
  const paintTheme = (): void => {
    map.refreshColors();
    const ramp = map.rampCss;
    find('ramp').style.background = ramp.gradient;
    find('ramp-label').textContent = ramp.label;
    charts.draw();
  };
  paintTheme();

  // ------------------------------------------------------------- messages

  function onHello(msg: Hello): void {
    meta = msg;
    last = null;
    selected = null;
    find('detail').hidden = true;
    find('feed').replaceChildren();
    banner(null);

    const dispatcher = find<HTMLSelectElement>('dispatcher');
    dispatcher.replaceChildren();
    for (const d of msg.dispatchers) {
      const option = el('option', d.label);
      option.value = d.name;
      dispatcher.append(option);
    }
    dispatcher.value = msg.config.dispatcher;
    const speeds = find('speeds');
    speeds.replaceChildren();
    for (const s of msg.speeds) {
      const b = el('button', `${s}×`);
      b.type = 'button';
      b.dataset.speed = String(s);
      b.title = `${s} simulated seconds per second`;
      b.setAttribute('aria-pressed', 'false');
      b.onclick = () => send({ type: 'cmd', cmd: 'speed', value: s });
      speeds.append(b);
    }
    const day = find<HTMLSelectElement>('f-day');
    day.replaceChildren();
    for (const d of DAYS) {
      const option = el('option', d);
      option.value = d;
      day.append(option);
    }
    const c = msg.config;
    const set = (name: string, value: number | string): void => {
      find<HTMLInputElement>(name).value = String(value);
    };
    set('f-drivers', c.nDrivers);
    set('f-orders', c.peakOrdersPerHour);
    set('f-day', c.startDay);
    set('f-start', c.startHour);
    set('f-traffic', c.trafficScale);
    set('f-seed', c.seed);
    set('f-radius', c.deliveryRadiusM / 1000);

    map.setWorld(msg);
    charts.reset(c.hours);
    find('zoom').hidden = false;
    const legend = find<HTMLDetailsElement>('legend');
    if (legend.hidden) {
      legend.hidden = false;
      legend.open = find('map').clientWidth >= 700; // on a narrow map it would cover too much
    }
    find<HTMLButtonElement>('play').disabled = false;
  }

  function onState(s: State): void {
    if (!meta || s.generation !== meta.generation) return;
    last = s;
    find('clock').textContent = s.clock;
    (find('progress').firstElementChild as HTMLElement).style.width = `${((100 * s.t) / s.end).toFixed(1)}%`;
    find('run-state').textContent = s.finished ? 'Day finished' : s.playing ? `Running at ${s.speed}×` : 'Paused';
    const play = find<HTMLButtonElement>('play');
    play.textContent = s.finished ? 'Finished' : s.playing ? 'Pause' : 'Play';
    play.disabled = s.finished;
    for (const b of find('speeds').children) {
      b.setAttribute('aria-pressed', String(Number((b as HTMLElement).dataset.speed) === s.speed));
    }
    const dispatcher = find<HTMLSelectElement>('dispatcher');
    if (document.activeElement !== dispatcher) dispatcher.value = s.dispatcher;

    map.setState(s);

    let open = 0;
    let late = 0;
    for (const o of s.orders) {
      if (o[1] <= 1) open++;
      if (s.t > o[6]) late++;
    }
    const busy = s.drivers.filter((d) => d[3] >= 3).length;
    const k = s.kpi.hour;
    setValue('k-avg', fmt(k.avg_delivery_min), 'min');
    setValue('k-late', fmt(k.late_pct), '%');
    setValue('k-open', String(open));
    find('k-open-sub').textContent = late
      ? `right now · ${late} active order${late === 1 ? '' : 's'} past the promised time`
      : 'right now';
    setValue('k-busy', String(busy), `of ${s.drivers.length}`);
    find('k-busy-sub').textContent = `right now · ${s.kpi.all.delivered} delivered today`;

    const traffic = find('traffic');
    traffic.replaceChildren();
    meta.trafficClasses.forEach((cls, i) => {
      if (!TRAFFIC_NAME[cls]) return;
      traffic.append(el('div', TRAFFIC_NAME[cls], 'sdl-name'), el('div', `×${s.traffic[i].toFixed(2)}`, 'sdl-x'));
    });

    if (s.series.length) charts.add(s.series);
    if (s.feed.length) addFeed(s.feed);
    if (s.detail && selected !== null) showDetail(s.detail);
  }

  function addFeed(items: FeedItem[]): void {
    const list = find('feed');
    for (const e of items) {
      if (e.kind === 'order' || e.kind === 'pickup') continue; // keep the list to decisions and outcomes
      const li = el('li', null, e.kind);
      li.append(el('time', clock(e.t)), el('span', e.text));
      list.prepend(li);
    }
    while (list.children.length > 60) list.lastElementChild?.remove();
  }

  function showDetail(d: Detail): void {
    if (!meta) return;
    const box = find('detail');
    box.hidden = false;
    box.replaceChildren();
    const head = el('div', null, 'sdl-head');
    head.append(el('span', `Driver ${d.id}`));
    const close = el('button', 'Close');
    close.type = 'button';
    close.onclick = () => select(null);
    head.append(close);
    box.append(head);
    const row = (a: string, b: string): void => {
      const r = el('div', null, 'sdl-row');
      r.append(el('span', a), el('span', b));
      box.append(r);
    };
    row('Doing now', DRIVER_LABEL[d.status]);
    row('Deliveries so far', String(d.deliveries));
    row('Offers declined', String(d.declines));
    row('Distance driven', `${d.km} km`);
    row('Shift ends', clock(d.shiftEnd));
    if (d.order) {
      const r = meta.restaurants[d.order.restaurant];
      row('Order', `#${d.order.id} from ${r[3]}`);
      row('Ordered at', clock(d.order.placed));
      row('Food expected ready', clock(d.order.estReady));
      row('Promised to customer by', clock(d.order.promised));
      map.setSelection(d.id, { restaurant: [r[1], r[2]], customer: [d.order.lon, d.order.lat] });
    } else {
      map.setSelection(d.id, null);
    }
  }

  // -------------------------------------------------------------- starting

  async function start(): Promise<void> {
    if (started) return;
    started = true;
    find('start').hidden = true;
    find('run-state').textContent = 'Loading…';
    banner('Loading Seattle street data…');
    try {
      const base = options.dataUrl.endsWith('/') ? options.dataUrl : `${options.dataUrl}/`;
      const [networkRes, profileRes] = await Promise.all([
        fetch(`${base}network.bin`),
        fetch(`${base}traffic_profile.json`),
      ]);
      if (!networkRes.ok || !profileRes.ok) throw new Error('the street data could not be loaded');
      const [network, profile] = await Promise.all([networkRes.arrayBuffer(), profileRes.json()]);
      map.setNetwork(RoadNetwork.fromBinary(network));
      banner('Building the day…');
      worker = options.createWorker
        ? options.createWorker()
        : new Worker(new URL('../live/worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<FromWorker>) => {
        const msg = event.data;
        if (msg.type === 'hello') onHello(msg);
        else if (msg.type === 'state') onState(msg);
        else if (msg.type === 'busy') banner('Building a new day…');
        else if (msg.type === 'error') banner(`Something went wrong: ${msg.message}`);
      };
      worker.onerror = (event) => banner(`Something went wrong: ${event.message}`);
      send({ type: 'init', network, profile, config: options.config });
      syncVisible();
    } catch (error) {
      started = false;
      find('start').hidden = false;
      find('run-state').textContent = 'Not started';
      banner(`Could not start: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Stop the clock and the drawing while nobody can see the widget.
  function syncVisible(): void {
    const visible = onScreen && !document.hidden;
    map.setActive(visible && started);
    send({ type: 'cmd', cmd: 'visible', on: visible });
  }
  const watcher = new IntersectionObserver((entries) => {
    onScreen = entries[entries.length - 1].isIntersecting;
    syncVisible();
  });
  watcher.observe(root);
  document.addEventListener('visibilitychange', syncVisible);
  undo.push(() => watcher.disconnect(), () => document.removeEventListener('visibilitychange', syncVisible));

  // Follow the page's theme: the map and charts read their colours from CSS.
  const themeWatcher = new MutationObserver(paintTheme);
  themeWatcher.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
  const scheme = matchMedia('(prefers-color-scheme: dark)');
  scheme.addEventListener('change', paintTheme);
  const onResize = (): void => charts.draw();
  addEventListener('resize', onResize);
  undo.push(
    () => themeWatcher.disconnect(),
    () => scheme.removeEventListener('change', paintTheme),
    () => removeEventListener('resize', onResize),
  );

  // -------------------------------------------------------------- controls

  find('start-button').onclick = () => void start();
  find('play').onclick = () => last && send({ type: 'cmd', cmd: 'play', on: !last.playing });
  find<HTMLSelectElement>('dispatcher').onchange = (e) =>
    send({ type: 'cmd', cmd: 'dispatcher', name: (e.target as HTMLSelectElement).value });
  find('zoom-in').onclick = () => map.zoomBy(1.6);
  find('zoom-out').onclick = () => map.zoomBy(1 / 1.6);
  find('zoom-fit').onclick = () => map.fit();
  find('toggle-table').onclick = (e) => {
    const button = e.currentTarget as HTMLButtonElement;
    const showTable = find('table').hidden;
    find('table').hidden = !showTable;
    find('charts').hidden = showTable;
    button.textContent = showTable ? 'Show as charts' : 'Show as table';
    button.setAttribute('aria-pressed', String(showTable));
    charts.draw();
  };
  find('restart').onclick = () => {
    const value = (name: string): string => find<HTMLInputElement>(name).value;
    send({
      type: 'cmd',
      cmd: 'restart',
      config: {
        nDrivers: value('f-drivers'),
        peakOrdersPerHour: value('f-orders'),
        startDay: value('f-day'),
        startHour: value('f-start'),
        trafficScale: value('f-traffic'),
        seed: value('f-seed'),
        deliveryRadiusM: Number(value('f-radius')) * 1000,
        dispatcher: value('dispatcher'),
      },
    });
  };

  if (options.autostart) void start();

  return {
    destroy(): void {
      worker?.terminate();
      worker = null;
      for (const f of undo) f();
      map.destroy();
      root.replaceChildren();
      root.classList.remove('sdl');
    },
  };
}
