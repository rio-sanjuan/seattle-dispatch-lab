# Couriers on public transit

What happens to a delivery service if its couriers ride the bus? This page
covers the transit data, how a courier's trip is planned, and what the
simulator shows.

Short version: in this simulator a delivery by transit takes about
twice as much courier time as one by car (46 minutes against 22), so the same
number of couriers cannot keep up, and even with twice as many the food arrives
about 23 minutes later. Shrinking the delivery area helps but does not close
the gap. Every figure is from an invented demand model; see "What this leaves
out".

## Try it

```bash
uv run dispatch-lab setup-transit     # once: downloads the schedules (~36 MB), builds Friday's timetable
uv run dispatch-lab fleet --days 10   # car vs. half and half vs. transit, same ten days
uv run dispatch-lab serve --courier-mode mixed    # watch both kinds of courier on the map
```

`--courier-mode` is `car` (the default), `transit`, or `mixed`;
`--transit-share` sets the fraction of transit couriers in a mixed fleet;
`--delivery-radius-m` sets how far customers live from the restaurant. For
another weekday add `--start-day Sat` to both `setup-transit` and the run.

In the live view, transit couriers have a contrasting outline, the bus and rail
network is drawn as thin lines, and clicking a courier shows what they are
doing this minute ("Waiting at 3rd Ave & Pike St", "Riding E Line").

## The data

Schedules come from Sound Transit's Open Transit Data programme, which
publishes one combined file for every agency in the Puget Sound region: King
County Metro buses, Link light rail, Sounder, ST Express, the streetcars, the
water taxi and ferries, and the neighbouring counties' buses. The file is in
GTFS, the standard format agencies publish for trip planners.

`setup-transit` downloads it and keeps one service day, cut to the area the
street network covers:

| | Friday timetable |
|---|---:|
| Stops inside the area | 2,869 |
| Vehicle trips | 9,875 (8,833 bus, 820 light rail and streetcar, 188 other rail, 34 ferry) |
| Stop-to-stop hops | 260,310 |
| Service date used | 20 November 2026 |

The service date is the busiest of the next five Fridays in the feed at the
time of the build, so a holiday schedule does not get picked by accident.

What else exists but is not used here:

| Data | What it holds | Status |
|---|---|---|
| Live vehicle positions and trip delays | Where each vehicle is now, how late each trip is | Published by Metro and Sound Transit. Not used: the simulator assumes vehicles are on time. |
| Service alerts | Detours and disruptions | Published. Not used. |
| OneBusAway API | Arrival predictions per stop | Needs a free key from Sound Transit. Not used. |
| Past delays | How late each trip actually ran | Not published. It would have to be recorded from the live feed over time. |

### Terms

The schedule files are not stored in this repository; each user downloads their
own copy.

- **King County** asks that anything using its transit data carry this line:
  "Transit scheduling, geographic, and real-time data provided by permission of
  King County." The live view and the README carry it.
