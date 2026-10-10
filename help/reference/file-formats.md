# File formats

## Open and import

| Format | Use | Notes |
|---|---|---|
| `.fkam` | FreazyKam project | Everything: shapes, tools, stock, operations |
| `.svg` | Drawing | Paths only. Convert text to outlines first |
| `.dxf` | Drawing | Asks for units if missing |
| `.stl` | 3D model | Binary or ASCII |
| `.png` `.jpg` `.webp` | Depth map or photo | PNG preferred |
| `.gcode` | Program | For simulation |
| `.fkset` | Settings, tools or post-processors | Shows contents before importing |
| `.json` | Fusion 360 tool library | Imported into its own folder |

## DXF

| Supported | Not supported |
|---|---|
| LINE, LWPOLYLINE, ARC, CIRCLE, SPLINE, ELLIPSE | Blocks and proxy entities (explode first) |

## Save and export

| Format | Contains | Re-editable |
|---|---|---|
| `.fkam` | Whole project | Yes |
| `.gcode` / `.nc` | Machine program | No |
| `.svg` | Outlines in mm, stock as page | Outlines only |
| `.fkset` | Settings, tool folder or post-processor | — |

## Fusion 360 import

| Brought in | Notes |
|---|---|
| Type, Ø, flutes, flute length | Converted to mm |
| RPM, feed, plunge | Maker's starting values |
| Chip load | Becomes the rated chip load |
| Bull nose / bowl bits | Keep corner radius |
| V-bit Max Z | Worked out from the cone |
| Round-over bits | Skipped and listed |
