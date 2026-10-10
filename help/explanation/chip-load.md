# Chip load: why slower can be worse

**Chip load** is how thick a slice each tooth takes:

```
chip load = feed ÷ (RPM × flutes)
```

It's the number that decides whether a bit cuts well.

## Too thin: rubbing

If the bit spins fast but moves slowly, each tooth barely touches the wood. It rubs instead
of cutting. Rubbing makes heat. Heat dulls the edge and can burn the wood.

**Going slower to be safe often makes things worse.**

## Too thick: breaking

If the bit moves fast for its speed, each tooth bites too much. Small bits snap.

## The fix is usually the spindle

If your machine can't feed fast enough for a good chip, **slow the spindle down**. Taking a
shallower pass doesn't help, because depth isn't in the formula.

The app does this for you when it hits your **Max feed rate**.

## Why small bits get special treatment

Below 1/8", bits get weak quickly for their size. A 1/16" bit takes about a third of a
1/8" bit's chip, not half. Without that, a tiny engraving bit would be fed hard enough to
break.

## The gauge

When you simulate, the readout shows chip load as actual / target:
🔴 rubbing · 🟢 sweet spot · 🔵 chips too large.

These are good starting numbers, not guarantees. The app doesn't know if your bit is dull
or your board is knotty.

**How-to:** [Tune feeds and speeds](../how-to/tune-feeds-and-speeds.md) ·
**Reference:** [Chip load bands](../reference/chip-load.md)
