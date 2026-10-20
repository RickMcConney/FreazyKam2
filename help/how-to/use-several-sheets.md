# Work on several sheets

When the parts won't fit on one board, spread the job over several **sheets** of the same
stock. Each sheet is drawn on the canvas beside or below the stock, labelled **Sheet N**.

## Let the nest add them

1. Select the parts and open **Nest**.
2. Leave **Use more sheets** ticked.
3. Click **Nest on Stock**.

Sheet 1 is packed full, then sheet 2, and so on. The report says how many it took:
*Nested 40 of 40 on 3 sheets*. The sheets are laid out in a square-ish grid.

## Or add one yourself

**Drag a part off the stock to the right, or below it.** A new sheet appears under it.

- Drag the last part off a sheet, or delete it, and the sheet goes away.
- A part belongs to whichever sheet the middle of it is on.
- **Above and left of the stock** is spare workspace. Nothing there makes a sheet.
- Sheets are numbered across, then down.

## Simulate and run one sheet

Use the **◀ Sheet 1 of 3 ▶** picker in the toolbar. It picks the sheet that **Simulate
G-code** plays and that the Machine tab's **Send to card** sends.

## Export

**Export G-code** writes one file for every sheet with toolpaths: `tray_sheet1.gcode`,
`tray_sheet2.gcode`, and so on.

Each file is cut from **its own sheet's corner**. Run sheet 1, load a fresh board, zero it
the same way, and run sheet 2.

A [double-sided](cut-both-sides.md) or [tiled](cut-a-long-board-in-tiles.md) job is one
board, so it uses the picker for its sides or tiles instead, and doesn't nest onto more
sheets.

**Related:** [Nest parts](nest-parts.md) ·
[User guide: More than one sheet](../../docs/09-nesting.md#more-than-one-sheet)
