# Seattle Dispatch Lab

A food-delivery dispatcher you can watch and tinker with. Simulated drivers,
customers and restaurants run on Seattle's real street network, slowed down by
real freeway traffic patterns, while a dispatcher decides which driver gets
which order.

It is a learning project for understanding how dispatch systems work. It is not
affiliated with any delivery company and uses no company's data.

![Live view: drivers and orders on a map of Seattle, with live metrics](docs/live-view.jpg)

## Quick start

Needs [uv](https://docs.astral.sh/uv/) and Python 3.12+.

```bash
uv run dispatch-lab setup      # once: downloads Seattle's streets from OpenStreetMap (~4 min)
uv run dispatch-lab serve      # then open http://127.0.0.1:8765
uv run dispatch-lab compare    # all three dispatchers on the same 10 days, with confidence intervals
uv run dispatch-lab sweep      # trade delivery speed against driver time
uv run dispatch-lab information   # what would perfect estimates be worth?
uv run dispatch-lab setup-transit # optional: downloads bus and rail schedules (~36 MB)
uv run dispatch-lab fleet      # couriers by car vs. public transit vs. half and half
uv run pytest                  # tests use a small made-up grid; no download needed
```

In the live view you can pause, change speed (up to 300 simulated seconds per
second), switch dispatcher mid-day, click a driver to follow them, and restart
the day with more drivers, more orders, a different weekday, or more traffic.

## The three dispatchers

All three live in [`dispatch.py`](src/seattle_dispatch_lab/dispatch.py) and are
short enough to read in one sitting.

| Name | What it does |
|---|---|
| `nearest` | Each order, oldest first, immediately takes the closest free driver. |
| `matching` | Every 30 seconds, looks at all open orders and free drivers together and picks the set of pairs with the lowest total cost. |
| `matching_jit` | Same, but holds an order back until a driver sent now would arrive about when the food is ready. |

Ten simulated Fridays, 10:00 to 22:00, the same ten days for each dispatcher
(`uv run dispatch-lab compare --seed 1 --days 10`):

| | nearest | matching | matching_jit |
|---|---:|---:|---:|
| Average delivery time (min) | 30.7 | 26.3 | 26.9 |
| Not delivered by the promised time (%) | 27.6 | 6.8 | 7.3 |
| Driver time used per delivery (min) | 25.8 | 24.5 | 22.2 |
| Driver waits at restaurant (min) | 5.5 | 7.1 | 4.1 |

Two things worth noticing:

- **Matching beats greedy by looking at everyone at once.** Greedy hands the
  closest driver to whichever order asked first, even when a later order needed
  that driver far more. Day for day, greedy is 4.4 ± 1.8 minutes slower.
- **Just-in-time is a trade, not a free win.** It saves 2.3 ± 0.3 driver-minutes
  per delivery, and deliveries get 0.7 ± 0.1 minutes slower, because a late
  decision leaves less room for a declined offer or a wrong estimate.

## Evaluation

[docs/metrics.md](docs/metrics.md) defines every metric, what it rewards and
what it misses, and how policies are compared: the same simulated days for each
policy, per-day paired differences, and 95% intervals. The numbers behind it
are in [results/](results), written by `scripts/export_results.py`.

## Couriers on public transit

An optional experiment: what if couriers rode the bus? With Seattle's real
bus, rail and ferry timetable, a delivery by transit uses about twice the
courier time of one by car (46 minutes against 22). The same number of couriers
cannot keep up, and with twice as many the food still arrives about 23 minutes
later. [docs/transit.md](docs/transit.md) has the data sources and terms, how
trips are planned, the results and what the model leaves out.

## How the simulation works

- **Events, not frames.** Everything that will happen at a known time (an order
  is placed, a driver arrives, the dispatcher wakes up) sits in a priority
  queue. Driver positions between events are interpolated along their route.
  Twelve simulated hours run in about 7 seconds.
- **The dispatcher only gets estimates.** It sees expected food-ready times and
  estimated drive times. The simulator separately decides the truth: how long
  the kitchen really took, the real route under current traffic, and whether a
  driver declines the offer (more likely for long pickups).
- **Same world for every dispatcher.** For a given seed the orders, kitchens and
  driver shifts are identical, so differences in the results come from the
  dispatcher.

## What is real and what is made up

| | Source |
|---|---|
| Streets and speed limits | Real. OpenStreetMap, Seattle city limits. |
| Freeway traffic (I-5, I-90, SR-520) | Real. Typical week from 2015 road-sensor data, by direction, in 15-minute steps. |
| Traffic on other freeways (SR-99 etc.) | Assumed: the average of the measured freeways. |
| Traffic on city streets | Assumed: a damped copy of the freeway pattern. No public sensor data covers them. |
| Speeds on an empty city street | Assumed: 62% of the limit on main streets, 50% on side streets, to account for signals and turns. |
| Restaurant locations | Real food-venue locations from OpenStreetMap. Names, menus, prep times and popularity are made up. |
| Bus, rail and ferry schedules (optional) | Real. Published timetables for one Friday. Vehicles are assumed to run exactly on time. |
| Customers | Made up. Placed on residential streets within 4.5 km of the restaurant. |
| Orders, drivers, shifts, declines | Made up. Lunch and dinner peaks, a few busy restaurants, drivers who decline far pickups. |

Because so much of the demand side is invented, the absolute numbers mean
little. The comparisons between dispatchers on the same world are the useful
part.

## Layout

```
src/seattle_dispatch_lab/
  network.py    street network: build from OpenStreetMap, fast routing
  traffic.py    slowdown by road type and time of week
  sim.py        the simulated world and its event loop
  dispatch.py   the three dispatchers
  transit.py    bus and rail timetable, and a trip planner for couriers without a car
  metrics.py    every evaluation metric, defined once
  experiments.py  many-day runs, paired differences, confidence intervals
  server.py     streams the running simulation to the browser
  web/          the live map (plain HTML and JavaScript, no build step)
  cli.py        setup / run / compare / sweep / information / fleet / serve
scripts/
  build_traffic_profile.py   turns the 274 MB sensor dataset into data/traffic_profile.json
  collect_wsdot.py           records live WSDOT travel times (not used by the simulator yet)
  export_results.py          runs the evaluation experiments, writes results/
```

## Ideas to try next

- Let one driver carry two orders from nearby restaurants.
- Offer a driver their next order before they finish the current one.
- Replace the drive-time estimate with a model trained on the simulator's own
  history, and see how much dispatch improves.
- Move idle drivers toward where orders are about to appear.
- Use `collect_wsdot.py` snapshots to run on today's traffic.

## Data credits

- Street network and venue locations © [OpenStreetMap](https://www.openstreetmap.org/copyright)
  contributors (ODbL), fetched with [OSMnx](https://github.com/gboeing/osmnx).
  Downloaded by `setup`; not stored in this repository.
- Freeway speeds: *Freeway Inductive Loop Detector Dataset for Network-wide
  Traffic Speed Prediction*, UW STAR Lab with data from WSDOT,
  [zenodo.org/records/3258904](https://zenodo.org/records/3258904), CC-BY-4.0.
  `data/traffic_profile.json` is derived from it.
- Map tiles in the live view: [OpenFreeMap](https://openfreemap.org).
- Transit schedules (only if you run `setup-transit`; not stored in this
  repository): Sound Transit's Open Transit Data feed, which combines King
  County Metro, Sound Transit and the other Puget Sound agencies. Transit
  scheduling, geographic, and real-time data provided by permission of King
  County. See [docs/transit.md](docs/transit.md) for the terms.

## License

Code: [MIT](LICENSE). `data/traffic_profile.json` is derived from the CC-BY-4.0
dataset credited above and stays under that license.
