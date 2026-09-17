# 8. Parametric parts

Most of the shape picker draws outlines. The bottom two rows make **parts** — a gear
with a real involute profile, an escapement whose pallets are derived from its own wheel,
a track piece that fits commercial track. They are working mechanisms described by their
engineering parameters, not pictures of mechanisms.

Three things are true of all of them:

- **They stay editable.** Every one keeps its parameters and reopens from its chip in the
  Objects strip. Change the tooth count and the gear is recut.
- **Some refuse drag-sizing.** Gear, escapement, pendulum and track are placed at the size
  their parameters give them, and draw no resize handles. A gear's size comes from module
  and tooth count; dragging cannot make one that meshes wrong.
- **Some are not outlines**, and want a particular cutter. The maze and the cutting board
  are covered below — read those before cutting one.

---

## Gear

Module × tooth count, with a **true involute profile** — the curve that makes a gear pair
transmit motion at constant ratio, rather than a rounded-tooth shape that looks like one.

| Field | Meaning |
|---|---|
| **Mod** | Module — tooth size. Pitch diameter = module × teeth |
| **N** | Tooth count |
| **Prf** | **Involute** for general work, **cycloidal** for clocks |
| **PA** | Pressure angle (involute) |
| **Pin** | Mating lantern pinion's pin count (cycloidal) |
| **Back** | Backlash — play between the flanks |
| Bore, hub, spokes | The wheel body |

The root is cut as a **hobbed trochoid** — the shape an actual hob would leave — so gears
below the classic minimum tooth count come out **undercut**, exactly as they would in
steel. A 10-tooth involute pinion is a real 10-tooth pinion with the thin roots that
implies, not an idealised drawing that would bind against its mate.

**The tooth count and pitch radius are engraved on the face.** Cut a set and you can still
tell them apart on the bench a year later.

![A 24-tooth involute gear with five spokes, engraved 24 R48 across the face](images/08-gear.png)

*A 24-tooth gear at module 4, engraved `⊙24 R48` — its tooth count and pitch radius. The
panel beside it reports pitch, base, outside and root diameters, the centre distance it
meshes at, and the play at the mesh.*

<!-- CROP · canvas region from a 2× capture, downscaled to 700 px wide/tall. -->

**Cycloidal gears emit their mating lantern pinion too** — a pinion of pins rather than
teeth, which is how clocks are built. The two are generated together because a cycloidal
wheel's face is the epicycloid of *that* pinion's pin circle: they only mean anything as a
pair.

**Either can be animated in mesh** from the panel, which runs the pair on the canvas so
you can see that they actually turn together before you cut them.

---

## Escapement

Deadbeat or recoil. The **wheel and anchor are generated together from one spec**, and
this is not a convenience — the pallet faces are loci of *this* wheel's tooth tips. An
anchor from one escapement and a wheel from another do not make an escapement.

It animates through its beat, which is the only sensible way to check one: watch a tooth
land on a locking face, the pallet lift, and the next tooth drop.

---

## Pendulum

Rod, hanging hole and bob, sized from **the beat you want**. Ask for a one-second beat and
you get a rod of the length that beats in one second.

---

## Clock

The clock is a **designer, not a shape**. Open it from the shape picker and it solves a
whole going train from one number — the beat — then emits **five ordinary shapes**, seven
with motion work: one chip each, each editable in the usual way.

Each wheel is then an ordinary shape with its own chip, editable like any other. That is
deliberate: bore, hub, spokes and markings are things a maker changes per wheel once the
train is settled, and locking them inside one object would mean opening seven forms to
change one thing. The clock keeps a chip of its own as well, which reopens the designer on
the spec every part carries — so you can go back to the train without losing the changes
you made to individual wheels.

![A solved clock train assembled and running on the canvas, with a chip for the clock and one for each wheel, anchor and pendulum](images/08-clock.png)

*A train solved for a 60:1 great wheel, assembled and running. The strip along the bottom
holds a chip for the clock itself and one for every part it emitted — six wheels, the
anchor and the pendulum — each separately editable.*

<!-- FULL APP · 1600 px wide, downscaled from a 2× capture. -->

| Group | What you set |
|---|---|
| **Pendulum** | Beat, escape-wheel teeth |
| **Going train** | Minimum pins, great-wheel period |
| **Wheels** | Max wheel diameter, tooth taper, backlash, pin diameters |
| **Hour hand** | Motion work (12:1) and its arbor spacing |
| **Weight drive** | Run time, drop, drum diameter |

**The rate has to factorise exactly.** A clock is a chain of integer tooth counts, and not
every beat can be hit exactly by whole numbers. When it can't, the panel says so **in red**
rather than quietly rounding — a clock that is 0.3% fast is a clock that loses four minutes
a day.

**There is no single module — there is one per mesh, tapering toward the escapement.**
Torque falls by the mesh ratio at every step, so the great wheel carries something like
sixty times the escape wheel's, and sizing every wheel alike would leave the drive end
weak and the escape end coarse. Set **Max wheel Ø** to what your stock can hold and the
solver sizes the train to fit it.

**The assembled clock will run on the canvas.** Use it — a train that doesn't turn on
screen will not turn in wood.

