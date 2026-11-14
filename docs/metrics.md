# Evaluating a dispatcher: metrics and method

Reference for every number the simulator reports: what it is, what it rewards,
what it misses, and how policies are compared. The code is in
[`metrics.py`](../src/seattle_dispatch_lab/metrics.py) and
[`experiments.py`](../src/seattle_dispatch_lab/experiments.py); the numbers
quoted here are in [`results/`](../results).

## Reproducing the results

```bash
uv run dispatch-lab setup                      # once
uv run python scripts/export_results.py        # ~4 min, writes results/days.csv and results/summary.json
uv run dispatch-lab compare --seed 1 --days 10       # the dispatcher table
uv run dispatch-lab sweep --seed 1 --days 10         # speed vs. driver time
uv run dispatch-lab information --seed 1 --days 10   # perfect-estimate test
```

`results/summary.json` records the commit, seeds and configuration it was
produced from. All results use ten simulated Fridays, 10:00 to 22:00, seeds 1
to 10, unless stated.

## Timeline of one order

```
placed ── assigned ── driver at restaurant ── picked up ── delivered
   │                         food ready ──────┘                │
   └── promised time (quoted when the order is placed) ────────┘
```

`ready` is when the kitchen really finishes; the dispatcher only knows the
restaurant's average prep time (`est_ready`). `promised` is
`est_ready + estimated drive + 105 s handover + 10 min slack`.

## Two cohorts

| Cohort | Which orders | Used for | Why |
|---|---|---|---|
| delivered | Reached the customer | Times and distances | They can only be measured on finished orders. |
| due | Promised time fell inside the run, delivered or not | Lateness and fulfilment | An order a policy never delivers must count against it. On delivered orders alone, a policy that abandons its hardest orders looks better than it is. |

## Metrics

"Better" is the direction used for verdicts. A blank means neither direction is
simply good.

### Customer

| Metric | Formula | Better | Rewards | Misses |
|---|---|---|---|---|
| Average delivery time | mean of `delivered − placed`, delivered cohort | low | Overall speed. | The worst orders; abandoned orders; whether the customer was told the truth. |
| 90th percentile delivery time | p90 of `delivered − placed` | low | The slow tail. | Same blind spots as the average. |
| Not delivered by the promised time | share of due orders with `delivered > promised` (never delivered counts) | low | Keeping the promise. | How late. It also depends on how generous the promise is: with 10 minutes of slack, on-time orders arrive about 8 minutes early. |
| 20+ min past the promised time | share of orders due 20+ min before the end with `delivered > promised + 20 min` | low | Avoiding the failures customers remember. | Rare, so it is noisy from day to day. |
| Due but never delivered | share of due orders not delivered when the run ends | low | Finishing what was accepted. | Customers do not cancel in this simulator, so abandoned orders just wait. |
| Food waits for a driver | mean of `picked_up − ready` | low | Hot food. | In this simulator it equals the "extra delivery time" used in the literature (below). |
| Food age at the door | mean of `delivered − ready` | low | Food quality on arrival. | Mostly distance once the driver has the bag. |
| Arrival vs. promise | mean of `delivered − promised` (negative = early) | – | Shows the bias of the promise. | Early and late cancel out in a mean. |

### Courier

| Metric | Formula | Better | Rewards | Misses |
|---|---|---|---|---|
| Driver time used per delivery | mean of `delivered − assigned` | low | Efficient use of drivers: it is the supply each order consumes. | Idle time between orders. |
| Drive to restaurant | mean true drive, driver → restaurant | low | Picking nearby drivers. | Whether the driver then stands and waits. |
| Driver waits at restaurant | mean of `max(0, ready − arrived)` | low | Not sending drivers too early. | Sending them too late (that is food wait). |
| Distance driven per delivery | total km ÷ deliveries | low | Fuel and road time. | – |
| Deliveries per driver-hour | deliveries ÷ on-shift driver hours | high | Throughput per unit of supply. | Capped by demand: with spare drivers it barely moves whatever the policy. |
| Unevenness of work (Gini) | Gini coefficient of deliveries per on-shift hour, drivers with 1+ hour | low | Spreading work evenly. 0 = identical rates, 1 = one driver gets everything. | Pay. There is no pay model, so this is work, not earnings. |
| Offers declined | declines ÷ offers | low | Offers drivers want. | Declines here depend only on pickup distance. |

### Marketplace

| Metric | Formula | Better | Rewards | Misses |
|---|---|---|---|---|
| Orders delivered | count | high | Volume. | – |
| Order waits for a driver | mean of `assigned − placed` | – | – | Waiting can be deliberate (just-in-time), so shorter is not better. |
| Driver time spent on deliveries | busy time ÷ on-shift time | – | – | Counts standing at a restaurant as busy. Low can mean spare capacity (good) or idle drivers (bad). |
| Time with more waiting orders than free drivers | share of 5-minute samples with `waiting orders > free drivers` | low | Keeping slack in the system. | Coarse sampling. |

