# Hold parts on a tightly nested sheet

On a close-packed sheet, tabs fail: the waste a tab holds a part to gets cut loose by the
next part's cut, and both come free. **Holding strips** join the parts to each other across
the gaps, and through each other to the sheet's edge.

1. Profile the parts first. Strips only join parts that are cut **through** the stock.
2. Select the sheet's parts (drag a box — labels and holes it catches are left out).
3. Under **Path Tools**, click **Tabs**.
4. Choose **Joined by strips**.
5. Set:

   | Field | Typical |
   |---|---|
   | Joins Per Part | `2`, or `4` for long thin parts |
   | Width | `5` mm |
   | Height | `2`–`3` mm |

6. Click **Place Strips**.

The strips show as amber bands. Every cut through the stock lifts over them.

## What you get

- Each join runs square across one gap, and is a tab on each part it joins.
- Joins spread round each part, so it's held from different sides.
- Joins to the sheet's edge stop about 20 mm out.
- Holes cut straight through. Labels and other shallow cuts aren't lifted.

**Re-place Strips** replaces them all. **Remove Strips**, or deleting the *Strips* chip,
takes them off. One undo puts things back either way.

**More joins hold better but leave more to clean up.**

**Related:** [Add holding tabs](add-holding-tabs.md) · [Nest parts on a sheet](nest-parts.md)
