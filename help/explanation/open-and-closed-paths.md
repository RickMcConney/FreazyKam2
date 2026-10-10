# Open and closed paths

```
   Closed                  Open

   ┌──────┐                ┌──────┐
   │      │                │      │
   │      │                │      │
   └──────┘                ┘      └
   has an inside           no inside
```

A **closed** path ends where it started. It has an inside and an outside.
An **open** path has two loose ends. It's just a line.

## What each can be cut with

| Operation | Closed | Open |
|---|---|---|
| Profile, outside / inside | ✓ | ✗ |
| Profile, centerline | ✓ | ✓ |
| Trochoidal, centerline | ✓ | ✓ |
| Pocket, V-Carve, Inlay | ✓ | ✗ |

## Why the app refuses instead of guessing

It could join the two ends and carry on. But for a U shape, that means drawing a line
across the opening, and clearing an area you never drew. The toolpath would look fine on
screen. You'd only find out when the wood came off.

So it stops and tells you.

## Where open paths come from

- **SVG files** where a shape was drawn as a stroke, not a filled outline.
- **Two ends a hair apart.** They look closed but aren't. Double-click the path to check.
- **The pen tool** finished with **Esc** instead of clicking the first point.
- **Mazes and track grooves**, on purpose: they are meant to be cut on the centreline.

**Fix it:** [Messages: Path is open](../reference/messages.md#operations)
