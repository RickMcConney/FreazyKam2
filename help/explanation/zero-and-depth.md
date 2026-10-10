# Where zero is, and how depth is measured

## Zero is a promise

Every number in your G-code is measured from **work zero** (X0 Y0 Z0). The app picks a spot
on the stock; you must zero the machine at **the same spot**. If they differ, every cut
moves by the difference.

## X0 Y0

Usually the **bottom-left corner** of the stock, because it's easy to jog to and find by
touch. Pick the **centre** if you locate work from the middle, as with a fixture.

## Z0: top or bottom?

```
  Top of stock (usual)          Bottom of stock

  Z0 ──────────────  top        Z+12 ────────────  top
       │  stock  │                   │  stock  │
  Z-12 ──────────────  table    Z0 ──────────────  table
```

- **Top of stock:** touch the bit on the material. Cuts go negative. Easy, and what most
  people use.
- **Bottom of stock:** touch on the table. Useful when the board's thickness varies but the
  finished height from the table must not, such as flattening a slab.

Mix them up and the cutter plunges a whole stock thickness too deep. That's why the export
review repeats your choice.

## Depth is from the start

**Depth** is how much this cut removes, measured down from where it **starts**. It is not a
Z position.

```
  Z 0  ───────────────── stock top
  Z-3  ─────┐     ┌───── pocket floor  ← engraving starts here
            │     │
  Z-4       └─────┘      engraving (Depth = 1)
```

Start = pocket floor (−3), Depth = 1 → ends at −4.
Type `4` by mistake and you'd end at −7.

The form shows the resolved start Z beside the **Start** label so you can check.

## Why Auto start is cautious

**Auto** looks at what earlier cuts removed and starts at the **highest** material left. If
any part of the new cut is over uncut stock, it starts at the top.

Starting too high wastes a little air. Starting too low crashes the bit. So it picks high.

## Why cut through at 12.5 mm on 12 mm stock?

Stock thickness varies, and the spoilboard is never perfectly flat. An extra half
millimetre makes sure the part separates.

**How-to:** [Set your work origin](../how-to/set-your-work-origin.md) ·
[Cut into the floor of a pocket](../how-to/cut-into-a-pocket-floor.md)
