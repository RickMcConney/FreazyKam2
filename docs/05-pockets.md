# 5. Cutting with an end mill

Five operations cut with a flat or ball-nosed cutter: **Profile** follows a line,
**Pocket** clears an area, **Trochoidal** cuts a slot at low load, **Drill** makes holes,
and **Surface** flattens the stock. Between them they cover most of what a router
actually does.

---

## Profile

A profile follows a path. The only question that really matters is **which side of the
line the tool runs on**, because that is what decides whether your part comes out the
size you drew it.

| Cut side | Tool runs | Use for |
|---|---|---|
| **Outside** | Outside the line, offset by its radius | The outline of a part — the line is the finished edge |
| **Inside** | Inside the line, offset by its radius | A hole or window — the line is the finished wall |
| **Centerline** | Axis straight down the line | A groove or a score — takes half a tool width off each side |

Getting this wrong is the classic beginner's mistake: a part cut *centerline* instead of
*outside* comes out one tool radius undersized all round, and the error is invisible on
the canvas.

Other fields:

- **Stock allowance** leaves material on the wall. **Negative cuts past the line**, which
  is how you get a slip fit rather than a press fit.
- **Finishing Pass** keeps every depth pass a little further off the wall (0.3 mm by
  default), then cuts the wall itself in one pass at full depth. The wall comes out as one
  clean sweep with no step lines from the depth passes, and the last cut is light, so the
  tool hardly deflects. It runs after all the depth passes, so a part is finished while
  its tabs still hold it — without tabs, hold the part down some other way. It finishes to
  the stock allowance, not to the line. **Spring Pass** goes round the wall a second time
  without lifting, to take off what the tool's flex left on the first. Not on a centerline
  cut, which has no wall, or with Optimize Path.
- **Ramp in** enters each pass on a slope instead of plunging. Leave it on unless you
  have a reason.
- **Direction** — climb for a clean edge on a rigid enough machine, conventional if the
  machine has backlash it can't take up.

> **The tool's radius changes with depth.** With a V-bit or a taper the wall is not
> vertical, so the offset is taken at the *cut surface* — the finished wall touches your
> line at the start height and tapers below it. With an end mill this is a distinction
> without a difference; with a taper it is the whole story.

### Open paths

A profile of an open stroke is cut **centerline** — that is the only reading that means
anything, since a line with no inside has no side to offset to. Ask for inside or outside
on an open path and the operation refuses and says so, naming the side you chose.

This refusal matters more than it sounds. Without it, an open U-shaped path handed to an
area operation gets silently treated as closed — joined mouth to mouth — and the machine
cuts a shape you never drew, with a toolpath that looks perfectly reasonable on screen.

---

## Holding tabs

Tabs are small bridges of uncut material that stop a part coming loose on the final pass
and being thrown by the cutter.

**Tabs** is a Path Tool, not an operation. It attaches to the **path**, gets its own chip
in the Objects strip, and any profile cut on that path honours it.

| Field | Meaning |
|---|---|
| **Count** | How many, spaced evenly around the path |
| **Length** | How far along the path each one runs |
| **Height** | How much material is left under the cutter |

Drag any tab along the path to move it. Put them on straight runs rather than corners,
away from anything delicate, and where you don't mind cleaning up — the tab has to be
cut or sanded off afterwards.

Height is a trade: enough to hold the part through the last pass, little enough to part
with a chisel. Two to three millimetres suits most wood.

### Tabs on several parts at once

Select every part first — drag a box over a sheet — and the form tabs them all with one
click: **Apply Tabs to N Paths**. Each gets the same count, length and height, replacing any
tabs it had. It is **one undo step and one chip** (*Tabs on N paths*); click the chip to
select those parts again and change the settings, or delete it to take every one of those
tabs off. With several paths selected the form lists them, with how many tabs each has, and
**Clear Tabs on N Paths** takes them all off together.

### Holding strips: a tight nest

On a sheet nested tight, tabs stop working. A tab holds a part to whatever is beside it —
and between closely packed parts that is waste the neighbouring cuts have already cut loose,
so the part and the waste holding it come free together. What actually keeps a part down
is a chain of uncut material all the way out to the edge of the sheet.

