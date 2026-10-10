# Escapement settings

![Escape wheel and anchor](../../docs/images/08-esc-overview.svg)

## Fields

| Field | Meaning |
|---|---|
| Type | **Deadbeat** (better timekeeper) or **Recoil** (simpler, more forgiving) |
| Teeth | 30 beats seconds with a 1 s pendulum. Also sets the pallet span |
| Wheel Ø | Tip circle diameter |
| Tooth H | Tooth depth, tip to root |
| Drop | Degrees the **wheel** turns freely each beat |
| Lift | Degrees the **anchor** swings during impulse |
| Lock | Deadbeat. Degrees the anchor swings while locked |
| Draw | Deadbeat. Lean of the locking face. Keep 1–2° |
| Recoil | Recoil. Extra swing the faces take |
| Arm W | Anchor arm and pallet width |
| Bore Ø / Hub Ø / Spokes | Wheel body |
| Arbor Ø | Anchor arbor hole |
| Clockwise | Wheel direction. Geometry, not a view option |

## Targets

| Measure | Target | Warns |
|---|---|---|
| Landing | 0.5 mm | Note ≥ 0.25 mm, warning below |
| Run margin | 0.5 mm (always kept) | — |
| Pallet tip clearance | — | Below 0.25 mm; red at contact |
| Pallet dive | — | Past ~45 % of tooth depth |

## Default wheel trade-offs

30 teeth, 100 mm, lift 3°, draw 2°:

| Lock | Drop | Landing | Tip clearance | Pendulum gets | Note |
|---|---|---|---|---|---|
| 1° | 2° | 0.04 mm | 0.50 mm | 33.6 % | landing warning |
| 1.25° | 2° | 0.25 mm | 0.50 mm | 32.8 % | landing warning |
| **1.5°** | **2°** | **0.46 mm** | **0.40 mm** | **32.0 %** | **default** |
| 2° | 2° | 0.48 mm | 0.38 mm | 28.7 % | dive at 98 % of limit |
| 1.5° | 1.75° | 0.45 mm | 0.25 mm | 33.8 % | tip warning |
| 1.5° | 2.5° | 0.48 mm | 0.49 mm | 27.8 % | |

## Readout lines

| Line | Meaning | If bad |
|---|---|---|
| Settings | Repeats all fields | — |
| Wheel centre to anchor arbor | Arbor spacing to lay out | Don't measure off the canvas |
| Pendulum must swing past | Minimum swing to unlock | — |
| Pallets dive | Reach inside tip circle | Deeper teeth, or less lock/lift |
| Impulse faces are steep | Face angle from swing direction | More lift or drop |
| Pallet tip clears the tooth backs by | Closest gap over the swing | More drop |
| Pendulum gets N % of the drive | Energy budget | Compare settings |

**Related:** [How an escapement works](../explanation/escapement.md)
