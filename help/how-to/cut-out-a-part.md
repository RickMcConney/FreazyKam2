# Cut out a part

Use **Profile** to cut along a line.

1. Select the outline.
2. If the part could come loose, [add tabs](add-holding-tabs.md) first.
3. Under **CAM Operations**, click **Profile**.
4. Pick the **Tool**.
5. Set **Cut Side**:

   | Pick | When the line is |
   |---|---|
   | **Outside** | The edge of a part |
   | **Inside** | The edge of a hole |
   | **Centerline** | A groove to cut along |

6. Set **Depth**. To cut through, go slightly deeper than the stock (12.5 mm for 12 mm).
7. Click **Generate Toolpath**.

## Fine-tune the fit

**Stock allowance** leaves extra material. A **negative** allowance cuts past the line for
a looser fit.

**Related:** [Why cut side matters](../explanation/cut-side.md) ·
[All Profile settings](../reference/operations.md#profile)