**Holding strips** are that chain. With several parts selected the Tabs form offers two ways
to hold them — choose **Joined by strips** instead of **Tabs on each path**. Each strip is a
short join laid square across the gap between two neighbouring parts, or between a part and
the edge of the sheet, and every cut through the stock lifts over it there. Together they make
a network: every part hangs on the sheet's edge through its neighbours, so nothing comes loose
however the waste between them is cut up.

| Field | Meaning |
|---|---|
| **Joins Per Part** | How many joins each part makes into the network — each is a tab on the part |
| **Width** | How wide each strip is across the gap |
| **Height** | How much material is left under the cutter, as for a tab |

Press **Place Strips**. They are drawn on the canvas as amber bands so you can check them
before cutting, get one chip in the Objects strip (*Strips ×N*), and are one undo step.
**Re-place Strips** replaces the whole set; **Remove Strips**, or deleting the chip, takes
them off. They are saved with the project.

How they are placed:

- **Only the parts are joined.** Drag a box over a sheet and it catches the labels and holes
  too; the strips join only the paths a cut sets free — an outside or centerline profile
  through the stock — and the form says how many that is.
- **Every join is square across one gap** and goes nowhere near any other part's edge, so it
  lifts exactly two short stretches of cut: the two parts it joins.
- **Joins spread round each part.** Each new join faces a different way off the part from the
  ones it already has before any side gets a second, so a long thin part is held at both ends
  and on both long sides rather than all along the side facing its neighbour.
- **A join to the sheet's edge stops about 20 mm out.** The stock beyond is joined to the
  edge already; the strip only has to bridge the part's own cut.
- **Holes cut straight through them.** A hole lies inside its part, so cutting it cannot
  break the chain the part itself carries on. Label engravings and other shallow cuts are not
  lifted either — they cannot free anything.

**How many joins?** Two holds a part at two points, usually both ends of it. Four holds it
from every side, and is the better choice for long thin parts, which can flex and pivot about
two. More joins hold better but leave more to clean up — each join is a tab to trim off.

Strips are not the same thing as **Bridge Gaps Through Waste** in a Profile's Optimize Path:
that one *cuts* straight across waste to join toolpaths; strips *leave* material standing.

---

## Pocket

A pocket clears the area **inside** a closed boundary. Anything closed that sits inside
the boundary is read as an **island** and left standing — you don't declare islands, the
app reads them off the geometry.

### Invert Pocket

Nested outlines have two valid readings, and only you know which is the part. A ring
drawn as two circles is either *clear the annulus and leave the middle*, or *clear the
middle and leave the ring*. When the selection nests, an **Invert Pocket** checkbox
appears to say which.

The operation stores the reading it used, so reopening the form shows what that pocket
actually did rather than guessing again.

### The five strategies

The same heart pocket, cut five ways with the same tool and stepover:

| Auto | Raster | Contour | Morph | Adaptive |
|:---:|:---:|:---:|:---:|:---:|
| ![Diagonal parallel passes with a contour following the boundary](images/05-strategy-auto.png) | ![Horizontal parallel passes across the pocket](images/05-strategy-raster.png) | ![Concentric heart-shaped rings stepping inward](images/05-strategy-contour.png) | ![One continuous spiral morphing from the heart outline to a point](images/05-strategy-morph.png) | ![A spiral with arcs kept at constant engagement](images/05-strategy-adaptive.png) |
| Rastered, plus a contour round the wall | One angle, straight across | Nested rings | One unbroken spiral | Constant engagement |

<!-- CROP · identical box over the same heart pocket in five captures, 600 px wide each. -->

Look at what each one does to the *corner* of the heart — that notch is where they differ
most, and it is the part of a pocket that decides whether you get a clean floor.

| Strategy | How it clears | Best for |
|---|---|---|
| **Auto** | Picks per area — rasters open ground, contours around islands, adaptive on the junctions | **Start here.** Mixed pockets, anything with islands |
| **Raster** | Straight parallel passes at one angle | Simple open pockets with nothing in the way |
| **Contour** | Concentric offsets following the boundary inward | Walls and islands that must be traced |
| **Morph** | One continuous spiral morphed between the boundary and the interior | Smooth organic shapes, fewest retracts |
| **Adaptive** | Holds a constant tool engagement | Hard material and deep pockets — heavier depth of cut at lower load |

