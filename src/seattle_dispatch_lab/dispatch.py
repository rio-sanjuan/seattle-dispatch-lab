"""Dispatchers: the policies that decide which driver gets which order.

Every dispatcher sees the same `DispatchView`: the open orders, the free
drivers, and *estimates* of travel and food-prep times. It never sees the true
values the simulator will play out. It returns (driver, order) offers.

Three policies, in increasing sophistication:

  nearest       Each order, oldest first, grabs the closest free driver at once.
  matching      Every 30 s, look at all open orders and free drivers together
                and pick the set of pairs with the lowest total cost.
  matching_jit  Same, but holds an order back until a driver sent now would
                arrive roughly when the food is ready ("just in time").
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.optimize import linear_sum_assignment

# What the dispatcher assumes about steps it cannot observe in advance.
OFFER_REPLY_S = 15.0  # a driver takes about this long to answer an offer
PICKUP_OVERHEAD_S = 120.0  # park, walk in, collect the bag
DROPOFF_OVERHEAD_S = 105.0  # park, walk to the door, hand over


@dataclass
class DispatchView:
    """Everything a dispatcher may look at when deciding. All times in seconds."""

    now: float
    driver_ids: np.ndarray  # (D,)
    order_ids: np.ndarray  # (O,)
    pickup_drive: np.ndarray  # (O, D) est. drive from each driver to the restaurant
    dropoff_drive: np.ndarray  # (O,) est. drive restaurant -> customer
    placed: np.ndarray  # (O,) when the customer ordered
    est_ready: np.ndarray  # (O,) when we expect the food to be ready
    promised: np.ndarray  # (O,) the delivery time quoted to the customer
    declined: np.ndarray  # (O, D) True where this driver already said no


Offers = list[tuple[int, int]]  # (driver_id, order_id)


class NearestDriver:
    """Greedy baseline: first come, first served, closest free driver."""

    name = "nearest"
    label = "Nearest free driver"
    interval = 5.0  # seconds between decisions; small = effectively immediate

    def decide(self, v: DispatchView) -> Offers:
        offers: Offers = []
        taken = np.zeros(len(v.driver_ids), dtype=bool)
        for o in np.argsort(v.placed):
            drive = np.where(taken | v.declined[o], np.inf, v.pickup_drive[o])
            d = int(np.argmin(drive))
            if not np.isfinite(drive[d]):
                continue
            taken[d] = True
            offers.append((int(v.driver_ids[d]), int(v.order_ids[o])))
        return offers


class BatchedMatching:
    """Solve all open orders and free drivers together, once per cycle.

    Cost of giving order o to driver d (seconds, lower is better):

        time from now until delivery
      + w_late  * how far past the promised time it would land
      + w_drive * the drive to the restaurant
      - w_age   * how long the order has already been waiting

    The drive term breaks a tie the first term cannot see: while the food is
    still cooking, a driver 2 minutes away and one 10 minutes away deliver at
    the same time, but the far one burns 8 extra minutes of road.

    The age term matters when orders outnumber drivers: without it the solver
    would serve the easy new orders and starve the old ones.
    """

    name = "matching"
    label = "Batched matching"
    interval = 30.0
    w_late = 2.0
    w_drive = 0.5
    w_age = 1.5

    def costs(self, v: DispatchView) -> tuple[np.ndarray, np.ndarray]:
        at_counter = v.now + OFFER_REPLY_S + v.pickup_drive + PICKUP_OVERHEAD_S
        pickup = np.maximum(at_counter, v.est_ready[:, None])
        deliver = pickup + v.dropoff_drive[:, None] + DROPOFF_OVERHEAD_S
        cost = (
            (deliver - v.now)
            + self.w_late * np.maximum(0.0, deliver - v.promised[:, None])
            + self.w_drive * v.pickup_drive
            - self.w_age * (v.now - v.placed[:, None])
        )
        return cost, at_counter

    def eligible(self, v: DispatchView, at_counter: np.ndarray) -> np.ndarray:
        return np.ones(len(v.order_ids), dtype=bool)

    def decide(self, v: DispatchView) -> Offers:
        if len(v.order_ids) == 0 or len(v.driver_ids) == 0:
            return []
        cost, at_counter = self.costs(v)
        rows = np.flatnonzero(self.eligible(v, at_counter))
        if len(rows) == 0:
            return []
        blocked = v.declined[rows]
        sub = np.where(blocked, 1e9, cost[rows])
        r, c = linear_sum_assignment(sub)
        return [
            (int(v.driver_ids[d]), int(v.order_ids[rows[o]]))
            for o, d in zip(r, c)
            if not blocked[o, d]
        ]


class JustInTimeMatching(BatchedMatching):
    """Batched matching that waits when sending a driver now would be too early.

    An order joins the matching only once the closest free driver, sent right
    now, would reach the counter within `buffer` seconds of the food being
    ready. Until then the order stays in the pool and the driver stays free
    for orders that need one sooner. The buffer absorbs declines and bad
    estimates; shrink it and drivers wait less but food waits more.
    """

    name = "matching_jit"
    label = "Matching + just-in-time"
    buffer = 240.0

    def eligible(self, v: DispatchView, at_counter: np.ndarray) -> np.ndarray:
        soonest = np.where(v.declined, np.inf, at_counter).min(axis=1)
        return soonest + self.buffer >= v.est_ready


DISPATCHERS = {cls.name: cls for cls in (NearestDriver, BatchedMatching, JustInTimeMatching)}
