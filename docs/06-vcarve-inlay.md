# 6. V-carving and inlay

Four operations cut with a pointed tool, and all four rest on one fact: **with a V-bit,
width and depth go together.** The deeper the tip, the wider the groove. V-Carve, Photo
V-Carve and Inlay use it one way round — the width the shape needs decides how deep the
tip goes. [Fluting](#fluting) uses it the other way: you say how deep, and the groove
comes out as wide as that depth makes it.

---

## V-Carve

A V-carve makes letters and shapes look carved rather than routed. Instead of a
constant-depth pocket with vertical walls, the tool dives where the shape is wide and
lifts where it narrows — so a serif tapers to nothing and a corner comes to a crisp
point, exactly the way a hand-cut letter does.

Select closed geometry, pick a V-bit or a taper, set **Max Depth**, and generate. There
is no stepover and no strategy: the shape's own width decides the path.

![Vector lettering with the V-carve toolpath running along the centre of every stroke](images/06-vcarve-2d.png)

*The toolpath runs down the middle of each stroke, following its centreline. Where a
stroke is wide the tool goes deep; where it narrows to a serif it lifts to nothing.*

![The same lettering carved into wood in the 3D view, serifs tapering to points](images/06-vcarve-3d.png)

*The same job simulated. The letters have sloped walls and the serifs come to a point —
neither of which a flat cutter can produce.*

<!-- CROP · lettering region from two 2× captures, 1000 px wide each. -->

**Max Depth** is a limit, not a target. Most of a carve never reaches it; it stops the
tool bottoming out in the widest parts of a broad shape. If your letters come out looking
flat-bottomed and blunt, that limit is what you're hitting.

The form tells you the consequence of the number you typed — *"cuts at most 4.00 mm wide
at full depth"* for a 90° bit at 2 mm. That is the width-to-depth law stated for your
tool, and it is worth reading before you commit: if the widest part of your lettering is
narrower than that figure, nothing in the job will ever reach Max Depth at all.

Holes and counters work without being declared. The bowl of an *o*, the triangle in an
*A*, an island inside a shape — the app reads them off the geometry, the same as a
pocket does.

### Which bit

| | Cuts | Bottom of the groove |
|---|---|---|
| **V-bit** | A true point | Comes to a sharp vee |
| **Taper end mill** | A small ball ground onto a cone | Rounded |

A taper's ball tip means it can **enter a stroke narrower than itself** and leave a
round-bottomed groove instead of refusing the job, which is what makes it good for fine
lettering and small detail. A V-bit closes to a true point and is the sharper result.

Remember the two conventions from [chapter 3](03-stock-and-tools.md#the-two-angle-conventions):
a V-bit's angle is **included**, a taper's is **per side**.

---

## Photo V-Carve

Rasters a photograph as a field of V-grooves whose depth follows image brightness. Dark
areas cut deeper, and because a deeper cut with a V-bit is a *wider* cut, the dark parts
of the picture become broad grooves and the light parts fine ones. Flood the finished
board with paint and sand the face back and the image appears in the grooves.

V-bits only — the effect depends on the width-to-depth relationship of a true cone.

| Field | Meaning |
|---|---|
| **Image** | The source photograph |
| **Angle** | Direction the groove lines run |
| **Depth at white** | How deep the lightest parts cut |
| **Depth at black** | How deep the darkest parts cut |

### Depth is the resolution control

This is the part that isn't obvious. **Line spacing is not a setting** — it is the width
of the deepest groove, so that the darkest lines just touch and nothing is cut twice. So
the depth range you choose decides how many lines there are:

- **A shallower carve is a finer one** — narrower grooves, more lines, more detail, less
  contrast.
- **A deeper carve has more contrast and fewer, wider lines.**

The form shows the resulting groove width range and line count as you change the depths,
so you can trade the two off directly rather than guessing.

---

## Inlay

An inlay fits a plug of one wood into a socket cut in another, so tightly that the seam
disappears. It is two operations on two boards, and the geometry that makes it work is
worth understanding before you cut anything.

### Why V-walls

If you cut a socket with straight walls and a plug to match, the plug has to be *exactly*
the size of the hole. A thousandth too big and it won't go in; a thousandth too small and
you have a visible line all round.

Cut both with the **same V angle** and the problem goes away. The plug is a wedge, the
socket is a matching wedge, and the plug simply descends until the two wall angles meet.
Where it stops is where the fit is tight — so you make the plug deliberately *too deep*,
guaranteeing it lands on its walls and never on the floor.

![Cross-section of an assembled V-inlay: the male plug seated in the female socket, contacting on the tapered walls with a glue gap beneath and the finished face marked above](images/06-inlay-section.svg)

Three consequences follow from that picture, and they explain every field in the form:

1. **The walls are the joint.** They must be cut with the same tool angle on both halves.
2. **The floor must never touch** — that is the **Glue Gap**, and it is what gives the
   glue somewhere to go instead of holding the joint open.
3. **The face is made by planing**, not by machining. You press the plug in, let the glue
   cure, and plane or sand the assembly back to the female board's face. The seam closes
   as you approach it.

### The form

You generate the two halves **separately**, from the same drawing:

| | Cuts |
|---|---|
| **Female** | The socket — a pocket for the bulk, then V-carved walls |
| **Male** | The plug — a V-carved bevel, then a profile cutout |

| Field | What it does |
|---|---|
| **Roughing tool** | End mill that clears the bulk |
| **Finishing Tool** | V-bit or taper for sloped walls, an end mill for flat ones, or *None — roughing only* — **the same on both halves** |
| **Inlay depth** | How deep the socket goes |
| **Glue gap** | Air left under the plug |
| **Clearance** | Slack around the plug so it isn't a press fit |
| **Invert** | Which half of a nested drawing is the plug |
| **Mirror** | Male only — see below |

**Lettering is cut by size.** Small text, whose strokes the V-bit spans from edge to edge at
the inlay depth, is V-carved straight into a socket of exactly the strokes' shape. Large
text — any letter with a stroke wider than that — is cut like every other shape instead:
the end mill clears a flat floor and the V-bit forms the walls, so a big bold letter gets a
proper socket and a plug that seats.

**The female doubles as a pocket with crisp V walls.** Its V-bit never goes below the
floor: the end mill clears the floor flat, and the V-bit cuts the walls down to meet it,
going round the floor's edge at full depth and clearing the corners the end mill can't
reach. So the Female half on its own is a flat-bottomed pocket whose walls are sloped and
whose inside corners are as sharp as the V-bit can make them — handy for a recess, a
sign's lettering or a tray, with nothing to fill it.

**Invert** answers the same question as Invert Pocket: a design inside a field can be read
two ways, and only you know which wood is meant to show. The form says which reading it is
using in plain words — *"the inner shapes are the plug"* versus *"the field around the
inner shapes is the plug"* — so you can check it rather than infer it.

**Cut-out Outline** (male, on by default) frees the plug from the sheet. Generate clears
everything round the plug down to the plug depth and adds an **outside Profile right through
the stock**, run after the plug's own cuts, along the plug's cut-out line:

- **One shape** (a bowtie, an outline drawing) — the cut-out is the shape's own outline, so
  the profile goes on **the shape's own path**. Nothing new is drawn; a copy laid over the
  original would put every line on the canvas twice.
- **Lettering**, or a mirrored shape that isn't symmetric — a new path is drawn, a band
  wrapped round all of it (or the mirrored outline), and the profile goes on that. It is
  redrawn on every Generate.
- **A nested design** gets one cut-out, round the outermost shape: the inner levels stand in
  its holes on the same piece of board.

The profile is an ordinary operation: open it to add tabs (a small plug cut free at full
depth can move), or to change its depth. To use a boundary of your own instead, untick the
option, draw the boundary round the plug, select both and use **Invert** — the plug then
clears to your boundary.

**Mirror** matters because the male board gets **flipped over** to go in. If your inlay
has any handedness — lettering, a signature, anything not symmetrical — the plug must be
machined as a mirror image or it will read backwards in the finished piece. Cutting a
mirrored inlay the wrong way round is the mistake that costs a board.

### Use a V-bit, not a taper

A cone is its own mirror image, so a V-bit plug and its socket close completely.

A taper cannot. Its ball rounds the foot of the plug wall — the plug's *widest* end —
while the socket's rounding sits at its *narrowest*, the deep end. Flip them together and
those two roundings don't meet at the finished face. The result is a hairline gap right
where you'll be looking at it, up to the tip radius wide: about 0.20 mm for a 0.25 mm tip,
0.30 mm for a 0.5 mm tip.

The angle makes no difference — a taper at 20° and at 60° gives the same gap. The plug
still *seats* perfectly well; it just leaves a visible line. The form says so on the tool
row.

> **This is geometry, not a defect.** If you want a taper's fine detail somewhere, use it
> for the V-carving in [that](#v-carve) chapter section and keep a V-bit for inlay walls.

---

## Fluting

**Fluting** carves along a line — the flutes down a column or a table leg, a groove that
swells from nothing to full depth and fades out again — with the depth set by a **height
profile** you draw. The tool runs on the line itself, as a centerline cut, and only Z
changes as it goes. Select one or more paths (open strokes are the usual case; a closed
one works too) and open **CAM Operations → Fluting**.

![Three straight strokes on the stock with the Fluting form open beside them: a 60° V-bit, 4 mm depth, the groove 4.62 mm wide at full depth, and the Height Profile graph — four points, in from the surface to full depth by 20 % and back out from 80 %, the cut shaded under the curve](images/06-fluting.png)

<!-- FULL APP · 1600 px wide. npm run shots -- 06-fluting -->

| Field | What it does |
|---|---|
| **Tool** | A **V-bit** or **taper** cuts a V-groove; a **ball nose** cuts a round-bottomed flute. A flat end mill is not offered — it would leave a step wherever the depth changes |
| **Depth** | The deepest the flute goes. The profile is drawn as fractions of it, so changing the depth deepens the whole flute without changing its shape. The line under it gives the groove's width at full depth |
| **Step Down** | Depth per pass. Each pass follows the profile but goes no deeper than its level, so no pass takes more than one step anywhere |
| **Height Profile** | The groove's depth along the path. Left is the path's start, right its end; the top edge is the surface and the bottom full depth. The shaded area is what the tool takes out |
| **Points** | How many breakpoints the profile has. Changing it re-spaces them evenly and keeps the shape already drawn |
| **Point N at / Depth** | The selected point's position along the path (%) and depth, to type exact values |
| **Smooth** | A curve through the points instead of straight lines between them. It never goes deeper than the deepest point or higher than the shallowest, so it cannot overshoot |
| **Reverse** | Starts the profile at the path's end instead of its start |

**Drag the points** to shape the flute. The two ends move only up and down; the points
between move anywhere between their neighbours. A dragged point snaps to the surface, to
full depth and to the depth of the point on either side, which makes a level run easy to
get. Click a point to select it, then type its exact position and depth underneath.

**One profile fits every path.** It is stretched over each path's own length, so the same
settings flute a short stroke and a long one alike. A compound path takes the whole
profile over each of its parts.

**Which end is the start** depends on how the path was drawn. It only matters for a
profile that isn't symmetrical — deep at one end, fading at the other. If it comes out the
wrong way round, tick **Reverse** rather than redrawing anything.

![The three flutes carved into maple in the 3D view, each swelling from a point at its ends to full width in the middle](images/06-fluting-3d.png)

*The default profile: in from nothing to full depth over the first fifth of the path, level
through the middle, and out again over the last fifth.*

<!-- CROP · 3D view from a 2× capture. npm run shots -- 06-fluting-3d -->

An open stroke is cut there and back, so the tool is already where the next pass starts
and never lifts between passes; a closed path goes round the same way every time. Where
the profile drops steeper than 45° the tool goes straight down at the plunge feed rather
than diving along the slope at the cutting feed.

---

## Next

- **[7. 3D work](07-3d.md)** — carving a relief from an STL or a depth-map image
- **[10. Simulating and exporting](10-export.md)** — checking a job before you cut it
