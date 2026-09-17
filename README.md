# FreazyKam

**Browser-based CNC CAM application for makers, woodworkers, and hobby CNC users.**

[**Launch App →**](https://rickmcconney.github.io/kam/) · [**User Guide →**](docs/README.md)

If you find it useful, please ⭐ star the repo — it's the only way I know anyone is using it.

---

## What It Does

FreazyKam runs entirely in your browser — no account, no server, no install. You design or import 2D vector geometry, configure your tool library and workpiece, generate CNC toolpaths, preview the simulation, and export machine-ready G-code.

![Design view — canvas, operation forms, and the objects / operations strips](screen%20shots/design.png)

*Designing and generating toolpaths. The strip along the bottom switches between **Objects** (everything in the document, one chip each) and **Ops** (every toolpath, in the order the machine runs it).*

![3D simulation — material removal against the workpiece](screen%20shots/3d%20sim.png)

*The 3D view simulating material removal, with the carved surface updating as the tool cuts.*

![Photo V-Carve — a photograph rastered as V-grooves](screen%20shots/photo%20vcarve.png)

*A photograph carved as V-grooves whose depth follows image brightness. The 3D view renders the cuts dark, the way the finished board looks once paint is flooded over it and sanded back off the face.*

---

## Features

### Design Import
- **SVG** — paths, shapes, groups, nested transforms, real-world dimensions
- **DXF** — LINE, LWPOLYLINE, ARC, CIRCLE, SPLINE, ELLIPSE entities; prompts for units when missing
- **STL** — binary and ASCII for 3D surface machining workflows
- **Images** — PNG, JPEG, WebP as canvas references, or as the source for a photo V-carve
- **G-code** — `.gcode`, `.nc`, `.ngc`, `.tap` for inspection and simulation

### Drawing Tools
- **Shapes** — rectangle, rounded rect, sign (inner-rounded), circle, ellipse, polygon, star, heart, slot, shield
- **Spirograph** — the hypotrochoid a real spirograph draws. **Loops** is a whole number and *is* the lobe count, so every position on the slider is a different rosette. **Radius** is the size on the stock, not the ring it came from, so pattern and size move independently. The pen offset isn't capped at the wheel's rim the way a physical set's drilled holes are — push it far enough and the curve passes through the centre. Re-editable from its chip
- **Parametric mechanisms** — every one is a real part, not a lookalike, and stays editable from its own chip:
  - **Gear** — a true involute profile (or cycloidal, for clock work) with a hobbed trochoidal root that undercuts below the classic tooth-count limit. Module × teeth, bore, hub, spokes, backlash; pitch radius and tooth count engraved on the face. Cycloidal wheels emit the mating lantern pinion too, and either can be **animated in mesh** to check the pair actually runs
  - **Escapement** — deadbeat or recoil, wheel and anchor generated together from one spec (the pallet faces are loci of this wheel's tooth tips, so the two halves only mean anything as a pair). Animates through its beat
  - **Pendulum** — rod, hanging hole and bob, sized from the beat you want
  - **Cam** — Archimedean snail cam with a lever, for clamps and hold-downs; lift is linear in handle angle, and the panel reports the pressure angle that decides whether it holds what it grips
  - **Cutting board** — body, juice groove, hand slots or hanging hole, with paddle/cask/carry handle options; the groove is a true constant-distance offset of the cutting field, not a scaled copy
  - **Train track** — BRIO-compatible wooden railway: straight, curved or a turnout, cut from 12 mm stock, with the peg-and-socket joint on whichever ends you ask for. The socket is *derived* from the peg plus clearances, so a joint can never be left half-adjusted. Grooves come out as centrelines for a 6 mm cutter
  - **Maze** — a marble-run centreline, emitted as grooves for a ball-nose cutter rather than as an outline. Exactly one entrance and one exit reach the edge, so there is no doubt which end is which, and each gets a lead running clear of the maze
- **Clock** — a whole going train solved from one number: the beat. Pendulum length, an exact wheel/pinion factorisation for the rate (said in red rather than rounded when no exact train exists), optional 12:1 motion work, and the drive wheel's run time. Every wheel comes out as an ordinary editable shape, and the assembled clock will **run on the canvas**
- **Text** — vector text paths via opentype.js; choose from bundled or web fonts, edit the text and font of an existing object at any time
- **Pen tool** — click for straight segments, click-drag for Bezier curves; Escape to finish open path, click near first node to close
- **Point editing** — double-click any path; drag anchors and handles, click segment to insert, hover + Delete to remove

### Object Editing
- Move, scale (uniform and non-uniform), rotate with on-canvas handles
- Boolean operations: union, intersection, subtract
- Offset tool: inset/outset with round, miter or square corners — re-editable from its chip
- Corner treatment: outer radius, inner radius, chamfer, dogbone
- Linear and circular pattern tools — also re-editable from their chip
- **Nesting** — packs the selected parts onto the stock with the least waste. Set the gap, edge margin, rotation step and which edge to pack from, so the offcut is left as one usable strip rather than scattered. Small parts drop into the holes of larger ones, unselected paths can be treated as ground already taken, and anything that won't fit is parked clear of the stock. **Fill stock with copies** repeats a single part until no more fit
- **Constraints** — hold one part a stated distance from another and keep it there as either is edited. Press **C**, click a point on one part (corner, edge midpoint, centre, or the centre of a round feature), then a point on another — or *drag* the second part into place with the dimension reading out live, and let go where you want it. Numbers are measured in the first part's own frame, so four holes 10 mm in from the corners of a plate stay 10 mm in from the corners when the plate is resized *or rotated*; the second part can be held at its angle to the first as well, so a slot turns with the plate it sits in. Parts can also be held off an edge of the stock, which is ground and wins over a drag. There is no root — drag any part of a chain and the rest follow — and a contradiction is reported rather than half-applied
- Holding tabs: configure count, length, height; drag individual tabs along path
- Group / ungroup (`Ctrl+G` / `Ctrl+Shift+G`) — groups nest, and Alt-click reaches a single path inside one
- Copy and paste paths between projects (`Ctrl+C` / `Ctrl+V`) — a pasted gear is still a gear, with its parameters, corner treatments and grouping intact
- Undo/redo for everything

### Objects & Operations

The bar under the canvas holds two strips. They look alike, but one is the **document** and the other is the **program**.

**Objects** is everything in the project, one chip per thing. Click a chip to select what it stands for and reopen the editor that made it: a gear chip its parameters, a boolean chip its union/subtract, a pocket chip its depth. Editing changes the chip rather than adding another; deleting the chip deletes the thing. A group is one chip, and so is a whole Generate — profiling five paths makes five operations but was one decision, so it edits as one. Tabs and corner treatments get their own chips, attached to the path they belong to.

**Ops** is the program: one chip per toolpath, in the order the machine runs them, which is the order G-code is written in. Operations sharing a tool are drawn as a coloured band with a marker at every tool change. Drag a chip — or a whole band — to reorder. When the program visits a tool more than once, a **−N TC** button gathers that tool's operations into one step so you load it once. Hover a chip to hide it (hidden operations are left out of exported G-code) or delete it.

Undo and redo cover every edit and are independent of both strips; undo history is per session.

### Tool Library

A library of cutters, saved with the project and kept in the browser between sessions. Each row holds diameter, flute count, RPM, feeds and the tool's maximum depth of cut; an operation only offers the tools that can actually make its cut.

| Tool | Defined by | Available to |
|---|---|---|
| End mill | Diameter | Profile, pocket, trochoidal, surfacing, helical drilling |
| Ball nose | Diameter | Profile, pocket, trochoidal, 3D profile |
| V-bit | Diameter + **included** angle | V-carve, photo V-carve, inlay walls, profile |
| Taper end mill | **Tip** diameter + **per-side** angle + usable length | V-carve, inlay walls, 3D profile, profile |
| Drill | Diameter | Peck drilling |

A **taper end mill** is a V-bit with a ball ground on its tip, described the way the bits are sold: the diameter column is its *tip ball*, and the angle is *per side* where a V-bit's is included. The library derives how wide it opens out — a 5°/side taper on a 1 mm tip reaches Ø5.29 mm at 25 mm deep. Its ball tip can enter a stroke narrower than itself, cutting a round-bottomed groove rather than refusing it, which is what suits it to fine lettering and 3D finishing. In an inlay a V-bit still closes tighter: a taper's rounded foot leaves a hairline gap at the finished face.

### CAM Operations
| Operation | Description |
|---|---|
| Profile | Inside / outside / centerline cut, climb or conventional, ramp-in, holding tabs |
| Pocket | Five clearing strategies (below), island support, finish allowance, ramp-in |
| Trochoidal | Low-engagement slotting with configurable step and loop radius, optional finishing pass |
| Drill | Peck drilling at placed points or helical drilling from circular paths |
| Surface | Full-workpiece facing passes |
| V-Carve | Medial-axis depth from V-bit or taper geometry, island/letter-hole support |
| Photo V-Carve | Rasters a photograph as V-grooves whose depth tracks image brightness (V-bit only) |
| Inlay | Female socket (pocket + V-carved walls) and male plug generation |
| 3D Profile | Raster surface following from imported STL with a ball nose or taper, optional roughing pass |

**Pocket strategies**

| Strategy | Best for |
|---|---|
| Auto | Mixed pockets — rasters the open ground, contours around islands, adaptive on the junctions between them. Picks the pass angle per area unless you pin it |
| Raster | Simple open pockets; straight parallel passes at any angle |
| Contour | Concentric offsets following the boundary, so walls and islands are traced |
| Morph | A single continuous spiral morphed between the boundary and the interior |
| Adaptive | Constant tool engagement — heavier depth of cut at lower load, best for harder material and deeper pockets |

Any pocket also gets a **rest-clearing pass**: stock a strategy's passes couldn't reach is cut after them and before the wall pass, so it's a light skim rather than a full-width plunge.

### Start Height

Operations don't have to start at the top of the stock. Engraving letters in the floor of a 2 mm pocket starts 2 mm down, and the **Start** control resolves that for you — it stores a *reference*, not a number, so it re-resolves every time the operation regenerates:

- **Auto** (default) — reads the surface earlier cuts left over this operation's footprint, taking the *highest* remaining material so the tool never starts inside solid stock. If any part of the footprint sits over uncut stock, it stays at the top
- **Stock top** — pin it to Z 0
- **Floor of \<operation\>** — follow a named operation, so changing that pocket's depth moves this cut with it
- **Custom** — an explicit Z

Depths are always measured *from* the start surface, and the tool-reach and past-stock-bottom warnings account for the total. Change a pocket's depth, reorder operations, or move the path a pocket is built on, and anything sitting on that floor is flagged as needing regeneration.

### Feeds, Speeds & Step-Down
- **Auto feed & speeds** — cutting feed, plunge feed, spindle RPM, and step-down computed automatically from material, tool geometry, and machine rigidity
- **Material library** — each material carries a hardness factor that drives the chip-load target
- **Machine rigidity** (1–5) — scales the feed and depth of cut for your machine, from light hobby gantry to rigid industrial
- **Smart spindle RPM** — when the machine can't feed fast enough to hold the target chip load, the spindle is slowed instead of overloading the tool (with a warning emitted in the G-code if you have no spindle control)
- **Whole-division step-down** — depth of cut is snapped to an even division of the total cut depth, capped by tool diameter
- **Max feed ceiling** — a hard limit that generated feeds never exceed, honored even when auto is off
- Toggle off to use each tool's own stored feeds and speeds instead

### Preview & Simulation
- **2D simulation** — play, pause, stop, speed control, seek slider, current G-code line, Z depth, elapsed/total time
- **Chip-load gauge** — live feed-per-tooth readout during steady cutting, color-banded against the target for your machine rigidity, with feed/RPM/flute suggestions to hit the sweet spot
- **3D view** — orbit, pan, zoom; workpiece box with material appearance; toolpath visualization; material removal animation
- **G-code viewer** — line-synchronized highlight during simulation

### Export
- G-code export with configurable post-processor profiles
- Built-in profiles for Grbl (mm and inches), grblHAL, LinuxCNC, Mach3, UCCNC and a generic controller; add your own with placeholders for `{x}`, `{y}`, `{z}`, `{f}`, `{s}`
- Pre-export preflight: cut-time estimate, and warnings for anything that would surprise you at the machine
- Arc output (G2/G3) optional per profile
- Separate G-code unit mode (mm or inches) independent of display units
- **SVG export** of the selection or the whole drawing — round-trips through this app's own importer with the stock as the page, so a path exported at (120, 40) comes back at (120, 40)
- Saves as `.fkam` project files (JSON) — geometry, operations, tool library and workpiece, every generated object keeping the parameters it was made from so it stays editable after a reload

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd+S` | Save project |
| `Ctrl/Cmd+O` | Open project |
| `Ctrl/Cmd+N` | New project |
| `Ctrl/Cmd+Z` | Undo |
| `Ctrl/Cmd+Y` / `Ctrl/Cmd+Shift+Z` | Redo |
| `Ctrl/Cmd+D` | Duplicate selected |
| `Ctrl/Cmd+C` / `Ctrl/Cmd+V` | Copy / paste paths, including between projects |
| `Ctrl/Cmd+G` / `Ctrl/Cmd+Shift+G` | Group / ungroup selected |
| `Delete` / `Backspace` | Delete selected |
| `C` | Constrain tool — hold one part relative to another |
| `S` | Toggle snap to grid |
| `Space` | Play / pause simulation |
| `Escape` | Cancel pen drawing / exit point edit |

---

## Tech Stack

Vite · React 19 · TypeScript · Konva.js · Three.js · Zustand · Tailwind CSS  
Clipper2-ts (offset/polygon ops) · polygon-clipping (boolean ops) · JSPoly (medial axis for V-carving) · opentype.js (text) · dxf-parser

Toolpath generation runs in a Web Worker, so the interface stays responsive while a slow strategy computes.

---

## Running Locally

```bash
npm install
npm run dev        # dev server with hot reload
npm run build      # type-check + production build
npm run preview    # serve production build locally
npm run test:run   # unit tests (Vitest)
```

No backend required. All data stays in your browser.
