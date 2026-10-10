# Gears and clock trains

## Real gears, not lookalikes

The gear shape uses a true **involute** tooth: the curve that makes two gears turn at a
steady ratio. A rounded tooth that just looks right will bind or jerk.

The root is cut the way a real hob would cut it. So small gears (few teeth) come out with
thin, **undercut** roots, just as real ones do. That's correct, not a bug.

## Module

**Module** is tooth size. Two gears mesh only if they share a module.

```
pitch diameter = module × teeth
```

That's why you can't drag a gear bigger: changing its size would change its module.

## Cycloidal gears and pinions

Clocks often use **cycloidal** teeth with a **lantern pinion** (pins instead of teeth). The
wheel's tooth shape comes from that pinion's pin circle, so they're made together as a pair.

## Clock trains

A clock is a chain of gears that turns the escape wheel's fast ticking into hands moving at
the right speed. The designer works it out from the **beat**.

### Why it must be exact

Tooth counts are whole numbers. Not every beat can be hit exactly. When it can't, the panel
shows red instead of rounding. 0.3 % fast loses about four minutes a day.

### Why each mesh has its own module

Force drops at each step along the train. The great wheel carries roughly sixty times the
escape wheel's load. Same-size teeth everywhere would leave one end too weak and the other
too coarse. So teeth get finer toward the escapement. Set **Max wheel Ø** and the designer
sizes everything to fit.

### Why each wheel is its own shape

Once the train is set, you'll want to change bores, hubs and spokes per wheel. Each wheel
is a normal shape you can edit. The clock chip reopens the designer without losing those
changes.

**How-to:** [Make a gear](../how-to/make-a-gear.md) ·
[Design a clock](../how-to/design-a-clock.md)
