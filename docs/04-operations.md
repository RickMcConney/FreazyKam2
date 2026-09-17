# 4. Operations

An **operation** is one toolpath: a tool, a piece of geometry, a depth, and the settings
that decide how the cutter gets from one to the other. A job is a list of them, run in
order.

This chapter is about the parts every operation shares — the shape of the forms, how the
program is ordered, where a cut starts in Z, and what happens when you change something
after the fact. The individual operations get their own chapters.

---

## The shape of an operation

Every operation is made the same way:

1. **Select the geometry** on the canvas.
2. **Click the operation** in the sidebar's Draw tab.
3. **Fill in the form** — it replaces the menu.
4. **Press Generate Toolpath.**
5. **Close the form** with the **×** to get the menu back.

The toolpath appears on the canvas and a chip appears in the **Ops** strip. Nothing is
committed until you press the button: changing a field doesn't alter an existing
toolpath, and closing the form without pressing it leaves things as they were.

### Fields you'll meet everywhere

| Field | What to know |
|---|---|
| **Tool** | Lists only the tool *types* this operation can use (see [chapter 3](03-stock-and-tools.md#type-decides-where-a-tool-can-be-used)) |
| **Start** | Where in Z the cut begins — see [below](#start-height) |
| **Depth** | Total depth of the cut, measured **down from the start height**, not from stock top |
| **Step down** | How much each pass takes. Left alone it is derived from the tool, material and rigidity, and snapped to a whole division of the depth so the last pass isn't a sliver |
| **Direction** | **Climb** or **conventional** |
| **Stock allowance** | Material left on the wall for a finishing pass. Negative cuts *past* the line |
| **Ramp in** | Enters on a slope over 2× the tool diameter at 50% feed, instead of plunging straight down |

**Climb vs conventional**: climb is the normal choice on a router in wood — the chip
starts thick and ends thin, which leaves a cleaner edge and pushes the cutter away from
the work. Conventional suits a machine with backlash it can't take up, or a material that
tears out on the way in.

### Depth is how far below the start, not a Z position

**Depth is the depth of this cut**, measured down from wherever it starts. It is not the
distance from the top of the stock, unless the cut happens to start there.

Engraving 1 mm into the floor of a 3 mm pocket:

| | |
|---|---|
| Start | *Floor of the pocket* — resolves to Z −3 |
| Depth | `1` — one millimetre of engraving |
| Result | The engraved floor sits at **Z −4**, 4 mm below the top of the stock |

So the number you type is how much material *this* operation removes. To know where the
cut ends up, add it to the start: the form shows the resolved `Z` beside the Start label
for exactly that reason.

Type `4` here instead and you would cut 4 mm below the pocket floor — a 7 mm deep hole
in a 12 mm board.

---

## Adding and removing paths without starting over

Missing one hole from a set of drilled holes used to mean deleting the operation and
doing it again. It doesn't:

**While a form is open, shift-click on the canvas adds a path to the batch or takes one
away.** The chips at the foot of the form show what's pending — new ones marked as added,
removed ones struck through — and pressing **Regenerate** applies it.

Two things protect you here. Nothing follows the selection on its own; only the button
writes. And clicking empty canvas — which clears the selection — does *not* mean "remove
everything", so the commonest misclick in the app costs nothing.

What a shift-clicked path becomes depends on the operation. For profile, trochoidal and
drilling, one path is one operation, so adding a path adds an operation. For pocket and
V-carve, which hold a boundary *and* its islands, the app re-reads the geometry: a path
added **inside** an existing pocket becomes an **island** of it rather than a new pocket.

---

## Pick order is cut order

**Operations run in the order they were created, and nothing re-sorts them.** Click
circle 1, then 2, then 3, generate a drilling operation, and the machine drills them 1,
2, 3. The path chips at the foot of the form are numbered in that order, so it's visible
before you commit rather than discoverable in the G-code.

Two things deliberately keep their own order: the holes *within* a single path — a ring
of pin holes was picked as a ring, not as eight picks, so the travel optimiser is free to
re-order them — and a rubber-band selection, which has no pick order to record.

---

## Start height

Operations don't have to start at the top of the stock, and the **Start** control is how
you say so. It stores a **reference, not a number**, so it re-resolves every time the
operation regenerates. Deepen the pocket and the lettering in its floor follows it down.

| Option | Means |
|---|---|
| **Auto (from earlier cuts)** | Reads the surface earlier operations left over this operation's footprint, and takes the **highest** remaining material |
| **Stock top** | Pin it to Z 0 |
| **Floor of *&lt;operation&gt;*** | Follow one named operation's floor, whatever depth it ends up at |
| **Custom…** | Type a Z yourself |

**Auto is the right default and it is deliberately conservative.** It takes the highest
remaining material over the footprint, so if any part of the cut hangs over uncut stock
it stays at the top. Reading too high costs an air pass; reading too low is a crash. The
line under the control tells you what it decided and why — *"nothing cut here yet"* means
no earlier cut overlaps this one, *"reaches uncut stock"* means one does but this cut
extends past its edge.

**Custom is the one with no safety net.** The app warns you: *nothing checks this — over
uncut stock the first pass cuts full depth.*

---

## The two strips

The bar under the canvas has two tabs. They look alike and they are not the same thing.

### Objects — the document

One chip per thing in the project. The two circles, the tabs, a boolean, a pocket.
Clicking a chip selects what it stands for and reopens the editor that made it: a gear
chip its module and tooth count, a pocket chip its depth. Editing changes that chip
rather than adding another, and deleting the chip deletes the thing.

A whole Generate is **one** chip. Profiling five paths makes five operations but was one
decision, so it edits as one.

### Ops — the program

One chip per operation, **in the order the machine runs them**, which is the order they
are written to G-code. This is the strip to check before exporting.

| Control | Does |
|---|---|
| Drag a chip | Reorder — this changes the program |
| Drag a run header | Move that whole tool's block at once |
| Hover → eye | Hide. **A hidden operation is left out of exported G-code** |
| Hover → × | Delete |
| Click | Select the paths the operation was made from and reopen its form |

The chip's ring tells you its state: **amber** means it needs regenerating, **red** means
it failed, a spinner means it's still working. Hovering says what's wrong.

### Tool changes

Operations sharing a tool are drawn as one coloured band with a marker at each tool
change, and the counter at the right reads `N ops · N TC`.

The ops list is flat and new operations append to it, so a program can easily read
A, B, A — three tool changes, two of them avoidable. When that happens, a **−N TC**
button appears. Press it and each tool's operations are gathered together, keeping the
order the tools first appear and the relative order within each tool. It is one explicit,
undoable edit, so the order in your G-code is always one you chose.

> Grouping by tool is not always what you want. Cutting a part free before pocketing it
> is fewer tool changes and a worse idea. Look at the order it proposes before pressing
> it, and remember what the coaster taught: inside features first, outline last.

---

## When something changes underneath

Edit a path, change the stock, or move an operation that another one sits on, and any
operation affected is marked **needs-update** — an amber ring on its chip, and a count in
the strip's status area.

The app doesn't silently regenerate. A toolpath you haven't looked at is worse than an
obviously stale one, and regenerating can take real time on a complex pocket. Open the
operation and press **Regenerate Toolpath** when you're ready.

**The export review counts stale operations as a warning**, so a job can't quietly go to
the machine with a toolpath that no longer matches its geometry.

### When a Generate fails

The reason appears in the form, directly above the button, where it can be fixed.

- **An operation that click created is removed again.** A chip claiming a cut that
  doesn't exist is worse than no chip at all.
- **An operation that already existed keeps its slot and its error.** Deleting your work
  because a re-Generate failed would be the worse of the two mistakes — fix the setting
  and press the button again.

The commonest causes are an open path where a closed one is needed, geometry too small
for the selected tool, and a depth the tool can't reach. [Chapter 11](11-troubleshooting.md)
goes through them.

---

## Next

- **[5. Profiles and pockets](05-pockets.md)** — cut side, tabs, and the five pocket strategies
- **[10. Simulating and exporting](10-export.md)** — the preflight review and post-processors
