# Operations, the program and stale toolpaths

## An operation is one toolpath

Tool + shape + depth + settings = one operation. A job is a list of them.

## Two lists, two jobs

| | Objects strip (bottom) | Paths → Toolpaths (sidebar) |
|---|---|---|
| Shows | Your **document** | Your **program** |
| One entry per | Thing you made | Toolpath |
| Order | When made | **Cut order** |
| Use it to | Reopen and edit | Reorder, hide, check time |

## Pick order is cut order

Click holes 1, 2, 3 and they're drilled 1, 2, 3. Nothing re-sorts them behind your back.
The chips in the form are numbered so you can see the order before you generate.

## Inside first, outline last

Cut the inside features while the part is still held by the whole sheet. Cut it free last.
If you cut the outline first, the part can shift for every cut after.

**Group by tool** reduces bit changes, but can break this rule. Check the order after
pressing it.

## Stale toolpaths

If you change a shape, the stock, or a cut another one starts from, the affected operations
turn **amber**. The app does **not** regenerate them by itself, because:

- A toolpath that changed without you looking is worse than one clearly marked stale.
- Regenerating can take a while.

Open it and click **Regenerate Toolpath** when ready. The export review warns about any
stale operations.

## When Generate fails

- **New operation:** removed again. A chip for a cut that doesn't exist would mislead.
- **Existing operation:** kept, with the error. Fix the setting and try again.

**How-to:** [Change the cut order](../how-to/change-the-cut-order.md) ·
[Add or remove paths](../how-to/edit-an-operation.md)
