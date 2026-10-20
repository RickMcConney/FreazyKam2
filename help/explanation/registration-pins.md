# Registration pins: putting a board back exactly

A double-sided or tiled job takes the board off the machine and puts it back. The second
cut has to line up with the first to a fraction of a millimetre, and the board's own
edges can't be trusted for that: they are rarely straight or square. So the board is
located by **dowel pins** fixed in the spoilboard, and **holes** in the board that drop
onto them.

## Why two pins of different sizes

One pin lets the board turn round it. Two pins fix it — but **two pins the same size fix
it two ways**. Turn the board round, or flip it the wrong way, and the holes are still the
same distance apart, so the board still drops onto the pins, slid along by however far the
holes were from the middle.

Every one of those wrong ways **swaps the two holes end for end**. Make one pin bigger than
the other and the big pin meets the small hole: the board won't go on. So there's only one
way it fits, and that's the right one.

A third pin, spaced unevenly, would do the same — but it's one more hole in the middle of
the board, where the parts are. Two sizes keeps the pins at the ends.

## Why they sit on the flip axis

Turning a board over about a line leaves every point **on that line** where it was. Put the
pins on the flip axis and the holes drilled on side A are still over the pins after the
flip. Anywhere else, the holes would land somewhere new.

## Why side B is drawn mirrored, but cut as drawn

After the flip, the board's left is your right. Side B's sheet shows the board that way,
so you draw side B as you'll see it, and its toolpaths are made directly from that. The
app never makes side B by mirroring side A's toolpaths: a mirror turns a
[climb cut into a conventional one](climb-vs-conventional.md).

## Why each tile drills the next tile's holes

On a tiled job the pins stay put and the board moves. Each tile drills the holes the
**next** tile will sit on, before the board moves — so those holes are exactly one tile
further along, measured by the machine itself. Slide the board until they drop onto the
pins and the next tile carries on precisely where the last one stopped.

The first tile drills its own pair right through into the spoilboard. Those spoilboard
holes are where the pins go.

## Why the holes are bored, not pecked

A peck drill makes a hole the size of the bit. Peck both holes with one bit and they come
out the same size, which undoes the whole point. Boring helically with an end mill makes
each hole its own size.

**Related:** [Cut both sides of a board](../how-to/cut-both-sides.md) ·
[Cut a board longer than your machine](../how-to/cut-a-long-board-in-tiles.md)