- **Sound Transit** provides the data "as is", with no guarantee that it is
  correct or current, and its terms apply to anyone the data is passed on to.
  Read them at
  [soundtransit.org/Open-Transit-Data](https://www.soundtransit.org/Open-Transit-Data)
  before redistributing the files or anything built from them.

### The combined file is being retired

Sound Transit has said it will stop publishing the combined regional file at
the end of 2026 and publish per-agency files only. When that happens, replace
the entry in `FEEDS` in [`transit.py`](../src/seattle_dispatch_lab/transit.py)
with the per-agency addresses. `build()` already accepts several files and
keeps their stop and trip names apart.

## How a transit trip is planned

A courier's trip is: walk to a stop, wait, ride, perhaps change, walk from a
stop. Or just walk, if that is faster.

- **Riding.** The planner uses the Connection Scan Algorithm. Take every
  stop-to-stop hop of the day, sorted by departure time. Sweep through them
  once from the courier's start time, keeping the earliest moment each stop can
  be reached; a hop is usable if the courier is already on that vehicle or can
  be at its stop before it leaves. One sweep answers "how soon can I be at
  every stop?" for one starting point. It takes under a tenth of a millisecond.
- **Walking.** Walks follow the street network (no freeways, both directions on
  one-way streets) at 1.3 m/s, about 4.7 km/h. A courier walks at most 25
  minutes to or from a stop.
- **Changing.** Stops within 250 m of each other are a walking transfer.
- **Which trip.** The one that arrives first. Nothing else is weighed: not the
  number of changes, not the fare, not how long the walk is.

A check against a trip that is easy to verify: Capitol Hill to the University
District comes out as a walk to the station, the 1 Line, and a walk
from the station, 13.6 minutes in all.

Across random pairs of points in the city, the median transit trip is
60 minutes and the median drive is 18, so transit takes about three times as
long. Most of that is walking and waiting.

## How the simulator uses it

- **Truth.** A transit courier follows the planned trip exactly. The timetable
  is treated as what really happens.
- **What the dispatcher sees.** For each free transit courier, the timetable
  time to every restaurant with an open order, and the timetable time from the
  restaurant to the customer. Car couriers keep their traffic-adjusted
  estimates. So with a mixed fleet the dispatcher can tell that a nearby
  transit courier may still be the slower choice.
- **The promise to the customer.** Quoted from car times when any cars are in
  the fleet, and from transit times when there are none.
- **Offers.** A transit courier tolerates a pickup trip twice as long as a
  driver does before becoming likely to decline.
- **Same world.** The orders, kitchens and courier shifts are identical across
  car, mixed and transit runs with the same seed. Only how couriers move
  changes.

## Results

Ten simulated Fridays, 10:00 to 22:00, the same ten days for every fleet, 220
couriers, the `matching_jit` dispatcher. "Transit ×2" has 440 couriers.
"Mixed" is half cars, half transit.

```bash
uv run dispatch-lab fleet --seed 1 --days 10
uv run dispatch-lab fleet --seed 1 --days 10 --delivery-radius-m 2000
```

### Customers up to 4.5 km from the restaurant

| | car | mixed | transit | transit ×2 |
|---|---:|---:|---:|---:|
| Average delivery time (min) | 26.9 | 36.8 | 60.9 | 49.8 |
| 90th percentile delivery time (min) | 36.8 | 54.3 | 85.6 | 68.7 |
| Due but never delivered (%) | 0.02 | 2.46 | 19.40 | 0.58 |
| Food age at the door (min) | 12.1 | 22.0 | 45.8 | 35.0 |
| Courier time used per delivery (min) | 22.2 | 29.3 | 46.2 | 47.3 |
| Trip to the restaurant (min) | 7.4 | 12.1 | 18.5 | 17.4 |
| Deliveries per courier-hour | 1.58 | 1.51 | 1.20 | 0.76 |
| Courier time spent on deliveries (%) | 59.1 | 74.8 | 93.7 | 61.2 |
| Orders delivered per day | 2,053 | 1,997 | 1,628 | 2,014 |

Difference from the car fleet on the same days, average delivery time: mixed
+9.9 ± 0.9 min, transit +34.0 ± 1.7, transit ×2 +22.9 ± 0.3 (mean ± 95%
interval).

### Customers up to 2 km from the restaurant

| | car | mixed | transit | transit ×2 |
|---|---:|---:|---:|---:|
| Average delivery time (min) | 22.7 | 29.6 | 47.2 | 38.0 |
| 90th percentile delivery time (min) | 31.6 | 43.9 | 65.9 | 50.9 |
| Due but never delivered (%) | 0.01 | 0.29 | 11.41 | 0.14 |
| Food age at the door (min) | 7.9 | 14.8 | 32.2 | 23.3 |
| Courier time used per delivery (min) | 17.7 | 24.6 | 37.8 | 36.0 |
| Trip to the restaurant (min) | 5.5 | 11.3 | 16.5 | 13.0 |
| Deliveries per courier-hour | 1.60 | 1.57 | 1.34 | 0.78 |
| Orders delivered per day | 2,057 | 2,047 | 1,801 | 2,035 |

Difference from the car fleet: mixed +6.9 ± 0.9 min, transit +24.5 ± 0.9,
transit ×2 +15.3 ± 0.5.

### Mixed fleet, by courier type

| | 4.5 km | 2 km |
|---|---:|---:|
| Deliveries made by transit couriers (%) | 29.2 | 26.6 |
| Average delivery time, car couriers (min) | 31.7 | 25.8 |
| Average delivery time, transit couriers (min) | 49.1 | 40.0 |
| Deliveries per hour on shift, car couriers | 2.18 | 2.33 |
| Deliveries per hour on shift, transit couriers | 0.86 | 0.82 |

### What the numbers say

- **A transit delivery uses about twice the courier time.** 46 minutes against
  22. That holds with 220 couriers or 440, so it is the trip itself and not a
  shortage.
- **The same fleet cannot keep up.** With 220 transit couriers, one due order in
  five is never delivered and couriers are busy 94% of the time. Two effects
  stack: the trip is slower (about +23 minutes, seen with the doubled fleet)
  and orders queue for a courier (about another 11 minutes).
- **Doubling the fleet fixes the queue, not the trip.** Almost every order is
  delivered again, at 50 minutes instead of 27, and each courier makes half as
  many deliveries per hour (0.76 against 1.58).
- **Getting to the restaurant is the expensive part.** A transit courier needs
  17 to 18 minutes to reach the restaurant, against 7 for a driver. The pool of
  couriers who can be at any one restaurant soon is much smaller.
- **A smaller delivery area helps transit more than cars, and not enough.**
  Going from 4.5 km to 2 km saves a car fleet 4 minutes and the doubled transit
  fleet 12. Transit at 2 km (38 minutes) is still slower than cars at 4.5 km
  (27 minutes).
- **In a mixed fleet the dispatcher leans on the cars.** Half the couriers are
  on transit but they make under 30% of the deliveries. Car couriers go from
  1.58 deliveries an hour to 2.18, and their own deliveries slow from 26.9 to
  31.7 minutes because they are stretched. Work becomes less even (Gini 0.27
  against 0.16).
- **Timing is harder to predict even with an exact timetable.** The travel
  estimate is off by 3.0 minutes for transit against 0.4 for cars. The
  timetable is not wrong; the kitchen is. Food that is ready a few minutes
  later than expected puts the courier on a later bus than the one the
  dispatcher counted on.

### Reading lateness

"Not delivered by the promised time" is not comparable across these fleets and
is left out of the tables. The promise is quoted from car times in the car and
mixed fleets and from timetable times in the transit fleets, so each fleet is
graded against a different promise. For the record: at 4.5 km it is 7.3% (car),
42.5% (mixed), 71.1% (transit) and 38.7% (transit ×2).

"Distance per delivery" is also left out: for transit it is measured along
straight lines between stops.

## What this leaves out

- **Vehicles are never late.** Real buses are, and a missed connection costs a
  whole headway. Transit would look worse with real delays; rail less so.
- **A courier is never refused boarding and never waits for a full bus.**
- **Food gets cold.** The simulator does not model food quality, only how long
  the food has been out of the kitchen ("food age at the door").
- **Cost is not modelled.** A transit courier has no car, fuel or parking to pay
  for, and a fare to pay. Whether a slower, cheaper courier is worth it is the
  real business question, and it needs a pay and cost model this project does
  not have.
- **No bikes, scooters or walking-only couriers**, which is what a real
  car-free fleet in a dense area mostly uses.
- **One day's timetable.** Every simulated day uses the same Friday schedule;
  the days differ in their orders, kitchens and courier shifts.
- **Walk and ride legs are drawn as straight lines on the map.** Travel times
  use the street network and the timetable; only the drawing is simplified.
