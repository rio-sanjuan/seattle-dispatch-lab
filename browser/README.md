# Seattle Dispatch Lab in the browser

The simulator, ported to TypeScript, running entirely in the visitor's browser.
No server: the page downloads the street network once (1.4 MB, about 0.9 MB
compressed) and simulates the day in a Web Worker. The map is drawn on a canvas
from that same street data, so the page asks no other site for anything.

It does what the Python live view (`dispatch-lab serve`) does: play, pause,
change speed, switch dispatcher mid-day, click a driver to follow them, and
restart the day with other settings. It also has three things the Python view
does not:

- **Full report.** All 21 end-of-run metrics for the day so far, updated each
  second.
- **Compare dispatchers.** Runs the day on screen from start to finish under
  each of the three dispatchers, with the same orders, kitchens, driver shifts
  and driver decisions, and shows the results side by side. It takes a couple
  of seconds. It is one day, so it shows the method (same day, only the
  dispatcher differs), not how sure to be: that needs many days, which the
  Python `compare` command does.
- **A link to the scenario.** The settings travel in the address
  (`?seed=7&day=Fri&start=10&drivers=220&orders=400&traffic=1&radius=4.5&dispatcher=matching_jit`).
  Unknown or out-of-range values fall back to the defaults.

## Run it

Needs Node 22 or newer, and the street data from the Python side.

```bash
uv run dispatch-lab setup            # once, in the repo root: downloads Seattle's streets
uv run dispatch-lab export-browser   # writes browser/public/data/
cd browser
npm install
npm run dev                          # http://localhost:8766
```

- `http://localhost:8766/` is the map filling the page. Its address follows
  the scenario, so the address bar is always a link to what is running.
- `http://localhost:8766/embed.html` is the widget inside an article column,
  with a theme switch, to see how it behaves on a blog page.

`npm run build` writes a static copy of both pages to `dist/`.

## How it is checked against the Python simulator

The port is only useful if it behaves like the original, so the tests replay
days that Python built and ran:

1. `scripts/export_browser_fixtures.py` builds a day in Python, records the
   world (restaurants, orders, driver shifts), every random draw the drivers
   made (how long to answer an offer, whether to accept), and the results.
2. `test/parity.test.ts` loads that world into the TypeScript simulator, feeds
   it the same draws, and requires the same outcome: every order delivered by
   the same driver at the same time (to a millionth of a second), the same
   five-minute samples, and all 21 end-of-run metrics.

This runs for all three dispatchers on a made-up 12 × 12 grid (fixtures
committed, no download) and on a full Friday in Seattle (fixtures written
locally, skipped if absent).

```bash
npm test                                           # 30 tests
uv run python scripts/export_browser_fixtures.py   # after changing the Python simulator
```

If a parity test fails after a Python change, the port has fallen behind:
update the matching file in `src/sim/` until it passes again.

`test/controller.test.ts` also checks the comparison: re-running the day on
screen under its own dispatcher gives exactly the result the live run reaches.

Two things are not identical by design:

- **Days built in the browser are different days.** The browser has its own
  random-number generator, so seed 7 here is not seed 7 in Python. The
  distributions are the same; `test/world.test.ts` checks that two
  browser-built Fridays land near the Python ten-day averages.
- **Road shapes are simplified** to within 1.5 m and stored at about 0.3 m
  precision. Travel times and lengths are stored exactly, so routes and
  timings are unaffected; only the drawn line differs.

## What is not ported

- Couriers on public transit. The planner would need the bus and rail timetable
  shipped to every visitor, which means redistributing Sound Transit's data;
  see [docs/transit.md](../docs/transit.md) for the terms.
- The multi-day experiments (`compare`, `sweep`, `information`, `fleet`) with
  their paired differences and intervals, and the "true drive times" switch
  they use. A 12-hour day runs in under a second here, so they could be added.

## Layout

```
src/sim/      the simulator: no DOM, runs in Node and in a worker
  network.ts    street network, shortest paths, routes
  traffic.ts    slowdown by road type and time of week
  assignment.ts the solver behind batched matching (same method as scipy's)
  dispatch.ts   the three dispatchers
  sim.ts        the world and its event loop
  metrics.ts    every end-of-run metric
src/live/     runs one simulation at a chosen speed
  controller.ts what server.py does, without the server
  share.ts      a scenario's settings as a web address
  worker.ts     the Web Worker around it
  protocol.ts   the messages between page and worker
src/ui/       the page: canvas map, charts, results sheet, controls, styles
test/         parity with Python, plus unit tests
```

## Putting it on another site

The widget is one function and one stylesheet, with no dependencies:

```ts
import { mountDispatchLab } from './dispatch-lab/index';
import './dispatch-lab/ui/dispatch-lab.css';

const lab = mountDispatchLab(document.querySelector('#lab')!, {
  dataUrl: '/dispatch-lab/', // folder holding network.bin and traffic_profile.json
});
// later, when the page goes away: lab.destroy();
```

What a host site needs to do:

1. **Copy `src/`** into the site's source (the files import each other with
   relative paths). The worker is started with
   `new Worker(new URL('../live/worker.ts', import.meta.url), { type: 'module' })`,
   which Vite-based tools (Astro included) bundle without configuration. For
   other bundlers pass `createWorker`.
2. **Serve the two data files** from `public/data/` at the `dataUrl` you pass.
3. **Match the theme.** All colours and the font are CSS variables on `.sdl`
   (`--sdl-surface`, `--sdl-ink`, `--sdl-border`, `--sdl-font`, and so on; the
   full list is at the top of `ui/dispatch-lab.css`). Light is the default;
   dark applies under `:root[data-theme="dark"]` or a dark system setting
   unless `data-theme="light"` is set. The map and charts re-read the
   variables when `data-theme`, `class` or `style` changes on `<html>`.
4. **Credit the street data** on the page: "© OpenStreetMap contributors". The
   widget's own footer already does; keep it visible.

Two options decide how links behave:

- `urlState: true` is for a page that *is* the simulator. It reads the
  scenario from the page's address on load and rewrites the address (without
  adding history entries) whenever the scenario or dispatcher changes.
- `shareUrl` is the page a copied link should open. An article that embeds the
  widget leaves `urlState` off, so its own address is never touched, and sets
  `shareUrl` to the full simulator page.

A link reopens the same settings. In the same browser that is the same day;
another browser's maths can round differently in rare cases, and then the day
can differ. This has not been tested across browsers.

Behaviour worth knowing when it sits in an article:

- Nothing is downloaded until the visitor presses Start (`autostart: true`
  changes that).
- A plain scroll moves the page. The map zooms with its buttons, a pinch, a
  double-click, or ctrl/cmd + scroll (`wheelZoom: 'always'` changes that).
- The clock and the drawing stop while the widget is off screen or the tab is
  hidden, and pick up where they left off.
- Below 860 px of width the panel moves under the map.
- On sites that swap pages without a reload, call `destroy()` before the swap;
  it stops the worker and removes every listener.

## Data and licence

`public/data/network.bin` is derived from OpenStreetMap (© OpenStreetMap
contributors, ODbL) and is not committed here. A site that publishes it is
distributing a database derived from OpenStreetMap: credit it, and offer the
file under the ODbL. `traffic_profile.json` is derived from the UW STAR Lab /
WSDOT loop-detector dataset (CC-BY-4.0). The code is MIT, like the rest of the
repository.
