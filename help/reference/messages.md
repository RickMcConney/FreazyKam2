# Messages and what to do

**Where messages appear:**
- A failed Generate: in the form, above the button.
- Job warnings: in the G-code review at export.
- Import problems: at the top of the window.

## Operations

| Message | Cause | Fix |
|---|---|---|
| *Path is open — an outside profile needs a closed shape* (or inside) | Open path | Close it, or use **centerline** |
| *Path is open — a pocket needs a closed shape* | Open path | Close it, or use a centerline profile |
| *Path is open — a V-carve needs a closed shape* | Open path | Close it, or use a centerline profile with the V-bit |
| *Path is open — an inside/outside trochoidal cut needs a closed shape* | Open path | Close it, or set the cut to centerline |
| *Path is open — an inlay socket (or plug) needs a closed shape* | Open path | Close it |
| *Path has N of M subpaths open* | A stray open piece | Close it or remove it |
| *Pocket area is too small for the selected tool diameter* | Bit doesn't fit | Smaller bit |
| *Inlay socket is too small for the selected tool* | Bit doesn't fit | Smaller bit |
| *Pocket allowance collapsed the boundary* | Allowance too big | Reduce it |
| *Stepover too small* | Too many passes | Raise stepover |
| *Could not compute V-Carve medial axis* | Open or self-crossing shape | Check in point edit; try Boolean Union |
| *morph declined this shape, so auto generated it instead* | Strategy doesn't suit | Fine as is, or Alt-click Generate |
| *V-Carve requires a V-bit or taper tool* | Wrong tool type | Pick a V-bit or taper |
| *Photo V-Carve requires a V-bit tool* | Wrong tool type | Pick a V-bit |
| *3D Profile needs a ball nose, bull nose or taper tool* | Wrong tool type | Pick one |
| *Helical drilling needs an end mill — add one in the Tool Library* | No end mill | Add one |
| *Exceeds tool Max Z* | Deeper than the bit can cut | Shallower, or longer bit |
| *Peck drilling with an end mill — it must be centre-cutting to plunge* | End mill may not plunge | Use a centre-cutting bit, or Helical (Circle) |
| *Peck drilling with a ball nose* / *with a taper* | Rounded or cone-shaped bottom | Use a drill for a flat-sided hole |
| Amber ring | Something changed | Open and **Regenerate Toolpath** |
| Red ring | Generate failed | Open it and read the message |

## Over-constrained

*Over-constrained in X: … Delete one.*

Two constraints fight over one direction. Nothing moves. Delete one, or click an **X**/**Y**
label to free that direction.

## Nesting

| Message | Fix |
|---|---|
| *Nothing fits on the stock* | Smaller gap or margin, or bigger stock |
| *…or turn off "Avoid other paths"* | The sheet is already full |

## Import

| Message | Fix |
|---|---|
| *SVG import failed — no usable paths* | Convert text to outlines |
| *DXF import failed — no supported geometry* | Explode blocks |
| DXF 25.4× too big or small | Wrong units chosen. Re-import |

## Export review warnings

| Warning | Check |
|---|---|
| Failed or stale operation | Regenerate it |
| Outside the stock / past table travel / Z travel | Position and depth |
| Tool change or spindle command | Your controller may ignore it |
| Chip load out of range | Feeds and speeds |
| Spindle can't go slow enough | Metal surface speed |
| Male plug doesn't match female socket | Inlay settings |

## Wrong result

| Problem | Likely cause |
|---|---|
| Part one tool radius too small | Cut side **centerline** instead of **outside** |
| Part slightly off | Stock allowance |
| Cut too deep by the stock thickness | Z origin doesn't match how you zeroed |
| Cut in the wrong place | XY origin doesn't match |
| Hole much deeper than expected | Depth is from the start, not the stock top |
| Sim fine, cut wrong | Setup: zero, clamping, tram, bit |

## Machine connection

| Symptom | Fix |
|---|---|
| *No answer from the relay* | Check the address and [the relay](../how-to/install-the-relay.md#4-check-it) |
| Relay window downloads a file | v3: upload as `404.htm` |
| Connect is ~2 s slower than before | v4 with old `404.htm`: upload `freazyKam.html` |
| Drops every few minutes | Weak WiFi. [Fix it](../how-to/fix-wifi.md) |
| *Line too long* stops a job | Line over 127 characters. Regenerate from FreazyKam |
| Pop-up blocked | Allow pop-ups for FreazyKam |

## Still stuck

1. **Undo** (Ctrl+Z).
2. Save, then reload the page.
3. Keep the `.fkam` that shows the problem when you report it.
