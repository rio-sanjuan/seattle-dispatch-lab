"""Running many simulated days and comparing policies fairly.

One simulated day is one sample. A day with a few unlucky kitchens can move
the late rate more than a change of dispatcher does, so every comparison here:

  1. runs each policy on the *same* set of days (same seed = same orders,
     kitchens and driver shifts), and
  2. looks at the per-day difference between two policies, not at the
     difference of their averages.

Pairing removes the day-to-day noise both policies share, which is most of it.
"""

from __future__ import annotations

import os
from concurrent.futures import ProcessPoolExecutor
from dataclasses import replace

import numpy as np
from scipy import stats

from .metrics import BY_KEY, METRICS
from .sim import SimConfig, Simulation

_network = None


def run_one(cfg: SimConfig) -> dict:
    global _network
    if _network is None:
        from .network import RoadNetwork

        _network = RoadNetwork.load()
    return Simulation(cfg, _network).run().summary()


def run_many(cfgs: list[SimConfig], workers: int | None = None) -> list[dict]:
    """Run configs in parallel processes; results come back in the same order."""
    workers = workers or max(1, min(8, (os.cpu_count() or 2) - 2))
    if workers == 1 or len(cfgs) == 1:
        return [run_one(c) for c in cfgs]
    with ProcessPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(run_one, cfgs))


def run_variants(
    base: SimConfig, variants: dict[str, dict], days: int, workers: int | None = None
) -> dict[str, list[dict]]:
    """Run each named variant (a set of config overrides) on the same `days` seeds."""
    seeds = [base.seed + i for i in range(days)]
    cfgs = [replace(base, seed=s, **over) for over in variants.values() for s in seeds]
    results = run_many(cfgs, workers)
    return {name: results[i * days : (i + 1) * days] for i, name in enumerate(variants)}


def column(runs: list[dict], key: str) -> np.ndarray:
    return np.array([r.get(key, np.nan) for r in runs], dtype=np.float64)


def mean_interval(values: np.ndarray) -> tuple[float, float]:
    """Mean and the half-width of its 95% confidence interval (Student t)."""
    values = values[~np.isnan(values)]
    n = len(values)
    if n == 0:
        return float("nan"), float("nan")
    if n == 1:
        return float(values[0]), float("nan")
    half = stats.t.ppf(0.975, n - 1) * values.std(ddof=1) / np.sqrt(n)
    return float(values.mean()), float(half)


def paired_difference(a: list[dict], b: list[dict], key: str) -> dict:
    """Per-day difference a - b for one metric, with a 95% interval and a verdict.

    `a` and `b` must be the same days in the same order.
    """
    assert [r["seed"] for r in a] == [r["seed"] for r in b], "runs are not paired"
    diff = column(a, key) - column(b, key)
    mean, half = mean_interval(diff)
    better = BY_KEY[key].better if key in BY_KEY else ""
    if not better or np.isnan(half):
        verdict = ""
    elif abs(mean) <= half:
        verdict = "no clear difference"
    else:
        verdict = "better" if (mean < 0) == (better == "low") else "worse"
    return {"mean": mean, "half_width": half, "verdict": verdict, "days": len(diff)}


def summarize_variants(runs: dict[str, list[dict]], baseline: str) -> dict:
    """Means per variant and paired differences from the baseline, for every metric."""
    out: dict = {"baseline": baseline, "days": len(runs[baseline]), "metrics": {}}
    for m in METRICS:
        entry: dict = {"mean": {}, "half_width": {}, "vs_baseline": {}}
        for name, rs in runs.items():
            entry["mean"][name], entry["half_width"][name] = mean_interval(column(rs, m.key))
            if name != baseline:
                entry["vs_baseline"][name] = paired_difference(rs, runs[baseline], m.key)
        out["metrics"][m.key] = entry
    return out
