# Machine tab controls

![The Machine tab](../../docs/images/12-machine.png)

## Layout

| Area | Holds |
|---|---|
| Sidebar | SD card files, Current design, job box, overrides, macros |
| Left column | Connection, position, jog pad, Home & Zero |
| Go to | Map, Z bar, probe light, **STOP** |
| Console | Controller messages and command box |

## Machine states

Idle · Run · Jog · Hold · Home · Alarm (shows **Unlock**)

## WiFi signal

| Signal | Colour | Meaning |
|---|---|---|
| 60 %+ | Green | Reliable |
| 45–59 % | Amber | May drop |
| Below 45 % | Red | Expect trouble |

## STOP

| While | STOP sends | Result |
|---|---|---|
| Jog, go-to, Safe Z | Feed hold | Stops, cancels move, no alarm |
| Job or console G-code | Feed hold | Pauses. Then Resume or Cancel |
| Homing | Soft reset | Alarm |

Stopping distance at 1200 mm/min: about 1 mm.

## Home & Zero

| Row | Buttons | Does |
|---|---|---|
| Home | All · X · Y · Z | `$H`, `$HX`… |
| Zero | All · X · Y · Z | Set work zero here |
| Probe | Probe Z · Settings | Touch-plate Z zero |
| Motors | Enable · Disable | Power steppers on/off |
| Go | Safe Z, then X0 Y0 | Needs all three zeroed |

## Probe settings

| Setting | Default |
|---|---|
| Plate | Your plate thickness |
| Search | 25 mm |
| Fast | 100 mm/min |
| Slow | 25 mm/min |
| Back-off between touches | 2 mm |
| Lift after | 5 mm |

## Jog steps

| | mm | inch |
|---|---|---|
| XY | 0.1, 1, 10, 50 | 0.001, 0.01, 0.1, 1 |
| Z | 0.1, 0.5, 1, 5 | 0.005, 0.02, 0.05, 0.2 |

## Map rotation

| You sit | Rotate | Up is | Right is |
|---|---|---|---|
| In front | 0° | +Y | +X |
| Right end | 90° | −X | +Y |
| Behind | 180° | −Y | −X |
| Left end | 270° | +X | −Y |

## Z bar

| Mark | Meaning |
|---|---|
| Safe (green dashed) | Safe height |
| Max (blue dashed) | Deepest cut |
| Tool (blue) | Current Z (once zeroed) |

## SD card

| Control | Does |
|---|---|
| Send to card | Writes `<project>.nc`, loads it |
| Upload file / drop files | Copies files, loads the last |
| Click a file | Loads it (reads only) |
| Bin | Delete (click twice) |
| Unload | Clears the loaded job |
| Refresh | Re-reads the card |

Lines over 80 characters warn. FluidNC stops at over 127.

## Job box

| Button | Does |
|---|---|
| Run | Start (needs X, Y, Z zeroed and a job loaded) |
| Pause | Feed hold |
| Resume | Continue |
| Cancel job | After pause. No alarm, lifts Z |
| ■ Stop | Soft reset. Alarm |

## Overrides

| Control | Range |
|---|---|
| Feed | 10 % steps, 10–200 % |
| Rapid | 25, 50, 100 % |
| Spindle | 10 % steps (VFD) |
| Router | Shows dial setting |

## Console commands

| Command | Does |
|---|---|
| `$X` | Clear alarm |
| `$C` | Check mode (run without moving). Again to exit |
| `[ESP420]` | Status and WiFi signal |
| `[ESP410]` | WiFi networks in range |
| `$Sta/SSID=…` | Set WiFi network |
| `$Sta/Password=…` | Set WiFi password |
| `$Bye` | Restart controller |

| Line prefix | Means |
|---|---|
| `>` | Command FreazyKam sent |
| `◆` (italic) | Button action sent as a control byte |

↑ / ↓ recall the last 50 commands.