**Contour and Morph look alike and are not.** Contour cuts a stack of separate closed
rings, lifting between them. Morph is *one continuous path* that spirals from the wall to
the middle without lifting at all — which is why it has the fewest retracts and why it
can't always be done.

**Auto is the default and usually the right answer.** The others are there for when you
know something about the shape that the general case doesn't.

**A strategy can decline a shape.** Morph in particular only suits some geometry. When it
declines, Auto generates the pocket instead and the form tells you so — *"morph declined
this shape, so auto generated it instead."* You can **Alt-click Generate** to force it,
and if it declines even then, the message says so rather than sending you round the loop
again.

### Stepover, engagement, and angle

**Stepover** is how far each pass moves over, as a percentage of tool diameter. On the
**Adaptive** strategy the same slider becomes **Engagement**, because that strategy holds
engagement constant rather than spacing.

**Angle** applies to raster passes. Left on **Auto (longest passes per area)** the app
picks the direction that gives the fewest, longest passes — fewer turns, less air. Untick
it to pin an angle, which is what you want when the grain, or a wall you care about,
says so.

### Rest clearing

Every pocket gets a **rest-clearing pass**. Whatever a strategy's passes couldn't reach
is cut after them and before the wall pass, so it comes off as a light skim rather than
being hit at full width on the wall pass. You don't configure it; it's there because
every strategy leaves *something* somewhere.

---

## Trochoidal

Trochoidal cutting takes a slot at low load by moving the cutter in overlapping loops
along the path instead of ploughing straight down it. The full width still gets cut, but
the tool is only ever engaged over a small arc. Use it in hard material, on a light
machine, or wherever a full-width slot would be too much.

| Field | Meaning |
|---|---|
| **Cut side** | Inside, outside, or centerline |
| **Loop amplitude** | How far the loops swing either side |
| **Step / loop** | How far along the path each loop advances |
| **Finishing pass** | A clean-up pass after the loops |

**Centerline trochoidal is the one to understand.** It follows an **open** stroke — the
only operation that genuinely does — and the slot is **centred on the line you drew**.
The loops swing half the amplitude each way, so the finished slot comes out:

```
slot width = 2 × loop amplitude + tool diameter
```

Draw a line, ask for a 2 mm amplitude with a 6 mm cutter, and you get a 10 mm slot
centred on that line. Size the amplitude from the slot you want, not from the tool.

On a centerline cut the **finishing pass is the two walls, not the centreline** — the
loops already clear right across the middle, so a sweep down it would be a pure air pass.
It is the walls that are left scalloped, and it is the walls that get cleaned up.

---

## Drill

Two modes, and they use different tools.

### Peck

Plunges down the axis, retracting to clear chips. Points come from either:

- **Clicking on the canvas** to place them by hand, or
- **Selecting circles** — every circle in the selection is drilled at its centre.

The second is the everyday case: import a drawing, select the hole circles, drill them.
Pick order is drill order.

### Helical

Cuts a hole with an **end mill** by spiralling down it, rather than plunging. Takes its
diameter from a circular path, which means it can make a hole no drill in your library
matches — and it clears chips as it goes.

> **Drilling measures depth from the surface it starts on**, like every other operation.
> For a 5 mm deep hole in the floor of a 3 mm pocket, set the start to that pocket's floor
> and the depth to `5` — the field is the depth of the hole itself. The bottom of that hole
> ends up **8 mm below the top of the stock**, which is the number to check against your
> stock thickness.

---

## Surface

Facing passes across the whole stock, to flatten a slab or true up the top before the
real work starts. Two settings — **stepover** and **angle** — and it covers the whole
workpiece rather than a path you select.

Use a large flat cutter, take a light cut, and remember the result is only as flat as
your machine is trammed.

---

## Next

- **[6. V-carving and inlay](06-vcarve-inlay.md)** — depth from geometry, and getting an inlay to seat
- **[9. Nesting](09-nesting.md)** — packing parts onto a sheet
