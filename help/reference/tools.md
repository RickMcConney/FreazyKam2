# Tool types and the tool table

## Tool table columns

| Column | Meaning |
|---|---|
| Name | Your label |
| Type | End Mill, Bull Nose, Ball Nose, V-bit, Taper End Mill, Drill. Decides which operations offer it |
| Ø | Cutting diameter. **Taper: tip diameter** |
| Flutes | Cutting edges |
| Chip | Maker's rated chip load per tooth. Blank = none |
| RPM | Spindle speed |
| Dial | Router dial setting (only with a DeWalt/Makita spindle type) |
| XY Feed | Cutting feed |
| Z Feed | Plunge feed |
| Max Z | Usable cutting length |
| Angle° / R | V-bit: included angle · Taper: angle per side · Bull nose: corner radius |
| Actions | Move to folder · Copy to My Tools · Delete (on hover) |

## Which operations offer each type

| Type | Offered to |
|---|---|
| End Mill | Profile, Pocket, Trochoidal, Surface, Drill (peck and helical), Inlay (roughing and finishing), 3D Profile (roughing), Nest (Shared lines) |
| Bull Nose | Profile, Pocket, Trochoidal, Drill (peck), 3D Profile (finishing and roughing) |
| Ball Nose | Profile, Pocket, Trochoidal, Drill (peck), 3D Profile (finishing and roughing) |
| V-bit | Profile, V-Carve, Photo V-Carve, Drill (peck), Inlay (finishing) |
| Taper End Mill | Profile, V-Carve, Drill (peck), Inlay (finishing), 3D Profile (finishing) |
| Drill | Drill (peck) |

The same, by operation:

| Operation | Offers |
|---|---|
| Profile | End Mill, Bull Nose, Ball Nose, V-bit, Taper |
| Trochoidal | End Mill, Bull Nose, Ball Nose |
| Pocket | End Mill, Bull Nose, Ball Nose |
| Drill: Peck at Points | Any tool (warns for an end mill, ball nose or taper) |
| Drill: Helical (Circle) | End Mill |
| Surface | End Mill |
| V-Carve | V-bit, Taper |
| Photo V-Carve | V-bit |
| Inlay: Roughing Tool | End Mill |
| Inlay: Finishing Tool | V-bit, Taper, End Mill, or None |
| 3D Profile: Finishing Tool | Ball Nose, Bull Nose, Taper |
| 3D Profile: Roughing Tool | Ball Nose, Bull Nose, End Mill, or None |
| Nest: Shared lines | End Mill |

**Max Z never hides a tool.** Going too deep shows *Exceeds tool Max Z*.

## Angle conventions

| Type | Stored angle | Example |
|---|---|---|
| V-bit | **Included** (whole opening) | 60° = 30° each side |
| Taper | **Per side** | 5° per side = 10° included |

## Bull nose

| R value | Cuts like |
|---|---|
| 0 | End mill |
| Ø ÷ 2 | Ball nose |
| Default on switching type | Ø ÷ 4 |

In a pocket, keep stepover below the flat width (Ø − 2R).

## Folders

| Action | How |
|---|---|
| Rename | Double-click the tab |
| Delete | **×** on the tab (My Tools can't be deleted) |
| Move a tool | Folder icon in its row |
| Copy to My Tools | Copy icon (imported folders) |
| Export a folder | **Export** → `.fkset` |
| Restore defaults | **Restore Defaults** (My Tools only; tools in use are kept) |
