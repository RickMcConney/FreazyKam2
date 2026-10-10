# Post-processor settings

## Built-in profiles

Grbl (mm) (default) · Grbl (inches) · grblHAL · LinuxCNC · Mach3 · UCCNC · Generic

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
