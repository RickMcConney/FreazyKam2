# Shapes and parts

Field names are as they appear in the Draw tab and the Properties panel.

## The shape picker

| Family | Buttons |
|---|---|
| Outlines | Rect · Round · Sign · Circle · Ellipse · Polygon · Star · Heart · Slot · Shield |
| Patterns | Spiro · Maze |
| Parts | Board · Gear · Cam · Ratchet · Escape · Pend · Track · Clock |
| Joinery | Box · Finger · Dovetail · Bowtie |

**Ignore drag-sizing:** Gear, Escapement, Pendulum, Track, Box, Finger, Dovetail, Bowtie.
**Lose their settings when rotated or stretched:** all shapes (they become plain paths).
**From centre** (under the fields): a drag grows the shape from its middle.

## Outlines and text

| Shape | Fields |
|---|---|
| Rect | Width · Height |
| Round (rounded rectangle) | Width · Height · Radius |
| Sign (inside-rounded rectangle) | Width · Height · Radius |
| Circle | **Diameter** |
| Ellipse | Width · Height |
| Polygon | Radius · Sides |
| Star | Outer R · Inner R · Points |
| Heart | Radius · Angle |
| Slot | Length · Width |
| Shield | Width · Height |
| Text | Text · Size · Font |

---

## Gear

| Field | Meaning |
|---|---|
| Module | Tooth size. Pitch diameter = Module × Teeth |
| Teeth | Tooth count (min 4) |
| Profile | **Involute** · **Cycloidal (clock)** |
| Pressure | Involute only. Pressure angle, 5–35° |
| Pins | Cycloidal only. Mating lantern pinion's pin count |
| Pin Ø | Cycloidal only. Pin diameter |
| Back cut | Cycloidal only. % relief of the flank that never drives |
| Runs | Cycloidal only. Clockwise · Anticlockwise |
| Pinion | Cycloidal only. Also draw the mating pinion |
| Bore Ø · Hub Ø · Spokes · Spoke W · Rim | Wheel body |
| Backlash | Play between the flanks |
| Count # | Engrave the tooth count |
| Pitch ○ | Engrave the pitch circle |

Properties shows pitch, base, outside and root diameters, the centre distance and the play,
and an **Animate in mesh** button.

## Clock

| Section | Fields |
|---|---|
| Pendulum | Beat (s) · Esc teeth |
| Going train | Wheels (3 or 4) · Min pins · Great (min/rev) · Max wheel Ø · Tooth taper · Backlash · Pin Ø large · Pin Ø small |
| Hour hand | Motion work · Arbor spacing |
| Weight drive | Run (h) · Drop · Drum Ø |
| Assembly | Arrange linkage · Animate whole clock · Re-lay (when editing) |

Emits one shape per wheel, the anchor and the pendulum, plus a clock chip that reopens the
designer.

## Escapement

See [Escapement settings](escapement.md).

## Pendulum

| Field | Meaning |
|---|---|
| Length | Hanging hole to bob centre. The only dimension the beat depends on |
| Rod W | Rod width |
| Bob W · Bob H | Bob size |
| Hole Ø | Hanging hole |

The panel shows the resulting beat and period in seconds.

## Cam

| Field | Meaning |
|---|---|
| Base Ø | Starting diameter of the spiral |
| Rise/rev | Rise per full turn. Actual lift = rise × sweep ÷ 360 (shown) |
| Sweep | How far round the spiral runs |
| Bore Ø | Pivot hole |
| Lever · Lever W | Handle length and width |

Profile: Archimedean spiral, r = r₀ + kθ. The panel shows the pressure angle.

## Ratchet

| Field | Meaning |
|---|---|
| Gear turns | Free direction: clockwise or anticlockwise |
| Teeth · Outside Ø · Depth · Tip R · Bore Ø | The wheel |
| Pawls · Length · Width · Pin Ø | The pawls |
| Clearance | Fit clearance |
| Cutter Ø | The bit you'll cut it with |