### Estimates

| Metric | Formula | Better | Notes |
|---|---|---|---|
| Drive-time estimate error | mean of `|estimated − true|` drive time per order | low | Changes slightly with policy because policies choose different drives. |
| Food-ready estimate error | mean of `|ready − est_ready|` | – | A property of the kitchens, identical for every policy. |

## Metrics from the literature that need more modelling

| Metric | Used by | What it needs here |
|---|---|---|
| Extra delivery time: actual minus shortest possible (prep + direct drive) | FoodMatch (Swiggy data) | Nothing, but with one order per driver it is exactly "food waits for a driver". It becomes distinct once a driver carries several orders. |
| Cancellation rate | DoorDash, Uber | A rule for customers giving up while they wait. |
| Cost per order; driver earnings; earnings fairness | Reyes et al.; Work4Food | A pay model (per-order pay plus an hourly floor). |
| Batch rate; orders carried per km | DoorDash; FoodMatch | Drivers carrying more than one order. |
| Gap to a hindsight-optimal plan | Yildiz and Savelsbergh | An offline solver that knows every order in advance; practical only on small instances. |
| Switchback vs. A/B experiment bias | DoorDash, Lyft | Switching policy by time window and by order inside one run. |

## How policies are compared

1. **Same days for every policy.** A seed fixes the orders, kitchens and driver
   shifts. Only the dispatcher's decisions (and the declines they trigger)
   differ. In simulation this is called common random numbers.
2. **Many days.** One day is one sample. Across ten days the nearest-driver
   late rate ranged from 15% to 48%.
3. **Paired differences.** For each day, take policy A minus policy B, then
   report the mean of those differences with a 95% Student-t interval. The
   noise both policies share cancels. Example: matching_jit minus matching on
   average delivery time is +0.66 ± 0.13 min, although each policy's own
   average varies between days with a standard deviation of about 0.7 min.
4. **Verdict.** "better" or "worse" when the interval excludes zero, otherwise
   "no clear difference". A clear difference can still be too small to matter
   (deliveries per driver-hour: +0.006).

### Goals and guardrails

A single table of twenty metrics does not say whether a change is good.
Companies name one or two **goal** metrics a change is meant to move and a set
of **guardrail** metrics it must not harm.

Worked example: holding orders back (matching_jit) to save driver time.

| | Role | 240 s buffer | 480 s buffer |
|---|---|---|---|
| Driver time used per delivery (min) | goal | −2.31 ± 0.26 better | −1.03 ± 0.15 better |
| Average delivery time (min) | guardrail | +0.66 ± 0.13 worse | +0.07 ± 0.08 no clear difference |
| Not delivered by the promised time (%) | guardrail | +0.53 ± 0.47 worse | −0.05 ± 0.29 no clear difference |
| 20+ min past the promised time (%) | guardrail | −0.01 ± 0.05 no clear difference | +0.01 ± 0.06 no clear difference |

Differences are from plain matching. The 240-second buffer buys more driver
time but breaks two guardrails; the 480-second buffer buys one driver-minute
per delivery with no measurable harm.

## Results so far

### Dispatchers (normal demand, 400 orders/hour at peak)

| | nearest | matching | matching_jit |
|---|---:|---:|---:|
| Average delivery time (min) | 30.7 | 26.3 | 26.9 |
| Not delivered by the promised time (%) | 27.6 | 6.8 | 7.3 |
| 20+ min past the promised time (%) | 2.5 | 0.2 | 0.2 |
| Driver time used per delivery (min) | 25.8 | 24.5 | 22.2 |
| Driver waits at restaurant (min) | 5.5 | 7.1 | 4.1 |
| Unevenness of work (Gini) | 0.153 | 0.155 | 0.164 |

Nearest minus matching: delivery time +4.41 ± 1.76 min, late rate +20.8 ± 7.2
points. Its severe-late rate (+2.3 ± 3.2 points) is not clearly different,
because it is driven by a few bad days.

### Dispatchers (busy demand, 520 orders/hour at peak)

| | nearest | matching | matching_jit |
|---|---:|---:|---:|
| Average delivery time (min) | 44.4 | 28.9 | 29.4 |
| Not delivered by the promised time (%) | 55.5 | 12.1 | 13.3 |
| 20+ min past the promised time (%) | 34.8 | 1.4 | 1.5 |
| Due but never delivered (%) | 9.2 | 0.2 | 0.2 |
| Driver time used per delivery (min) | 26.3 | 23.0 | 21.7 |

