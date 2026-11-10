import numpy as np

from seattle_dispatch_lab.dispatch import (
    BatchedMatching,
    DispatchView,
    JustInTimeMatching,
    NearestDriver,
)


def view(pickup, *, now=1000.0, est_ready=None, declined=None, placed=None):
    pickup = np.array(pickup, dtype=float)
    n_orders, n_drivers = pickup.shape
    return DispatchView(
        now=now,
        driver_ids=np.arange(100, 100 + n_drivers),
        order_ids=np.arange(n_orders),
        pickup_drive=pickup,
        dropoff_drive=np.full(n_orders, 300.0),
        placed=np.full(n_orders, now - 60.0) if placed is None else np.array(placed, dtype=float),
        est_ready=np.full(n_orders, now) if est_ready is None else np.array(est_ready, dtype=float),
        promised=np.full(n_orders, now + 3600.0),
        declined=np.zeros(pickup.shape, dtype=bool) if declined is None else np.array(declined),
    )


# Order 0 is slightly closer to driver 100 than order 1 is, but driver 101 is
# hopeless for order 1. Greedy gives driver 100 to order 0 and strands order 1.
TRAP = [[100.0, 200.0], [150.0, 2000.0]]


def test_nearest_is_greedy():
    offers = NearestDriver().decide(view(TRAP, placed=[900.0, 950.0]))
    assert offers == [(100, 0), (101, 1)]


def test_matching_avoids_the_greedy_trap():
    offers = BatchedMatching().decide(view(TRAP, placed=[900.0, 950.0]))
    assert sorted(offers) == [(100, 1), (101, 0)]


def test_declined_pairs_are_never_offered_again():
    declined = [[True, False], [False, False]]
    for policy in (NearestDriver(), BatchedMatching(), JustInTimeMatching()):
        offers = policy.decide(view([[10.0, 500.0], [400.0, 20.0]], declined=declined))
        assert (100, 0) not in offers


def test_each_driver_and_order_used_once():
    rng = np.random.default_rng(0)
    for policy in (NearestDriver(), BatchedMatching(), JustInTimeMatching()):
        offers = policy.decide(view(rng.uniform(60, 900, size=(7, 4))))
        assert len(offers) == 4
        assert len({d for d, _ in offers}) == 4
        assert len({o for _, o in offers}) == 4


def test_matching_serves_old_orders_first_when_drivers_are_scarce():
    # One driver, equally far from two orders; the older order should win.
    offers = BatchedMatching().decide(view([[300.0], [300.0]], placed=[0.0, 900.0]))
    assert offers == [(100, 0)]


def test_just_in_time_holds_an_order_whose_food_is_far_from_ready():
    now = 1000.0
    v = view([[120.0], [120.0]], now=now, est_ready=[now + 60.0, now + 1500.0])
    assert BatchedMatching().decide(v) != []
    assert JustInTimeMatching().decide(v) == [(100, 0)]
