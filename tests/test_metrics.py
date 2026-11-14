import math

import numpy as np
import pytest

from seattle_dispatch_lab.experiments import mean_interval, paired_difference, summarize_variants
from seattle_dispatch_lab.metrics import METRICS, gini
from seattle_dispatch_lab.sim import Simulation

from .test_sim import small


def test_gini_extremes():
    assert gini([3, 3, 3, 3]) == pytest.approx(0.0)
    assert gini([0, 0, 0, 12]) == pytest.approx(0.75)  # (n - 1) / n for one taker
    assert gini([]) == 0.0


def test_summary_has_every_metric(grid):
    s = Simulation(small(), grid).run().summary()
    for m in METRICS:
        assert m.key in s, m.key
        assert not math.isnan(s[m.key]), m.key
    assert 0 <= s["driver_gini"] <= 1
    assert s["ready_to_door_min"] > s["food_wait_min"]
    assert s["active_min_per_delivery"] > s["pickup_drive_min"]


def test_abandoned_orders_count_as_late(grid):
    # Far too few drivers: most orders are never delivered. The delivered-only
    # average hides that; the due-cohort metrics must not.
    s = Simulation(small(n_drivers=2), grid).run().summary()
    assert s["unfulfilled_pct"] > 30
    assert s["late_pct"] >= s["unfulfilled_pct"]
    assert s["severe_late_pct"] > 30


def test_perfect_drive_estimates_have_no_error(grid):
    normal = Simulation(small(traffic_scale=2.0), grid).run().summary()
    oracle = Simulation(small(traffic_scale=2.0, know_drive=True), grid).run().summary()
    assert oracle["eta_error_min"] == pytest.approx(0.0, abs=1e-6)
    assert normal["delivered"] > 50 and oracle["delivered"] > 50


def test_perfect_prep_estimates_cut_waiting(grid):
    normal = Simulation(small(), grid).run().summary()
    oracle = Simulation(small(know_prep=True), grid).run().summary()
    assert oracle["prep_error_min"] == 0.0 < normal["prep_error_min"]
    # Knowing when food is ready lets just-in-time dispatch waste less of both sides' time.
    assert (
        oracle["driver_wait_min"] + oracle["food_wait_min"]
        < normal["driver_wait_min"] + normal["food_wait_min"]
    )


def test_jit_buffer_is_applied(grid):
    sim = Simulation(small("matching_jit", jit_buffer_s=37.0), grid)
    assert sim.dispatcher.buffer == 37.0
    eager = Simulation(small("matching_jit", jit_buffer_s=3600.0), grid).run().summary()
    patient = Simulation(small("matching_jit", jit_buffer_s=0.0), grid).run().summary()
    assert patient["driver_wait_min"] < eager["driver_wait_min"]


def runs(values, key="avg_delivery_min"):
    return [{"seed": i, key: v} for i, v in enumerate(values)]


def test_paired_difference_sees_through_shared_noise():
    # Days differ a lot from each other, but policy A is 1 minute faster every day.
    b = runs([20.0, 35.0, 27.0, 41.0, 23.0])
    a = runs([19.0, 34.1, 25.9, 40.0, 22.0])
    d = paired_difference(a, b, "avg_delivery_min")
    assert d["mean"] == pytest.approx(-1.0)
    assert d["half_width"] < 0.2
    assert d["verdict"] == "better"
    # Each policy's own average is far too noisy to show a 1-minute gap.
    assert mean_interval(np.array([r["avg_delivery_min"] for r in b]))[1] > 5


def test_verdict_respects_direction_and_noise():
    base = runs([1.5, 1.6, 1.4, 1.5], "deliveries_per_driver_hour")
    more = runs([1.7, 1.8, 1.6, 1.7], "deliveries_per_driver_hour")
    assert paired_difference(more, base, "deliveries_per_driver_hour")["verdict"] == "better"
    noisy = runs([30.0, 20.0, 31.0, 19.0])
    flat = runs([25.0, 25.0, 25.0, 25.0])
    assert paired_difference(noisy, flat, "avg_delivery_min")["verdict"] == "no clear difference"
    neutral = paired_difference(
        runs([1, 2, 3], "utilization_pct"), runs([3, 3, 3], "utilization_pct"), "utilization_pct"
    )
    assert neutral["verdict"] == ""


def test_paired_difference_rejects_mismatched_days():
    with pytest.raises(AssertionError):
        paired_difference(
            runs([1.0, 2.0]), [{"seed": 9, "avg_delivery_min": 1.0}] * 2, "avg_delivery_min"
        )


def test_summarize_variants_shape(grid):
    by = {
        name: [Simulation(small(name, seed=s), grid).run().summary() for s in (1, 2, 3)]
        for name in ("matching", "nearest")
    }
    out = summarize_variants(by, "matching")
    entry = out["metrics"]["avg_delivery_min"]
    assert set(entry["mean"]) == {"matching", "nearest"}
    assert set(entry["vs_baseline"]) == {"nearest"}
    assert out["days"] == 3