With 30% more orders the nearest-driver policy collapses, and every difference
from matching is clear (delivery time +15.6 ± 1.3 min, severe lateness +33.3 ±
2.3 points). Its 44.4-minute average is also flattering: it leaves out the 9.2%
of due orders that were never delivered. This is the case the due cohort exists
for.

### Speed against driver time (just-in-time buffer)

The buffer is how early matching_jit will send a driver. Small buffers hold
orders longer.

| Buffer | Average delivery time (min) | Driver time per delivery (min) | Driver waits at restaurant (min) | Food waits for a driver (min) |
|---|---:|---:|---:|---:|
| 0 s | 28.6 | 20.9 | 2.2 | 3.9 |
| 60 s | 28.0 | 21.1 | 2.7 | 3.3 |
| 120 s | 27.6 | 21.5 | 3.1 | 2.9 |
| 240 s | 26.9 | 22.2 | 4.1 | 2.2 |
| 480 s | 26.3 | 23.5 | 5.9 | 1.6 |
| 900 s | 26.2 | 24.5 | 7.0 | 1.6 |
| no hold (matching) | 26.3 | 24.5 | 7.1 | 1.6 |

Each step trades about a minute of customer time for a minute of driver time,
until about 480 seconds, beyond which more buffer only adds driver waiting.
Holding orders also makes work slightly less even across drivers (Gini 0.155
with no hold, 0.175 at 0 s).

### What perfect estimates would be worth (matching_jit)

| The dispatcher is told | Average delivery time (min) | Driver time per delivery (min) |
|---|---:|---:|
| Estimates (baseline) | 26.9 | 22.2 |
| True food-ready times | −0.88 ± 0.10 | −1.17 ± 0.11 |
| True drive times | −0.07 ± 0.06 | −0.08 ± 0.05 |
| Both | −0.96 ± 0.11 | −1.28 ± 0.11 |

Knowing when the food will be ready is worth about ten times more than knowing
drive times exactly. That follows from the size of the errors: the food-ready
estimate is off by 4.1 minutes on average, the drive estimate by 0.4.

## Caveats

- **The drive-time estimate is unrealistically good.** It uses the same road
  network as the truth and is only wrong about which roads are congested. A
  real estimate is worse, so the drive-time row above understates its value.
- **Demand is invented.** Absolute numbers mean little; differences between
  policies on the same days are the useful part.
- **Lateness depends on the promise.** The promise is set by a fixed rule with
  10 minutes of slack. A different rule moves every lateness number.
- **Ten days is a small sample for rare events.** Severe lateness and unfulfilled
  orders have wide intervals.
- **One day type.** Every run is a Friday with the same demand shape.

## Sources

Collected in a research pass on 2026-11-10 and not all re-read; check a source
before quoting it. "Snippet" marks ones seen only as an abstract or search
result.

- Reyes, Erera, Savelsbergh et al., *The Meal Delivery Routing Problem*
  (Grubhub data): click-to-door, ready-to-door, courier pay, cost per order,
  distribution reporting.
  <https://optimization-online.org/wp-content/uploads/2018/04/6571.pdf>
- Yildiz and Savelsbergh, perfect-information meal delivery as a benchmark.
  <https://optimization-online.org/wp-content/uploads/2018/05/6624.pdf>
- *FoodMatch* (Swiggy data): extra delivery time, orders per km,
  decision-window overruns. <https://arxiv.org/abs/2008.12905>
- *Work4Food*: Gini of courier income per hour.
  <https://arxiv.org/abs/2205.03530>
- DoorDash reinforcement-learning dispatch paper: goal and guardrail metrics,
  20-minute lateness, courier active time. <https://arxiv.org/html/2606.13604>
- DoorDash engineering: batch rate vs. cost
  (<https://careersatdoordash.com/?p=16159>), switchback experiments
  (<https://careersatdoordash.com/?p=78>), choosing the randomisation unit
  (<https://careersatdoordash.com/?p=6696>), variance reduction
  (<https://careersatdoordash.com/?p=1650>).
- Lyft engineering, *Experimentation in a Ridesharing Marketplace*.
  <https://eng.lyft.com/experimentation-in-a-ridesharing-marketplace-b39db027a66e>
- Qin, Zhu, Ye, ride-hailing reinforcement-learning survey: response and
  fulfilment rates. <https://arxiv.org/abs/2105.01099>
- Georgia Tech simulation course notes on comparing systems with common random
  numbers (snippet).
  <https://www2.isye.gatech.edu/~sman/courses/6644/Module10-ComparingSystems-201128.pdf>
- Uber DeeprETA, asymmetric ETA error (snippet). <https://arxiv.org/pdf/2206.02127>
