# What a simulation can't tell you

The simulation proves the **toolpaths** are right: the right shapes, depths and order.

It **can't** know:

- If your machine is square and trammed.
- If the stock is where you think it is.
- If your clamps will hold.
- If the bit is sharp, or is even the bit the program expects.
- Where you actually zeroed.

If the simulation looked right and the cut didn't, the problem is in the setup, not the
G-code. Check **Z zero** and **workholding** first.

## Before you press Run

1. Zero X, Y and Z where the export review says.
2. Fit the bit the review names.
3. Watch the first moves before letting it plunge.
4. Keep a hand near the power switch.

**How-to:** [Simulate a job](../how-to/simulate-a-job.md)
