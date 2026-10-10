# Carve a 3D model (STL)

1. Click **Import File** and pick the `.stl`.
2. A rectangle appears. Move and resize it to place the carve.
   **Resize evenly** (corner handle) or the depth will be distorted.
3. Check the model in **3D View**.
4. Under **CAM Operations**, click **3D Profile**.
5. Set:

   | Field | Value |
   |---|---|
   | Model | your STL (listed under *STL*) |
   | Roughing Tool | A bigger ball nose, a bull nose or an end mill (optional) |
   | Finishing Tool | Ball nose, bull nose or taper |
   | Finishing Stepover (XY) | 10–20 % for a good finish |
   | Finishing Strategy | **Raster** (or **Waterline**) |
   | Max Depth | How deep it may go |

6. Click **Generate Toolpath**.
7. Simulate in **3D View** before cutting.

![Finishing passes at 45° and roughing passes at 135° crossing on a rosette](../../docs/images/07-3d-rasters.png)

*Finishing (green) at 45°; roughing (red) defaults to 90° from it, at 135°.*

The top of the model sits at the top of the stock. Undercuts can't be carved.

**Picture instead of STL?** Follow [Carve a picture in 3D](../tutorials/02-carve-a-picture.md).

**Related:** [How 3D carving works](../explanation/3d-carving.md) ·
[All 3D Profile settings](../reference/operations.md#3d-profile)
