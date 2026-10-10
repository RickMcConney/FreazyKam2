# Import a drawing or model

1. Click **Import File** in the toolbar, or drag the file onto the canvas.
2. Pick the file.

| File | Comes in as |
|---|---|
| **SVG** | Paths |
| **DXF** | Paths. You'll be asked for units if the file has none |
| **STL** | A rectangle you can move and size. The model shows in 3D View |
| **PNG, JPG, WebP** | A picture for 3D carving or photo V-carving |
| **G-code** | A program you can simulate |

## If nothing appears

- **SVG:** convert text to outlines in your drawing program, then export again.
- **DXF:** explode blocks first. See [supported DXF entities](../reference/file-formats.md#dxf).
- **Wrong size from DXF:** you picked the wrong units. Re-import.

## Shapes from SVG won't pocket?

The shape was drawn as a line, not a filled outline, so it's open.
See [Open and closed paths](../explanation/open-and-closed-paths.md).

**Related:** [File formats](../reference/file-formats.md)
