# Chip load and feeds

## Formula

```
chip load = feed ÷ (RPM × flutes)
```

Units: mm per tooth (feed in mm/min).

## Gauge bands

| Reading | Actual ÷ target | Means |
|---|---|---|
| 🔴 rubbing · too hot | below 0.75 | Too slow a feed for the RPM |
| 🟢 sweet spot | 0.75 – 1.4 | Good |
| 🔵 chips too large | above 1.4 | Too fast a feed for the RPM; risk of breaking |

## What sets the target

| Factor | Effect |
|---|---|
| Material | Softer takes a thicker chip |
| Bit diameter ≥ 1/8" | Chip grows with diameter, up to 2× a 6 mm bit's |
| Bit diameter < 1/8" | Chip shrinks faster than the bit (1/16" ≈ ⅓ of 1/8") |
| Bit type | V-bits, ball noses and bull noses take less |
| Rated chip load | Ceiling. Never exceeded |
| Rigidity | Trims it |

## When max feed is too low

The app slows the spindle to keep the chip load, rather than taking shallower passes.

**Related:** [Why chip load matters](../explanation/chip-load.md)
