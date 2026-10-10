# How V-carving works

A V-bit is a cone. The deeper it goes, the wider it cuts.

```
   surface ───────────────────────
            \                 /     wide cut = deep
             \               /
              \     /\      /
               \   /  \    /        narrow cut = shallow
                \ /    \  /
                 V      \/
```

**Width decides depth.** That one fact drives every V-carving operation.

## V-Carve

The bit runs down the middle of each letter stroke. Where the stroke is wide, it goes deep.
Where it narrows, it rises. So serifs taper to a point and corners come out crisp, like hand
carving. There's no stepover or strategy to set.

**Max Depth** stops the bit going too deep in wide areas. If your letters look
flat-bottomed, they're hitting it.

The form tells you the widest cut at your Max Depth. For a 90° bit at 2 mm, that's 4 mm.
Strokes narrower than that never reach Max Depth.

## Photo V-Carve

Dark areas cut deeper, so wider. Light areas cut shallow, so narrow. Fill with paint, sand
the top, and the photo appears.

Line spacing equals the widest groove, so the darkest lines just touch. That means **depth
controls detail**:
- Shallow → narrow grooves → more lines → more detail.
- Deep → wide grooves → fewer lines → more contrast.

## V-bit vs taper

| | V-bit | Taper |
|---|---|---|
| Tip | Sharp point | Small ball |
| Groove bottom | Sharp V | Rounded |
| Best for | Crisp carving, inlays | Very fine detail, 3D |

A taper can enter a stroke narrower than its tip. A V-bit gives the sharper result.

**How-to:** [V-carve lettering](../how-to/v-carve-lettering.md) ·
[Carve a photo](../how-to/carve-a-photo.md)
