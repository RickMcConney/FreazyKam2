# Cut into the floor of a pocket

Example: engrave 1 mm into the floor of a 3 mm pocket.

1. Make the pocket first.
2. Select the shape to engrave and open its operation.
3. Set **Start** to **Floor of** *your pocket*.
4. Set **Depth** to `1`. Depth is measured **from the start**, not from the top.
5. Check the **Z** shown next to Start. Here it's −3, so the cut ends at −4.
6. Click **Generate Toolpath**.

If you deepen the pocket later, this cut follows it down.

## Start options

| Start | Means |
|---|---|
| **Auto** (default) | Starts at the highest material left by earlier cuts |
| **Stock top** | Starts at Z 0 |
| **Floor of …** | Follows another operation's floor |
| **Custom…** | A Z you type. Not checked. Be careful |

**Related:** [How depth is measured](../explanation/zero-and-depth.md#depth-is-from-the-start)
