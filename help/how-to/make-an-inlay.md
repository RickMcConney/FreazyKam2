# Make an inlay

An inlay is two cuts on two boards: a **socket** (female) and a **plug** (male) that fits it.

**You need:** an end mill and a **V-bit**. A taper also works, but leaves a visible
hairline gap. An end mill as the finishing tool gives flat walls instead of sloped ones.

## Cut the socket

1. Select your design.
2. Under **CAM Operations**, click **Inlay**.
3. Set **Roughing Tool (End Mill)** and **Finishing Tool** (your V-bit).
4. Set **Inlay Depth** and **Glue Gap**.
5. Under **Generate**, pick **Female**.
6. If **Invert** appears, read the line under it. Make sure it names the right part as the
   plug.
7. Click **Generate Female Toolpath**.

## Cut the plug

1. Open **Inlay** again with the same design selected.
2. Keep the **same Finishing Tool**.
3. Under **Generate**, pick **Male**.
4. Tick **Mirror** if the design has text or isn't symmetrical.
5. Click **Generate Male Toolpath**.

Cut it on the second board.

## Glue up

1. Flip the plug and press it into the socket with glue.
2. Let it cure.
3. Plane or sand down to the socket board's face.

The export review warns you if the plug doesn't match the socket.

**Related:** [Why inlays fit](../explanation/inlays.md) ·
[All Inlay settings](../reference/operations.md#inlay)
