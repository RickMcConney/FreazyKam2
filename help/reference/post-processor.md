# Post-processor settings

## Built-in profiles

FluidNC (mm) (default) · FluidNC (inches) · LowRider (mm) · Grbl (mm) · Grbl (inches) · grblHAL · LinuxCNC · Mach3 · UCCNC · Generic

**LowRider (mm)** is for a machine with its router on a relay (pin 27). It probes Z with a
0.5 mm plate at X10 Y10, to start and at each tool change, and homes Z with `$HZ`. Set
**Z origin** to the top of the stock, and edit the probe spot to suit your table.

A built-in you've never edited updates itself when a new version of FreazyKam changes it, and
the status bar says so. One you've edited stays as you left it. Click **Reset** to go back to
the current built-in and take future updates again.

## Profile fields

| Setting | Output |
|---|---|
| Name | File header |
| Unit mode | Coordinates and G20/G21. **Only this sets file units** |
| Comment style | `; semicolon`, `( parenthesis )`, or none |
| Start G-code | Once at start, after G20/G21 |
| End G-code | Once at end |
| Tool change G-code | Before each new tool (default M5, M0) |
| Spindle on / off | `{s}` = speed |
| Rapid / Cut move | `{x} {y} {z} {f}` |
| Arc CW / CCW | `{i} {j}` centre offsets |
| Output arc moves | Off = straight segments only |

## Placeholders

| Placeholder | Value |
|---|---|
| `{x}` `{y}` `{z}` | Target position |
| `{f}` | Feed rate |
| `{s}` | Spindle speed |
| `{tool}` | The new bit's number and name, as `T2 1/4" End Mill`. Tool change G-code only |
| `{i}` `{j}` | Arc centre offset |

## Buttons

| Button | Does |
|---|---|
| Add Profile | New profile |
| Duplicate | Copy selected |
| Delete | Remove selected (not the last) |
| Reset | Built-in back to factory |
| Import | Add profiles from `.fkset` (never overwrites) |
| Export | Save selected as `.fkset` |
| Restore Built-ins | Reset all built-ins, bring back deleted ones |
