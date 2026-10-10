# Cut a slot

Use **Trochoidal** to cut a slot in small loops. It's easier on the bit and the machine
than ploughing straight through.

1. Draw a line down the middle of the slot.
2. Select it.
3. Under **CAM Operations**, click **Trochoidal**.
4. Set **Cut Side** to **centerline**.
5. Work out the **Loop Amplitude**:

   ```
   amplitude = (slot width − tool diameter) ÷ 2
   ```

   Example: 10 mm slot, 6 mm bit → amplitude `2`.

6. Set **Depth**.
7. Tick **Finishing pass** to clean the walls.
8. Click **Generate Toolpath**.

**Related:** [All Trochoidal settings](../reference/operations.md#trochoidal)
