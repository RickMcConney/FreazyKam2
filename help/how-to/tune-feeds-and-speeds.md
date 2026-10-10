# Tune feeds and speeds for your machine

The app works out feeds and speeds for you. Tell it about your machine once.

1. Click **Setup** and scroll to the bottom.
2. Leave **Auto Feeds & Speeds** on.
3. Set **Machine Rigidity** honestly:

   | Setting | Machine |
   |---|---|
   | Hobby (light gantry) | Light or 3D-printed frame, belts |
   | Light hobby | Entry-level aluminium extrusion |
   | Prosumer | Stiff hobby machine (default) |
   | Heavy / industrial | Steel frame, ballscrews |
   | Commercial CNC | Industrial |

4. Pick your **Spindle / Router**: VFD spindle (variable), Manual / fixed speed,
   DeWalt DW6xx (DWP611) or Makita RT07 (RT0701C). For the DeWalt or Makita, the app shows
   the **dial number** to set.
5. Set **Min Spindle** and **Max Spindle** to your spindle's real range.
6. Under **Machine Motion**, set **Max Feed Rate** to the fastest your machine moves without
   losing steps.

## Check the result

Simulate a job and watch the **chip load** reading:

| Reading | Do |
|---|---|
| 🟢 sweet spot | Nothing |
| 🔴 rubbing · too hot | Feed faster or slow the spindle |
| 🔵 chips too large | Feed slower or speed up the spindle |

These are starting numbers. Adjust for dull bits, knotty wood or weak clamping.

**Related:** [Chip load explained](../explanation/chip-load.md) ·
[Chip load reference](../reference/chip-load.md)
