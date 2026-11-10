"""Evaluation metrics: every end-of-run number is defined here, once.

`METRICS` is the registry (label, who it serves, which direction is better);
`summarize(sim)` computes them. docs/metrics.md explains what each one rewards
and what it misses.

Two cohorts are used on purpose:

  delivered   orders that reached the customer. Times and distances can only be
              measured on these, so a policy that abandons its hardest orders
              looks better here than it is.
  due         orders whose promised time fell inside the run, delivered or not.
              Lateness and fulfilment are measured on these, so an abandoned
              order counts against the policy instead of vanishing.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

import numpy as np

if TYPE_CHECKING:
    from .sim import Simulation

SEVERE_LATE_S = 20 * 60
MIN_SHIFT_H_FOR_FAIRNESS = 1.0


@dataclass(frozen=True)
class Metric:
    key: str
    label: str
    group: str
    better: str  # "low", "high", or "" when neither direction is simply good
    digits: int = 1


METRICS = [
    Metric("avg_delivery_min", "Average delivery time (min)", "Customer", "low"),
    Metric("p90_delivery_min", "90th percentile delivery time (min)", "Customer", "low"),
    Metric("late_pct", "Not delivered by the promised time (%)", "Customer", "low"),
    Metric("severe_late_pct", "20+ min past the promised time (%)", "Customer", "low"),
    Metric("unfulfilled_pct", "Due but never delivered (%)", "Customer", "low", 2),
    Metric("food_wait_min", "Food waits for a driver (min)", "Customer", "low"),
    Metric("ready_to_door_min", "Food age at the door (min)", "Customer", "low"),
    Metric("promise_bias_min", "Arrival vs. promise (min, negative = early)", "Customer", ""),
    Metric("active_min_per_delivery", "Driver time used per delivery (min)", "Courier", "low"),
    Metric("pickup_drive_min", "Drive to restaurant (min)", "Courier", "low"),
    Metric("driver_wait_min", "Driver waits at restaurant (min)", "Courier", "low"),
    Metric("km_per_delivery", "Distance driven per delivery (km)", "Courier", "low"),
    Metric("deliveries_per_driver_hour", "Deliveries per driver-hour", "Courier", "high", 2),
    Metric("driver_gini", "Unevenness of work across drivers (Gini, 0-1)", "Courier", "low", 3),
    Metric("decline_pct", "Offers declined (%)", "Courier", "low"),
    Metric("delivered", "Orders delivered", "Marketplace", "high", 0),
    Metric("wait_for_assign_min", "Order waits for a driver (min)", "Marketplace", ""),
    Metric("utilization_pct", "Driver time spent on deliveries (%)", "Marketplace", ""),
    Metric("undersupplied_pct", "Time with more waiting orders than free drivers (%)", "Marketplace", "low"),
    Metric("eta_error_min", "Drive-time estimate error (min)", "Estimates", "low"),
    Metric("prep_error_min", "Food-ready estimate error (min)", "Estimates", ""),
]  # fmt: skip
GROUPS = list(dict.fromkeys(m.group for m in METRICS))
BY_KEY = {m.key: m for m in METRICS}


def gini(values: np.ndarray) -> float:
    """0 = everyone gets the same, 1 = one person gets everything."""
    x = np.sort(np.asarray(values, dtype=np.float64))
    if len(x) == 0 or x.sum() == 0:
        return 0.0
    n = len(x)
    return float(2 * (np.arange(1, n + 1) * x).sum() / (n * x.sum()) - (n + 1) / n)


def summarize(sim: Simulation) -> dict:
    from .sim import IDLE, TO_RESTAURANT

    nan = float("nan")
    end = sim.now
    done = sim.done
    everyone = done + list(sim.active.values())
    out: dict = {
        "dispatcher": sim.dispatcher.name,
        "seed": sim.cfg.seed,
        "placed": sim.n_placed,
        "delivered": len(done),
        "offers": sim.n_offers,
        "declines": sim.n_declines,
        "decline_pct": 100 * sim.n_declines / sim.n_offers if sim.n_offers else 0.0,
    }

    # ---- due cohort: lateness and fulfilment, abandoned orders included
    promised = np.array([o.promised for o in everyone])
    arrived = np.array([o.delivered for o in everyone])  # NaN if never delivered
    arrived = np.where(np.isnan(arrived), np.inf, arrived)
    due = promised <= end
    severe_due = promised + SEVERE_LATE_S <= end
    out["late_pct"] = float((arrived[due] > promised[due]).mean() * 100) if due.any() else nan
    out["severe_late_pct"] = (
        float((arrived[severe_due] > promised[severe_due] + SEVERE_LATE_S).mean() * 100)
        if severe_due.any()
        else nan
    )
    out["unfulfilled_pct"] = float(np.isinf(arrived[due]).mean() * 100) if due.any() else nan

    # ---- delivered cohort: times and distances
    def col(f) -> np.ndarray:
        return np.array([f(o) for o in done], dtype=np.float64)

    if done:
        total = col(lambda o: o.delivered - o.placed) / 60
        out.update(
            avg_delivery_min=float(total.mean()),
            p90_delivery_min=float(np.percentile(total, 90)),
            food_wait_min=float(col(lambda o: o.picked_up - o.ready).mean() / 60),
            ready_to_door_min=float(col(lambda o: o.delivered - o.ready).mean() / 60),
            promise_bias_min=float(col(lambda o: o.delivered - o.promised).mean() / 60),
            active_min_per_delivery=float(col(lambda o: o.delivered - o.assigned).mean() / 60),
            pickup_drive_min=float(col(lambda o: o.true_pickup_drive).mean() / 60),
            driver_wait_min=float(col(lambda o: max(0.0, o.ready - o.at_restaurant)).mean() / 60),
            wait_for_assign_min=float(col(lambda o: o.assigned - o.placed).mean() / 60),
            eta_error_min=float(
                np.abs(
                    col(lambda o: o.est_pickup_drive + o.est_dropoff_drive)
                    - col(lambda o: o.true_pickup_drive + o.true_dropoff_drive)
                ).mean()
                / 60
            ),
            # What the dispatcher was told vs. what happened (zero when it is told the truth).
            prep_error_min=0.0
            if sim.cfg.know_prep
            else float(np.abs(col(lambda o: o.ready - o.est_ready)).mean() / 60),
        )

    # ---- drivers
    seconds = np.array([d.seconds for d in sim.drivers], dtype=np.float64)
    for i, d in enumerate(sim.drivers):
        seconds[i, d.status] += end - d.since
    shift_h = seconds[:, IDLE:].sum(axis=1) / 3600
    busy_h = seconds[:, TO_RESTAURANT:].sum(axis=1) / 3600
    deliveries = np.array([d.deliveries for d in sim.drivers], dtype=np.float64)
    online_h = float(shift_h.sum())
    worked = shift_h >= MIN_SHIFT_H_FOR_FAIRNESS
    out.update(
        driver_hours=online_h,
        utilization_pct=float(busy_h.sum() / online_h * 100) if online_h else 0.0,
        deliveries_per_driver_hour=float(len(done) / online_h) if online_h else 0.0,
        km_per_delivery=float(sum(d.meters for d in sim.drivers) / 1000 / max(len(done), 1)),
        driver_gini=gini(deliveries[worked] / shift_h[worked]),
    )

    # ---- fleet mix (only when transit couriers exist; not part of the registry)
    if sim.transit is not None:
        modes = np.array([d.mode for d in sim.drivers])
        by = np.array([sim.drivers[o.driver].mode for o in done])
        took = col(lambda o: o.delivered - o.placed) / 60 if done else np.zeros(0)
        out["transit_delivery_share_pct"] = float((by == "transit").mean() * 100) if done else nan
        for mode in ("car", "transit"):
            hours = float(shift_h[modes == mode].sum())
            out[f"avg_delivery_min_{mode}"] = (
                float(took[by == mode].mean()) if (by == mode).any() else nan
            )
            out[f"deliveries_per_driver_hour_{mode}"] = (
                float((by == mode).sum() / hours) if hours else nan
            )

    # ---- marketplace: was there a free driver for every waiting order?
    if sim.series:
        short = [p["open"] > p["online"] - p["busy"] for p in sim.series]
        out["undersupplied_pct"] = float(np.mean(short) * 100)
    return out