> The deep detail on gear cutting, escapement geometry and train solving lives in
> `src/shapes/CLOCKWORK.md` in the repository, if you want to know why a particular curve
> is the shape it is.

---

## Cam

An **Archimedean snail cam** with a lever — for clamps, hold-downs and lift cams. Its face
is `r = r₀ + kθ`, and that spiral is the entire point: the radius grows linearly with
angle, so the follower rises **the same amount for every degree of handle movement**. No
dead spots, no sudden grab.

Two things about the numbers:

- **Rise is stated per full revolution**, because lift per degree is a property of the
  spiral, not of how far this particular cam sweeps. What it can actually lift is
  `rise × sweep / 360`, and the panel reports that figure separately.
- **The panel reports the pressure angle**, which is what decides whether the cam holds
  what it grips or backs off under load. Watch it — it is the number that makes a cam
  clamp work or not.

---

## Cutting board

Body, juice groove, hand slots or hanging hole, with paddle, cask and carry-handle
options.

**It emits a compound path** — outline, then groove, then slots or hole — because those
want different tools and different depths. **Double-click it to split** into separate
paths, then cut each with what it needs: a profile for the outline, a core box or ball
nose for the groove, a pocket for the slots.

**The groove is a true constant-distance offset of the cutting field, not a scaled copy.**
A scaled copy is not a constant distance from the edge, and constant distance is the whole
point of a juice groove. Two consequences worth knowing: a paddle handle does not drag the
groove out along its neck, and a hand slot takes its whole end strip out of service so the
groove rings the middle and the slots sit in plain wood outside it.

Features that cannot fit are slid along until they clear, and dropped if they never do — a
missing hole is obvious on the canvas, whereas one that breaches the groove is only obvious
after glue-up.

---

## Train track

BRIO-compatible wooden railway: **straight, curved or a turnout**, cut from 12 mm stock,
with the peg-and-socket joint on whichever ends you ask for.

**The socket is derived from the peg**, not typed in next to it — you set one clearance and
both halves follow. A joint can never be left half-adjusted, which is the failure mode that
makes hand-drawn track not fit.

![A straight and a curved track piece, each with a socket at one end and a peg at the other, and rail grooves running their length](images/08-track.png)

*A straight and a 45° curve, socket at one end and peg at the other. The panel does the
arithmetic for you — chord and radii, how many make a circle, how far the peg reaches into
the socket, and how much rail is left outside the grooves.*

<!-- CROP · canvas region from a 2× capture, 1000 px wide. -->

**Grooves come out as centrelines for a 6 mm cutter**, not as outlines. Cut them with a
6 mm ball nose or core box; profiling them as outlines gives you two grooves per rail.

A track piece is a **compound path** — outline, grooves, treads. **Double-click to split
it**, then send each part to the operation it needs.

---

## Maze

A marble-run maze, and **the one shape that is not an outline at all**. It emits the
**centreline of the corridors** as open paths, because the walls are simply whatever stock
the cutter leaves standing between the grooves.

That inverts how the numbers work:

- **The groove is the corridor.** Wall thickness is `pitch − cutter diameter`, so
  **spacing is a tool constraint, not a proportion.**
- **Scaling a maze adds cells rather than thinning walls.** Make it bigger and you get
  more of the same-sized corridors — which is right, since the ball has to fit.
- **Exactly two ends reach the edge** — one entrance on the top row, one exit on the
  bottom — so there is never any doubt which end is which. Each gets a lead running clear
  of the maze, and **those leads overhang the maze's box by one pitch**, so leave room.

![A maze drawn as rounded centreline corridors rather than walls, with a lead running out of the top and the bottom](images/08-maze.png)

*Corridors, not walls. Each line is where the cutter goes; the wood left between them is
the maze. The panel states the grid it settled on — here 19 × 19 cells at an 8.33 mm pitch
— and the rule that governs it: `wall = pitch − cutter Ø`.*

<!-- CROP · canvas region from a 2× capture, downscaled to 789 px wide (capped at 700 px tall). -->

Cut it with a **ball nose** — the groove profile is what the marble rolls in — and cut it
as a groove, on the centreline. Sending a maze to a profile operation as if it were an
outline will not do anything useful.

---

## Spirograph

The hypotrochoid a real spirograph draws, with two differences from the toy:

- **Loops is a whole number and *is* the lobe count**, so every position on the slider is
  a different rosette rather than a near-duplicate.
- **Radius is the size on the stock**, not the radius of the ring it came from — so the
  pattern and the size move independently.

![A seven-lobed spirograph rosette](images/08-spirograph.png)

*Loops set to 7, and the rosette has seven lobes. Every step of the slider is a different
pattern rather than a near-duplicate of the last.*

<!-- CROP · canvas region from a 2× capture, 688 px wide (capped at 700 px tall). -->

The pen offset is not capped at the wheel's rim the way a physical set's drilled holes
are. Push it far enough and the curve passes through the centre.

---

## Next

- **[9. Nesting](09-nesting.md)** — packing parts onto a sheet
- **[10. Simulating and exporting](10-export.md)** — the review before you cut
