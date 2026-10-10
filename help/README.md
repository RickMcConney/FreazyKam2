# FreazyKam Help

FreazyKam turns a drawing into G-code for your CNC router. It runs in your browser.
Nothing to install, nothing uploaded.

**[Launch the app →](https://freazykam.com/app/)**

---

## New here?

**[Make your first part](tutorials/01-first-part.md)**: a coaster, from a blank screen to a
G-code file, in about 10 minutes.

---

## Find what you need

| I want to… | Go to |
|---|---|
| **Learn** the app step by step | [Tutorials](#tutorials) |
| **Get a job done** right now | [How-to guides](#how-to-guides) |
| **Look up** a setting, a tool type or a message | [Reference](#reference) |
| **Understand** why something works the way it does | [Explanations](#explanations) |
| **Read** the full manual, chapter by chapter | [User guide](../docs/README.md) |

---

## Tutorials

Follow these from start to finish. Each one makes one thing.

1. [Make your first part](tutorials/01-first-part.md): a coaster with a recess and tabs
2. [Carve a picture in 3D](tutorials/02-carve-a-picture.md): a relief plaque from a greyscale image
3. [Run your first job on the machine](tutorials/03-first-cut.md): FluidNC over WiFi

## How-to guides

Short steps for one task.

**Set up**
- [Set up your stock](how-to/set-up-your-stock.md)
- [Set your work origin (X0 Y0 Z0)](how-to/set-your-work-origin.md)
- [Add a tool](how-to/add-a-tool.md)
- [Import a maker's tool catalogue](how-to/import-a-tool-catalogue.md)
- [Tune feeds and speeds for your machine](how-to/tune-feeds-and-speeds.md)
- [Move your settings to another computer](how-to/move-your-settings.md)

**Draw**
- [Draw a shape](how-to/draw-a-shape.md)
- [Import a drawing or model](how-to/import-a-file.md)
- [Select exactly what you want](how-to/select-things.md)
- [Move, resize and rotate](how-to/move-resize-rotate.md)
- [Group parts together](how-to/group-parts.md)
- [Keep a part a set distance from another](how-to/use-constraints.md)
- [Draw with the pen](how-to/draw-with-the-pen.md)
- [Edit points on a path](how-to/edit-points.md)
- [Combine, offset, pattern and round shapes](how-to/use-path-tools.md)
- [Copy parts between projects](how-to/copy-between-projects.md)

**Cut**
- [Cut out a part](how-to/cut-out-a-part.md)
- [Add holding tabs](how-to/add-holding-tabs.md)
- [Clear a pocket](how-to/clear-a-pocket.md)
- [Cut a slot](how-to/cut-a-slot.md)
- [Drill holes](how-to/drill-holes.md)
- [Flatten your stock](how-to/flatten-your-stock.md)
- [V-carve lettering](how-to/v-carve-lettering.md)
- [Carve a photo](how-to/carve-a-photo.md)
- [Make an inlay](how-to/make-an-inlay.md)
- [Carve a 3D model (STL)](how-to/carve-a-3d-model.md)
- [Cut into the floor of a pocket](how-to/cut-into-a-pocket-floor.md)
- [Change the cut order](how-to/change-the-cut-order.md)
- [Add or remove paths from an operation](how-to/edit-an-operation.md)
- [Nest parts on a sheet](how-to/nest-parts.md)

**Make parts**
- [Make a gear](how-to/make-a-gear.md)
- [Design a clock](how-to/design-a-clock.md)
- [Make a cutting board](how-to/make-a-cutting-board.md)
- [Make train track](how-to/make-train-track.md)
- [Make a marble maze](how-to/make-a-marble-maze.md)

**Check and export**
- [Simulate a job](how-to/simulate-a-job.md)
- [Export G-code](how-to/export-g-code.md)
- [Set up your post-processor](how-to/set-up-your-post-processor.md)
- [Save and reopen a project](how-to/save-a-project.md)

**Run the machine (FluidNC)**
- [Install the relay file (once)](how-to/install-the-relay.md)
- [Connect to your machine](how-to/connect-to-your-machine.md)
- [Home and zero](how-to/home-and-zero.md)
- [Find Z with a touch plate](how-to/probe-z.md)
- [Jog the machine](how-to/jog-the-machine.md)
- [Turn the map to match where you sit](how-to/rotate-the-map.md)
- [Send and run a job](how-to/run-a-job.md)
- [Pause, stop or end a job early](how-to/stop-a-job.md)
- [Change speed during a job](how-to/use-overrides.md)
- [Save G-code as a macro](how-to/use-macros.md)
- [Fix a weak WiFi link](how-to/fix-wifi.md)

## Reference

Facts in tables. For looking things up, not reading through.

- [The screen](reference/screen.md)
- [Keyboard and mouse](reference/keyboard-and-mouse.md)
- [Operations and their settings](reference/operations.md)
- [Tool types and the tool table](reference/tools.md)
- [Materials and machine rigidity](reference/materials-and-machine.md)
- [Chip load and feeds](reference/chip-load.md)
- [Shapes and parts](reference/shapes.md)
- [Escapement settings](reference/escapement.md)
- [Post-processor settings](reference/post-processor.md)
- [Machine tab controls](reference/machine-tab.md)
- [File formats](reference/file-formats.md)
- [Messages and what to do](reference/messages.md)
- [Glossary](reference/glossary.md)

## Explanations

The "why" behind the app, for when you want to work things out yourself.

- [Where zero is, and how depth is measured](explanation/zero-and-depth.md)
- [Cut side: why parts come out the wrong size](explanation/cut-side.md)
- [Open and closed paths](explanation/open-and-closed-paths.md)
- [Climb vs conventional milling](explanation/climb-vs-conventional.md)
- [Chip load: why slower can be worse](explanation/chip-load.md)
- [The five pocket strategies](explanation/pocket-strategies.md)
- [How V-carving works](explanation/v-carving.md)
- [Why inlays fit](explanation/inlays.md)
- [How 3D carving works](explanation/3d-carving.md)
- [Operations, the program and stale toolpaths](explanation/operations.md)
- [Nesting for a usable offcut](explanation/nesting.md)
- [How an escapement works](explanation/escapement.md)
- [Gears and clock trains](explanation/gears-and-clocks.md)
- [Why the machine needs a relay file](explanation/relay.md)
- [What a simulation can't tell you](explanation/simulation-limits.md)

---

**Units:** the app stores everything in millimetres. The **mm / in** button in the toolbar
only changes what you see and type, so you can switch at any time.
