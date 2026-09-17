# Stock textures

Seamless CC0 color maps used by the 3D simulation (`src/three/woodTexture.ts`).
All 1K JPG, grain and brush lines running along **+X** — `woodTexture.ts` and
everything that maps these tiles assume that direction.

| File | Material | Source | Asset |
|---|---|---|---|
| pine.jpg | pine | ambientCG | [Wood092](https://ambientcg.com/view?id=Wood092) |
| cedar.jpg | cedar | ambientCG | [Wood030](https://ambientcg.com/view?id=Wood030) |
| oak.jpg | oak | Poly Haven | [oak_veneer_01](https://polyhaven.com/a/oak_veneer_01) |
| maple.jpg | maple | ambientCG | [Wood095](https://ambientcg.com/view?id=Wood095) |
| walnut.jpg | walnut | Poly Haven | [dark_wood](https://polyhaven.com/a/dark_wood) |
| cherry.jpg | cherry | Poly Haven | [rosewood_veneer1](https://polyhaven.com/a/rosewood_veneer1) |
| plywood.jpg | plywood | Poly Haven | [plywood](https://polyhaven.com/a/plywood) |
| brushed-metal.jpg | aluminum, brass | ambientCG | [Metal009](https://ambientcg.com/view?id=Metal009) |
| red-oak.jpg | *(none yet)* | ambientCG | [Wood050](https://ambientcg.com/view?id=Wood050) |

Both sources license all assets as CC0 (public domain — no attribution required);
the table is for our own traceability. **Anything added here needs a row.** A
texture whose origin can't be named doesn't belong in this directory — it ships
to every user of the app.

`brushed-metal.jpg` serves both metals: aluminum and brass differ in color, not
in surface structure, so `tintToMaterial` recolors the one tile to each
material's `MATERIAL_COLORS` hue on load.

`red-oak.jpg` is staged but unreferenced — there is no `red oak` material yet,
and the existing `oak` entry already tracks red oak's Janka figure (~1290 lbf).

MDF, HDPE and "other" have no photo texture; they get a procedural tile
generated at runtime (speckle for MDF, brushed/flat noise for the rest). MDF is
deliberate rather than pending — ambientCG's nearest stock is chipboard/OSB,
whose coarse flakes read as the wrong material next to MDF's smooth face.

There is no CC0 bamboo *board* texture in either library; the `Bamboo001*` and
`Bamboo002*` sets are matting and fencing (visible nodes, separate canes).

## Tile scale

Each tile is mapped over the real-world area it photographs, so grain renders
life-sized. `TILE_MM` in `woodTexture.ts` holds the (u, v) extent in mm:

| Material | Tile mm | Source of the number | Image | px/mm |
|---|---|---|---|---|
| pine | 800 × 800 | ambientCG published | 2048² | 2.56 |
| oak | 1830 × 1830 | Poly Haven published | 4096² | 2.24 |
| walnut | 2000 × 1938 | Poly Haven published, less the de-seamed strip | 4096 × 3968 | 2.05 |
| cherry | 2430 × 2430 | Poly Haven published | 4096² | 1.69 |
| plywood | 500 × 500 | Poly Haven published | 1024² | 2.05 |
| cedar | 800 × 800 | **estimated** — none published | 2048² | 2.56 |
| maple | 800 × 400 | **estimated** — none published | 2048 × 1024 | 2.56 |
| aluminum, brass | 400 × 400 | **estimated** | 1024² | 2.56 |

The pair is not always square, and the two cases differ. `maple.jpg` is a 2:1
image of a 2:1 area. `walnut.jpg` began square but Poly Haven's 4K `dark_wood`
does not wrap vertically (seam ~6× interior variation, though its 1K does), so a
128-row crossfade repaired it — that removed 1/32 of the height, hence 1938 mm.
**Keep u:v matched to the image's aspect or texels stop being square**; that is
the check to run when adding or reprocessing a tile.

Procedural materials (MDF, HDPE, other) have no physical size and use
`DEFAULT_TILE_MM = 128`.

ambientCG Wood031 was trialled for pine (paler, cleaner, no aging) and rejected
— it reads as a rotary-cut plywood face and its knot pattern tiles visibly. Both
libraries were swept in full; neither has a fresh planed *solid* pine board, so
Wood092 stands despite its oiled tone.

## Resolution

Correct scale is resolution-hungry: a tile covering 2.4 m of board spread over a
300 mm workpiece is heavily magnified. Sources are 2K/4K, re-encoded at JPEG
q88 (the originals ship near-lossless at 10–13 MB, far too heavy for the web).
That holds every material in a 1.7–2.6 px/mm band — cherry, the worst case, was
0.42 before. ~15 MB total on disk, but `getWoodTexture` fetches lazily per
material, so a session pulls only the stock it actually uses.

Dropping to q84 saves about 17% on the largest file for ~3 levels of mean
error; the loss curve is steep at first and then flat, so q88 is the sensible
side of it.
