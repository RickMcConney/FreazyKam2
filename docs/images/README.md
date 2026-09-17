# Screenshot conventions

Two sizes, chosen so that a picture is always readable at the size GitHub renders it.
GitHub's markdown column is about 800pt wide and scales anything wider down to fit —
which is why a whole-app screenshot cannot also be a screenshot you can read the fields
in. So there are two kinds, used for different jobs.

## The two kinds

| Kind | What it's for | Final width |
|---|---|---|
| **Full app** | Orientation — *where* a thing is on screen | **1600 px** |
| **Crop** | Detail — a panel, form or dialog whose values you must be able to read | **native 2×, capped at 1000 px wide, 700 px tall** |

A full-app shot at 1600 px displays at ~800pt: half size, retina-crisp, and you can see
the layout but not read the sidebar. That is the correct trade for "here is where the
Setup button lives."

A crop kept at native 2× displays at its *real* on-screen size and stays sharp, so a
form's labels and values read exactly as they do in the app. Cap it at 1000 px wide;
wider than that and it's really a full-app shot.

**Cap the tall dimension too, at 700 px**, or a crop can end up taller than a full-app
screenshot — a tall sidebar panel or a full canvas region can pass 1000 px in height while
staying comfortably under the width cap, and unlike the width cap nothing stops it. A
whole panel that runs past 700 px tall (the Setup panel is the standing example) doesn't
need a second screenshot — scale the one crop down until its tall edge hits 700; the text
was captured at 2×, so it stays legible well below native size.

## Capturing

Use Chrome DevTools rather than a window screenshot — it gives an exact, repeatable
viewport with no OS chrome, no window shadow, and no dependence on your display.

**One-time setup.** In DevTools → **Settings** (gear) → **Devices** → **Add custom
device**, make a device named `Guide` at **1400 × 900** with **Device pixel ratio 2**.

**Every capture after that:**

1. Open the app, `F12` → toggle the **device toolbar** (`Ctrl/Cmd+Shift+M`)
2. **Select `Guide` from the device dropdown.** Creating the device does not select it —
   the dropdown stays on *Responsive*, which is always DPR 1. This is the step that gets
   missed. The strip should read `1400 × 900` with `DPR 2` beside it
3. Set up the shot in the app
4. Click inside DevTools, press **`Cmd+Shift+P`**, type `screenshot`, choose
   **Capture screenshot**. It saves to Downloads at the emulated DPR

The Command Menu is the reliable way in. There is also a **⋮** at the far right of the
*device toolbar strip* (the grey row showing `1400 × 900  DPR 2`) with the same entry,
but it collapses out of sight when the DevTools panel is narrow. Don't use DevTools'
*own* ⋮ menu at the top right of the panel — that one ignores the emulated DPR.

Pick **Capture screenshot**, not *Capture full size screenshot*; the latter grabs the
whole scrollable page.

**Check every capture before using it**, because a DPR-1 shot looks correct on screen and
only reveals itself once GitHub scales it down:

```sh
sips -g pixelWidth -g pixelHeight shot.png
```

**2800 × 1800** is right. **1400 × 900** means DPR was still 1 — reshoot.

**macOS screen capture (`Cmd+Shift+3/4/5`) cannot be used for these.** It captures at
the *display's* scale, so on a 1× monitor it returns 1× pixels whatever DevTools is
emulating. It only yields 2× on a Retina display, and then only for the physical screen —
never for an emulated viewport larger than it. Use the DevTools capture above.

Check your display with `system_profiler SPDisplaysDataType | grep -i "looks like"`: if
*UI Looks like* equals the native resolution, the screen is 1× and DevTools is the only
route to a 2× image.

**Every shot in the guide is captured from that same 1440 × 900 / DPR 2 viewport**, full
app and crop alike. Same window size every time is what lets a single picture be
recaptured years later and still line up with the ones around it.

Use the **dark theme**. It is the app's own default, it is what the screenshots in the
top-level README already use, and a guide whose pictures don't match the screen the
reader is looking at makes them hunt for differences that aren't there. Consistency
across all the shots matters more than the choice itself.

## Capturing a gesture (drag, hover, mid-drag overlay)

DevTools' capture needs focus in DevTools, which ends any drag you are holding — so a
drag box, a hover state or a live transform preview cannot be caught that way. Use a
delayed capture instead, with Chrome itself rendering at 2× so the result is still a
retina image on a 1× monitor.

1. Relaunch Chrome at double scale (a fresh launch is required — the flag cannot be
   applied to a running instance):

   ```sh
   killall "Google Chrome"
   open -a "Google Chrome" --args --force-device-scale-factor=2
   ```

   Everything renders twice as large on screen. That is what makes an ordinary screen
   capture a genuine 2× image.

2. Size the window to what the display can hold. On a 2560 × 1600 screen, 2× scale
   leaves 1280 × 800 of CSS room:

   ```sh
   osascript -e 'tell application "Google Chrome" to set bounds of front window to {0, 0, 2400, 1520}'
   ```

   The viewport is smaller than the `Guide` device, which does not matter — a gesture
   shot is always cropped to the region where the gesture happens.

3. Start a delayed capture, then perform and **hold** the gesture until the shutter:

   ```sh
   screencapture -T 10 ~/Downloads/gesture.png
   ```

   Add `-R x,y,w,h` to capture a fixed rectangle instead of the whole screen.

4. Quit Chrome and reopen it normally to go back to 1× rendering.

Crop to the region of interest and keep the native pixels — these are already 2×.

## Processing

Full app — downscale the 2800-wide capture to 1600:

```sh
sips -Z 1600 raw.png --out docs/images/01-two-circles.png
```

Crop — crop the region in Preview (or `sips -c`), then leave it alone unless it came out
wider than 1000 px:

```sh
sips -Z 1000 raw-crop.png --out docs/images/01-setup-stock.png   # only if >1000 wide
```

Optional, worth doing before committing — lossless, typically 40-60% smaller:

```sh
oxipng -o4 docs/images/*.png     # brew install oxipng
```

## Naming

`NN-topic.png`, where `NN` is the guide chapter the shot belongs to:

```
01-setup-stock.png        chapter 1, the stock setup panel
01-two-circles.png        chapter 1, the two circles on the canvas
05-strategy-adaptive.png  chapter 5, the adaptive strategy result
```

Lowercase, hyphens, no spaces — a filename with a space has to be written `%20` in every
link that points at it. Name the *subject*, not the shot: `01-ops-order.png`, never
`01-screenshot-3.png`, so a picture stays findable when a chapter grows a section and
everything after it shifts down.
