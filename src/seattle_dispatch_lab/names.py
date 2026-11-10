"""Made-up restaurant names. Locations are realistic; the businesses are not."""

from __future__ import annotations

import numpy as np

_ADJECTIVES = [
    "Golden",
    "Lucky",
    "Blue",
    "Little",
    "Smoky",
    "Sunny",
    "Salty",
    "Copper",
    "Velvet",
    "Crooked",
    "Sleepy",
    "Wild",
    "Humble",
    "Bright",
    "Mossy",
    "Rusty",
    "Jolly",
    "Quiet",
    "Amber",
    "Foggy",
    "Drifting",
    "Paper",
    "Midnight",
    "Tin",
]
_NOUNS = [
    "Heron",
    "Otter",
    "Kettle",
    "Lantern",
    "Anchor",
    "Fern",
    "Orca",
    "Spruce",
    "Marmot",
    "Ferry",
    "Compass",
    "Sparrow",
    "Cedar",
    "Pebble",
    "Raven",
    "Tide",
    "Salmon",
    "Umbrella",
    "Barnacle",
    "Juniper",
    "Owl",
    "Skillet",
    "Pickle",
    "Fox",
]
_CUISINES = [
    "Thai",
    "Tacos",
    "Pho",
    "Pizza",
    "Burgers",
    "Sushi",
    "Teriyaki",
    "Ramen",
    "Dumplings",
    "Curry",
    "Bagels",
    "Poke",
    "Falafel",
    "BBQ",
    "Noodles",
    "Wings",
    "Sandwiches",
    "Banh Mi",
    "Kebab",
    "Salads",
]


def restaurant_names(n: int, rng: np.random.Generator) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    while len(out) < n:
        name = f"{rng.choice(_ADJECTIVES)} {rng.choice(_NOUNS)} {rng.choice(_CUISINES)}"
        if name not in seen:
            seen.add(name)
            out.append(name)
    return out
