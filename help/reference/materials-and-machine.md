# Materials and machine rigidity

## Material hardness

Higher = harder = gentler feeds.

| Material | Hardness |
|---|---|
| Cedar | 0.5 |
| Pine | 0.6 |
| HDPE | 0.7 |
| MDF | 0.8 |
| Plywood | 0.9 |
| Walnut | 1.1 |
| Cherry | 1.2 |
| Maple | 1.3 |
| Oak | 1.4 |
| Aluminium | 2.5 (plus max surface speed) |
| Brass | 2.8 (plus max surface speed) |

## Machine Rigidity

| Icon | Level | Machine |
|---|---|---|
| 🐌 | 1 · Hobby (light gantry) | Light rail or 3D-printed, belt drive |
| 🐢 | 2 · Light hobby | Entry aluminium extrusion |
| 🐇 | 3 · Prosumer | Stiff hobby machine (default) |
| ⚡ | 4 · Heavy / industrial | Steel frame, ballscrews, real spindle |
| 🚀 | 5 · Commercial CNC | Industrial |

Rigidity scales both chip size and depth per pass.

## Spindle / Router

| Option | Shows dial numbers |
|---|---|
| VFD spindle (variable) | No (uses the S-word) |
| Manual / fixed speed | No |
| DeWalt DW6xx (DWP611) | Yes |
| Makita RT07 (RT0701C) | Yes |

## Setup panel machine fields

| Section | Field | Meaning |
|---|---|---|
| Feeds & Speeds | Min Spindle · Max Spindle | Spindle range in RPM. Routers bottom out near 10,000 |
| Machine Limits | Table Width · Table Height · Max Z Travel | Travel the export review checks against |
| Machine Limits | Safe Height | Height for rapid moves |
| Machine Motion | Max Feed Rate | Hard ceiling on feed |
| Machine Motion | Accel X/Y · Accel Z · Z Max Rate · Junction Dev. | Used for run-time estimates |
