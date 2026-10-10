# Operations and their settings

Field names are as they appear in each form.

## Common fields

| Field | Meaning |
|---|---|
| **Tool** | Only tool types that suit the operation are listed. **Browse library…** finds others |
| **Start** | Where in Z the cut begins: **Auto (from earlier cuts)**, **Stock top**, **Floor of** *operation*, **Custom…** |
| **Depth** | How far below the **start** to cut |
| **Step Down** | Depth per pass. Auto-set from tool, material and rigidity when Auto Feeds is on |
| **Direction** | **climb** or **conventional** |
| **Stock Allowance** | Material left on the wall. Negative cuts past the line |
| **Ramp In** | Enters on a slope (2× tool diameter, 50 % feed) instead of plunging |

## Which operation

| Operation | Does | Needs | Tools offered | Has Start |
|---|---|---|---|---|
| [Profile](#profile) | Cuts along a line | Any path (open = centerline only) | End mill, bull nose, ball nose, V-bit, taper | ✓ |
| [Trochoidal](#trochoidal) | Cuts a slot in loops | Any path (open = centerline only) | End mill, bull nose, ball nose | — |
| [Pocket](#pocket) | Clears an area | Closed path | End mill, bull nose, ball nose | ✓ |
| [Drill](#drill) | Makes holes | Circles or clicked points | Peck: any tool · Helical: end mill | ✓ |
| [Surface](#surface) | Flattens the stock | Nothing selected | End mill | — |
| [V-Carve](#v-carve) | Carves with depth from width | Closed path | V-bit, taper | ✓ |
| [Photo V-Carve](#photo-v-carve) | Carves a photo as grooves | An image | V-bit | ✓ |
| [Inlay](#inlay) | Cuts socket and plug | Closed path | Roughing: end mill · Finishing: V-bit, taper, end mill | — |
| [3D Profile](#3d-profile) | Carves a 3D surface | An STL or image | Finishing: ball nose, bull nose, taper · Roughing: ball nose, bull nose, end mill | — |

---

## Profile

| Field | Options / meaning |
|---|---|
| Tool | End mill, bull nose, ball nose, V-bit, taper |
| Cut Side | **inside** (hole edge) · **outside** (part edge) · **centerline** (on the line) |
| Start, Depth, Step Down | See common fields |
| Direction | climb · conventional |
| Optimize Path | One routed cut for a whole sheet of parts. Shown when several parts can share it |
| Bridge Gaps Through Waste | Under Optimize Path. May cut straight across waste between parts, up to a set length, to join toolpaths |
| Stock Allowance | −5 to +5 mm. Hidden for centerline |
| Round Inside Corners | Rounds the path in inside corners so the machine keeps its feed. Hidden for centerline |
| Ramp In | 2× dia, 50 % feed |

## Trochoidal

| Field | Meaning |
|---|---|
| Tool | End mill, bull nose, ball nose |
| Cut Side | inside · outside · centerline |
| Depth, Step Down | See common fields |
| Direction | climb · conventional |
| Loop Amplitude | How far the loops swing each side |
| Step / Loop | How far each loop moves forward |
| Ramp In | Spiral down over 2× dia, 50 % feed |
| Finishing pass | Clean sweep after the loops (the two walls, on centerline) |

Slot width (centerline) = 2 × Loop Amplitude + tool diameter.

## Pocket

| Field | Options / meaning |
|---|---|
| Invert Pocket | Shown for nested shapes. Swaps which area is cleared |
| Tool | End mill, bull nose, ball nose |
| Strategy | **auto** · raster · contour · morph · adaptive |
| Start, Depth, Step Down | See common fields |
| Stepover | % of tool diameter. Called **Engagement** on adaptive |
| Angle | Raster direction. On auto: tick **Auto (longest passes per area)** to let it choose |
| Direction | climb · conventional |
| Stock Allowance | Left on walls; negative grows the pocket |
| Ramp In | 2× dia, 50 % feed |

A rest-clearing pass always runs before the wall pass. **Alt**-click Generate to force a
strategy that declined the shape.

## Drill

| Field | Meaning |
|---|---|
| Mode | **Peck at Points** · **Helical (Circle)** |
| Drill Points | Peck: centres of the selected circles, or click the canvas to place points |
| Source Circles | Helical: the selected circular paths, each bored at its own diameter |
| Tool | Peck: any tool (a drill is best) · Helical: end mill only |
| Start, Depth, Step Down | See common fields |

Pick order = drill order. Peck with an end mill, ball nose or taper shows a warning.

## Surface

| Field | Meaning |
|---|---|
| Tool | End mill only |
| Stepover | 10–90 % |
| Angle | 0–180° |
| Depth, Step Down | See common fields |

Covers the whole stock. No selection needed.

## V-Carve

| Field | Meaning |
|---|---|
| Tool | V-bit, taper |
| Start | See common fields |
| Max Depth | Deepest allowed. A limit, not a target. The line under it gives the widest cut |

## Photo V-Carve

| Field | Meaning |
|---|---|
| Image | An imported PNG, JPEG or WebP |
| Tool | V-bit only |
| Start | See common fields |
| Angle | Groove direction, 0–180° |
| Depth at White | Depth for the lightest areas |
| Depth at Black | Depth for the darkest areas |
| Line Spacing | Read-only. Equals the deepest groove's width; shows the line count |

## Inlay

| Field | Meaning |
|---|---|
| Roughing Tool (End Mill) | Clears the bulk |
| Finishing Tool | V-bit or taper (sloped walls), end mill (flat walls), or **None — roughing only**. Same on both halves |
| Inlay Depth | Socket depth |
| Step Down | Roughing depth per pass |
| Stepover | 10–90 % |
| Glue Gap | Space left under the plug |
| Clearance | Slack around the plug, −1 to +1 mm |
| Generate | **Female** (socket) or **Male** (plug) |
| Invert | Shown for nested designs. Which part is the plug |
| Ramp In | 2× dia, 50 % feed |
| Mirror | Male only. Flips the plug for text or non-symmetrical designs |

The button reads **Generate Female Toolpath** or **Generate Male Toolpath**.

## 3D Profile

| Field | Meaning |
|---|---|
| Model | Listed under *STL* or *Depth map image* |
| Relief Depth | Depth map only. Height from background to white |
| Dark is high | Depth map only. Black becomes the top |
| Boundary | **Model box** · **Stock** · any closed path |
| Model Top Below Stock | Lowers the whole model |

**Roughing** (shown once a roughing tool is picked)

| Field | Meaning |
|---|---|
| Roughing Tool (optional) | Ball nose, bull nose, end mill, or **— None (single-pass) —** |
| Roughing Stepover | 5–100 % |
| Roughing Step Down | Depth per level |
| Roughing Angle | Blank = auto (finishing angle + 90°) |
| Stock Allowance | Left for finishing, 0–2 mm. Default 0.3 mm |

**Finishing** (labelled without "Finishing" when there's no roughing tool)

| Field | Meaning |
|---|---|
| Finishing Tool | Ball nose, bull nose, taper |
| Finishing Stepover (XY) | % of diameter (of the **tip** on a taper) |
| Finishing Strategy | **Raster** · **Waterline** (depth maps: Raster only) |
| Angle | Raster only. −90° to +90° |
| Max Depth | Deepest below stock top |

---

## Path Tools

| Tool | Fields | Button |
|---|---|---|
| **Boolean** | Operation: union · intersect · subtract | Apply Boolean |
| **Offset** | Distance (+ outset, − inset) · Keep shape · Keep generated shapes · Corner Style: miter · round · square | Apply Offset |
| **Pattern** | Mode: linear (Rows, Cols, X Gap, Y Gap) · circular (Count, Radius, Start°, End°, Rotate items) | Apply Pattern |
| **Tabs** | Count · Height · Length | Apply Tabs |
| **Corners** | Corner Treatment: Outer Round · Inner Round · Chamfer · Dogbone · None · Radius (**Tool Radius** for Dogbone) | Apply to All Corners / Apply to N Selected Corners |
| **Nest** | Shared lines (+ end mill) · Part Gap · Edge Margin · Rotation Step: None · 90° · 45° · 15° · Pack From: Left Edge · Bottom Edge · Fill stock with copies · Nest inside holes · Avoid other paths | Nest on Stock (Fill Stock when filling) |
