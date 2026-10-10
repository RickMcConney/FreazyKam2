# Cut side: why parts come out the wrong size

A bit has width. When it follows your line, it has to run **beside** the line, or **on** it.
Which one decides the size of what you get.

```
      Outside                Inside               Centerline

    ○ ○ ○ ○ ○ ○
    ○┌────────┐○         ┌────────┐            ┌○──○──○──○┐
    ○│  part  │○         │○ ○ ○ ○ │            ○  part    ○
    ○│        │○         │○ hole ○│            │          │
    ○└────────┘○         │○ ○ ○ ○ │            └○──○──○──○┘
    ○ ○ ○ ○ ○ ○          └────────┘
  tool outside the line  tool inside the line  tool on the line
  → part = drawn size    → hole = drawn size   → half a bit each side
```

| Cut side | Line becomes | Use for |
|---|---|---|
| **Outside** | The part's edge | Cutting out parts |
| **Inside** | The hole's edge | Holes and windows |
| **Centerline** | The middle of a groove | Grooves, scoring, open lines |

## The classic mistake

Cut a part on **centerline** instead of **outside** and it comes out **one tool radius
smaller** all round. A 6 mm bit takes 3 mm off each side, and the canvas shows nothing
wrong.

## Tuning a fit

**Stock allowance** moves the cut away from the line:
- **Positive** leaves material (for a finishing pass).
- **Negative** cuts past the line (for a looser fit).

## Sloped bits

A V-bit or taper is narrower at the bottom. The app measures the offset at the **top** of
the cut, so the wall touches your line at the surface and slopes in below it.

**How-to:** [Cut out a part](../how-to/cut-out-a-part.md)
