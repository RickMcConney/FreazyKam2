# Glossary

| Term | Meaning |
|---|---|
| **Chip** | One item in the Objects strip |
| **Chip load** | Thickness each tooth cuts. Feed ÷ (RPM × flutes) |
| **Climb** | Cutting direction where the chip starts thick. Normal on a router |
| **Conventional** | Opposite of climb |
| **Cut side** | Which side of the line the tool runs: outside, inside, centerline |
| **Depth map** | Greyscale image where brightness is height |
| **Dogbone** | Small notch in an inside corner so a square part fits |
| **Double-sided** | A job cut on both faces of a board, turned over onto dowel pins between them |
| **Dowel pins** | Pins in the spoilboard that holes in the board drop onto, so the board goes back exactly. Two, of different sizes |
| **Feed hold** | Controlled stop that keeps position |
| **Flutes** | Cutting edges on a bit |
| **G-code** | The program a CNC controller runs |
| **Holding strip** | A short strip left uncut across the gap between two nested parts, or a part and the sheet's edge. Together they hold every part to the sheet. See [Hold a nested sheet](../how-to/hold-a-nested-sheet.md) |
| **Island** | A shape inside a pocket left standing |
| **Max Z** | A bit's usable cutting length |
| **Module** | Gear tooth size. Pitch diameter = module × teeth |
| **Operation** | One toolpath: tool, shape, depth, settings |
| **Point** | A node on a path |
| **Post-processor** | Rules for writing G-code for your controller |
| **Relay** | Small file on a FluidNC controller that lets FreazyKam connect |
| **Rest-machining** | Cutting only what earlier passes left |
| **Resume file** | A G-code file that restarts a stopped job from a chosen line, with the machine's state put back first. See [Restart a job](../how-to/resume-a-job.md) |
| **Scallop** | Ridge left between passes of a round bit |
| **Seam** | Where one tile ends and the next begins |
| **Sheet** | One board of stock. A job can span several, each exported as its own file |
| **Side A / Side B** | The two faces of a double-sided job. Side B is cut after the flip |
| **Stale** | An operation whose toolpath no longer matches its inputs (amber) |
| **Step down** | Depth per pass |
| **Stepover** | Sideways distance between passes |
| **Stock** | The material on the table |
| **Tab** | Bridge of material holding a part in place |
| **Tile** | One machine's worth of a board longer than the machine. Each is its own file |
| **Tool** | A cutter in the library |
| **Work zero** | The point the job is measured from (X0 Y0 Z0) |
