"""Record live freeway travel times from WSDOT, one snapshot every two minutes.

This is the raw material for a *live* traffic mode (today's traffic instead of
a typical 2015 week). The simulator does not read these files yet.

Get a free access code at https://wsdot.wa.gov/traffic/api/ (enter an email
address, the code appears on the page), then:

    export WSDOT_ACCESS_CODE=your-code
    uv run python scripts/collect_wsdot.py            # runs until Ctrl-C
    uv run python scripts/collect_wsdot.py --once     # a single snapshot

Each line of data/wsdot/travel_times-YYYY-MM-DD.jsonl is one snapshot:
{"fetched": ISO time, "routes": [{"id", "name", "current_min", "average_min",
"miles", "updated"}]}. current_min / average_min is that route's slowdown.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

import httpx

URL = "https://wsdot.wa.gov/Traffic/api/TravelTimes/TravelTimesREST.svc/GetTravelTimesAsJson"
OUT_DIR = Path(__file__).resolve().parents[1] / "data" / "wsdot"
POLL_SECONDS = 120  # WSDOT refreshes these about every two minutes


def fetch(code: str) -> dict:
    response = httpx.get(URL, params={"AccessCode": code}, timeout=30)
    if response.status_code in (400, 401):
        sys.exit("WSDOT rejected the access code. Check WSDOT_ACCESS_CODE.")
    response.raise_for_status()
    routes = [
        {
            "id": r["TravelTimeID"],
            "name": r["Name"],
            "current_min": r["CurrentTime"],
            "average_min": r["AverageTime"],
            "miles": r["Distance"],
            "updated": r["TimeUpdated"],
        }
        for r in response.json()
    ]
    return {"fetched": datetime.now(UTC).isoformat(), "routes": routes}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    code = os.environ.get("WSDOT_ACCESS_CODE")
    if not code:
        sys.exit("Set WSDOT_ACCESS_CODE first (free at https://wsdot.wa.gov/traffic/api/).")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    while True:
        snap = fetch(code)
        path = OUT_DIR / f"travel_times-{snap['fetched'][:10]}.jsonl"
        with path.open("a") as f:
            f.write(json.dumps(snap) + "\n")
        print(f"{snap['fetched']}  {len(snap['routes'])} routes -> {path.name}")
        if args.once:
            break
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