## Board (cutting board)

| Field | Options / meaning |
|---|---|
| Shape | Rectangle · Oval · Barrel |
| Width · Height | Board size |
| Handle | None · Paddle · Side slots · End slot |
| Edge gap | Handle slot distance from the edge |
| Hole · Hole Ø | Hanging hole |
| Groove · Inset | Juice groove and its distance from the edge |

Compound path: double-click to split.

## Track

| Field | Options / meaning |
|---|---|
| Kind | Straight · Curve · Turnout |
| Length | Straight only |
| Radius · Arc | Curve |
| Hand · Crotch | Turnout |
| End A · End B (Toe · Main · Branch on a turnout) | Socket · Peg · Square |
| Width · Gauge | Track width and rail spacing |
| Peg Ø · Neck W · Neck L | Joint size |
| Clearance | Peg-to-socket slack. The socket follows it |
| Treads · Tread pitch | Optional tread marks |

Grooves are centrelines for a 6 mm cutter. Compound path: double-click to split.

## Maze

| Field | Meaning |
|---|---|
| Width · Height | Maze size |
| Spacing | Corridor pitch. Rounds up to fit whole cells |
| Corner | Fillet radius at the bends |
| Seed | Which maze. The dice button makes a new one |
| Loops | Share of dead ends reopened into loops |

Output: open centreline paths. **Wall = pitch − cutter Ø.** One entrance top, one exit
bottom; the leads overhang by one pitch.

## Spirograph

| Field | Meaning |
|---|---|
| Radius | Size on the stock |
| Loops | Whole number = lobe count |
| Pen p | Pen offset. Can pass through the centre |

## Joinery: common fields

| Field | Meaning |
|---|---|
| Thickness | The board's real thickness (measure it). Notches are cut exactly this deep |
| Finger | Target finger width. Each edge gets an odd number as close to it as fits |
| Clearance | Gap on each side of the fit |
| Tool Ø | The bit you will cut with. Inside corners are drawn for it |
| Corners | **Dogbone** (round on the diagonal) · **T-bone** (round along the longer wall) · **None** |
| Cut | Finger and Dovetail: **Joint only** (the waste at a board's end, cut with an **inside** profile) · **Whole boards** (complete boards, cut **outside**) |

## Box

| Field | Meaning |
|---|---|
| Sizes | Width, Depth and Height are **Outside** or **Inside** sizes |
| Width · Depth · Height | Box size |
| Lid | Adds a sixth panel |
| Thickness · Finger · Clearance · Tool Ø · Corners | See common fields |

Output: five panels (six with Lid) laid out flat. The readout gives the other set of sizes
and the finger counts. Profile every panel **outside**, right through.

## Finger

| Field | Meaning |
|---|---|
| Cut | Joint only · Whole boards |
| Width | Length of the joint (the boards' width) |
| Length A · Length B | Whole boards only |
| Thickness · Finger · Clearance · Tool Ø · Corners | See common fields |

Output: **Board A** (fingers at both ends) and **Board B** (notches at both ends).

## Dovetail

| Field | Meaning |
|---|---|
| Cut | Joint only · Whole boards |
| Seam | Length of the joint |
| Panel A · Panel B | Whole boards only |
| Tails | How many |
| Tail W | A tail's wide end |
| Tail L | How far a tail reaches into the other panel |
| Angle | Flare of the tail's sides, 0–30° |
| Clearance · Tool Ø | See common fields |

Output: **Sockets** for panel B, **Tails** for panel A. Panel A must be **Tail L** longer
than its finished size.

## Bowtie

| Field | Meaning |
|---|---|
| Cut with | **Straight bit** (socket and key, rounded for the bit) · **V-bit (Inlay)** (one sharp outline for the Inlay operation) |
| Length | Across the seam |
| Width | The ends |
| Waist | The narrow middle, over the seam |
| Clearance · Tool Ø | Straight bit only. The key is the clearance smaller all round |
