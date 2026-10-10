# Clear a pocket

Use **Pocket** to cut away the area inside a closed shape.

1. Select a closed shape.
2. Under **CAM Operations**, click **Pocket**.
3. Pick the **Tool**.
4. Set **Depth**.
5. Leave **Strategy** on **auto**.
6. Click **Generate Toolpath**.

Shapes inside the outline are left standing as islands. You don't need to mark them.

![A pocket toolpath](../../docs/images/01-pocket-toolpath.png)

## Ring shapes

Selected two shapes, one inside the other? Tick **Invert Pocket** to switch between
clearing the ring and clearing the middle.

## No single closed shape?

While the Pocket form is open, hover an area enclosed by several lines. It highlights.
Click to make it a pocket shape.

## Strategy said "declined"?

Not an error. Auto cut it instead. **Alt**-click **Generate** to force your choice.

**Related:** [Which strategy to use](../explanation/pocket-strategies.md) ·
[All Pocket settings](../reference/operations.md#pocket)
