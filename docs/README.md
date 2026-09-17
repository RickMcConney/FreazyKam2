# FreazyKam User Guide

FreazyKam turns a drawing into G-code your CNC router can run. It works entirely in
your browser — nothing is uploaded, nothing is installed, and your projects stay on
your own machine.

**[Launch the app →](https://rickmcconney.github.io/kam/)**

This guide is task-first: each page walks a job from start to finish. For a plain
list of everything the app can do, see the [feature list](../README.md).

---

## Start here

**[1. Quick Start — your first part](01-quick-start.md)**
Draw a coaster, pocket a recess in it, cut it out with holding tabs, simulate the
job, and export G-code. About twenty minutes, and it touches every part of the app
you will use on every job afterwards. The finished project is
[`01-circles.fkam`](01-circles.fkam).

---

## Working in the app

| | |
|---|---|
| **[2. The canvas](02-canvas.md)** | Getting around, selecting, the Properties panel, transforms, groups, constraints, the pen tool, point editing, path tools |
| **[3. Stock, origin and tools](03-stock-and-tools.md)** | Where zero is, the tool library, the two angle conventions, feeds and speeds |
| **[4. Operations](04-operations.md)** | The shape of every operation form, pick order, Start height, the Objects and Ops strips, regenerating |

## Cutting things out

| | |
|---|---|
| **[5. Cutting with an end mill](05-pockets.md)** | Profile and cut side, holding tabs, the five pocket strategies, trochoidal slotting, drilling, surfacing |
| **[6. V-carving and inlay](06-vcarve-inlay.md)** | V-carve, photo V-carve, and the geometry that makes an inlay seat |
| **[7. 3D work](07-3d.md)** | Importing an STL, placing it, roughing and finishing a relief |
| **[8. Parametric parts](08-parts.md)** | Gears, escapements, the clock designer, cams, cutting boards, track, mazes, spirographs |
| **[9. Nesting](09-nesting.md)** | Packing parts onto a sheet, and leaving the offcut as one usable piece |

## Getting it to the machine

| | |
|---|---|
| **[10. Simulating and exporting](10-export.md)** | The simulator and its readouts, post-processor profiles, the G-code review |
| **[11. When something goes wrong](11-troubleshooting.md)** | Open-path refusals, missing tools, stale operations, wrong size, wrong depth |

---

## Conventions used here

- **Millimetres are the storage unit.** The toolbar has a mm/inch toggle that changes
  what you see and type; it never changes what is stored. Switching units mid-project
  is safe, and a project saved in inches opens correctly for someone working in mm.
- **Stock** is the material on the table. **Point** is a node on a path. **Tool** is a
  cutter in the library. The app uses these words consistently, and so does this guide.
- Keyboard shortcuts are also listed in the app under the **?** button, top right.
- Screenshots are captured at a fixed viewport so they can be recaptured after a UI
  change and still line up. The rules are in [`images/README.md`](images/README.md).
