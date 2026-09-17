# 11. When something goes wrong

Most stalls in this app are one of a dozen things. This chapter is organised by what you
see, not by what the code calls it.

**Where messages appear:** a failed Generate reports **in the form, directly above the
button** — where the setting that caused it can be fixed. Warnings about the job as a
whole appear in the **G-code review** at export. Import problems appear as a status
message at the top of the window.

---

## "Path is open" — an operation refuses a shape

> *Path is open — an outside profile needs a closed shape. Use a centerline profile to cut
> along it.*

> *Path has 2 of 5 subpaths open — pocket needs closed shapes, and an open one is closed
> off as though its ends were joined. Close the path, or take it out of the islands.*

**Any operation that clears an area needs a closed shape.** A pocket, a V-carve, an inlay
or a sided profile has to know what's inside and what's outside, and an open line has no
inside.

This refusal is protecting you from something specific: an open U-shaped path treated as
closed gets joined mouth-to-mouth, and the machine clears a shape you never drew — with a
toolpath that looks perfectly reasonable on the canvas.

**Fixes, in order of preference:**

1. **Close the path.** Double-click into point edit and check the ends actually meet —
   two points a hair apart look closed and aren't.
2. **Use a centerline cut** if a groove is what you wanted. A centerline profile, or a
   centerline trochoidal, follows an open line quite happily.
3. **Take it out of the islands** if the message names a subpath rather than the whole
   path — one stray open segment inside a shape will fail the whole operation.

Imported SVGs are the usual source. A shape that was drawn as a stroke rather than a
filled outline arrives as an open path.

---

## The tool I want isn't in the list

**It's the wrong type for that operation, not the wrong size.** Each operation offers only
the tool types that can do its job:

| Operation | Offers |
|---|---|
| Pocket, Trochoidal | End mill, ball nose |
| Profile | End mill, ball nose, V-bit, taper |
| V-Carve | V-bit, taper |
| Photo V-Carve | V-bit only |
| 3D Profile | Ball nose or taper (roughing: ball nose) |
| Surface | End mill, ball nose |
| Drill (peck) | Any tool that can plunge |
| Drill (helical) | End mill |

You may also see the operation say so outright — *"V-Carve requires a V-bit tool"*,
*"3D Profile requires a ball nose or taper tool"*.

**Max Z never hides a tool.** Ask for more depth than a tool has and the depth field warns
*Exceeds tool Max Z* and leaves the decision to you.

---

## "Too small for the selected tool"

> *Pocket area is too small for the selected tool diameter*

> *Inlay socket is too small for the selected tool*

The cutter physically doesn't fit in the shape. Use a smaller one, or accept that the
detail can't be machined at this size.

> *Pocket allowance collapsed the boundary*

A stock allowance big enough to close the pocket up entirely. Reduce it — or if you meant
to grow the pocket, remember a **negative** allowance is what does that.

> *Stepover too small*

The stepover has been dialled down to a value that would generate an unusable number of
passes. Raise it.

---

## "Could not compute V-Carve medial axis"

> *Could not compute V-Carve medial axis — check that the selected path is a closed shape*

Almost always an open path, or a shape with self-intersections that make "inside"
ambiguous. Check it in point edit. Text converted from an unusual font is a common source
— try a different font, or clean the outline up with a boolean union.

---

## A strategy "declined this shape"

> *morph declined this shape, so auto generated it instead. Alt-click Generate to force
> morph.*

Not an error. Some strategies only suit some geometry, and rather than emit something bad,
the strategy hands over to **Auto**. The pocket you got is a good one.

**Alt-click Generate** to force the original strategy anyway. If it declines even with Alt
held, the message says so — the shape is genuinely one that strategy can't cut, and
repeating the gesture won't help.

---

## "Over-constrained" — a constraint is not being applied

> *Over-constrained in X: Plate, Hole 3 are held by more constraints than they have room
> to satisfy. Delete one.*

Two constraints are fighting over the same freedom, and there is no answer that satisfies
both — so **nothing is moved at all** rather than half-applied. The rows involved turn red
in the Constraints section and the parts stay where they are.

A part has two freedoms, X and Y, and each constraint takes one away. The usual cause is a
part held to another part *and* pinned to a stock edge in the same direction: the stock is
ground and wins, so the other constraint has nothing left to work with.

**Fixes:**

1. **Delete one of the flagged constraints** — its ✕ leaves the parts exactly where they
   are, so nothing jumps.
2. **Or stop holding one number rather than the whole constraint.** Click the **X** or
   **Y** label in the row: the part keeps the other one and is free in that direction.

Holding a part off *two different* stock edges is fine — that is one constraint per
direction, which is exactly determinate. So is a chain of any length, as long as no part
is driven twice.

---

## Operations turned amber

An amber ring on a chip means **needs regenerating**: the geometry, the stock or an
operation it sits on has changed underneath it. The app doesn't silently regenerate —
a toolpath you haven't looked at is worse than one that's obviously stale.

Open the operation and press **Regenerate Toolpath**. The **export review counts stale
operations as a warning**, so a job can't quietly reach the machine with a toolpath that
no longer matches its geometry.

Nesting is a common cause: it moves parts, so everything cut from them goes stale at once.

---

## Nothing fits when nesting

> *Nothing fits on the stock — try a smaller spacing or margin, or larger stock.*

> *Nothing fits on the stock — try a smaller spacing or margin, or turn off "Avoid other
> paths".*

The second version is the interesting one: **Avoid other paths** treats everything you
didn't select as occupied. If the board already has work on it, there may be genuinely no
room.

Parts that don't fit are **parked clear of the stock** rather than dropped, so you can see
what didn't make it.

---

## An import came in empty

> *SVG import failed — no usable paths in the file*

> *DXF import failed — no supported geometry in the file*

- **SVG** — the file may be entirely text elements or embedded images rather than paths.
  Convert text to outlines and re-export.
- **DXF** — supported entities are LINE, LWPOLYLINE, ARC, CIRCLE, SPLINE and ELLIPSE.
  Blocks and proxy entities need exploding first.
- **A DXF with no units** will ask you which to use. Getting that wrong gives geometry
  25.4× too big or too small.

---

## The part came out the wrong size

Almost always **cut side**. A profile cut *centerline* instead of *outside* is one tool
radius undersized all the way round, and nothing on the canvas shows it.

- **Outside** — the line is the finished edge of the part.
- **Inside** — the line is the finished wall of a hole.
- **Centerline** — the tool's axis runs down the line, taking half a tool width off each
  side.

If it's out by a consistent small amount rather than a radius, check **stock allowance** —
and remember a negative allowance cuts past the line, which is how you tune a fit.

---

## The cut is in the wrong place, or the wrong depth

**Check the origin lines in the export review against how you actually zeroed the
machine.** The review restates both:

- **Work origin (XY)** — which corner of the stock is X0 Y0.
- **Z origin** — *"Top of stock — set Z0 at the top surface"* or bottom of stock.

A job zeroed at the top of the stock but exported for bottom-of-stock referencing will
plunge the full stock thickness deeper than you meant.

For depth specifically, remember **depth is measured from the start height, not from the
top of the stock** — see [chapter 4](04-operations.md#depth-is-how-far-below-the-start-not-a-z-position).

---

## The simulation was fine and the machine wasn't

The simulator proves the toolpaths do what you meant. It knows nothing about:

- whether the machine is trammed and square
- whether the stock is where you think it is
- whether the workholding held
- whether the bit is sharp, or is even the bit the program asked for

If the simulation was right and the cut wasn't, the difference is in the setup, not in the
G-code. Start with Z zero and workholding.

---

## Peck drilling with an end mill

> *Peck drilling with an end mill — it must be centre-cutting to plunge.*

A warning, not a refusal. Many end mills — particularly two-flute finishers with a gap at
the centre — cannot cut at their own axis and will rub rather than plunge. Check the bit,
or use **helical** drilling instead, which cuts on its periphery all the way down.

---

## Things went slow

**Generation** — pockets are the expensive operation, especially adaptive on a big area
with islands. It runs in the background; the chip shows a spinner.

**The simulator** — a full sheet takes a couple of seconds to carve into the 3D view the
first time. It works in chunks and catches up rather than freezing.

**A very long job** — check the estimated run time in the export review. 3D finishing at a
fine stepover is where an afternoon turns into two days.

---

## Nothing here matches

Two things to try before anything else:

1. **Undo.** Undo covers every edit and is per session.
2. **Reload the page.** Your work is in the browser and the app offers to **restore
   unsaved work** when it reopens — but save a `.fkam` first if you can.

If a project reproduces a problem, keep that `.fkam`. It's the one thing that makes a bug
fixable.

---

## Back to

- **[The guide index](README.md)**
- **[1. Quick Start](01-quick-start.md)** — the whole workflow in one part
