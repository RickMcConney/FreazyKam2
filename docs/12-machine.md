# 12. Running the machine

The **Machine** tab drives a FluidNC controller directly from FreazyKam, over your WiFi:
see where the machine is, home it, zero it, jog it, send the job to its SD card, run it,
and stop it. Nothing to install on your computer — it all happens in the browser.

![The Machine tab: the SD card and job controls in the sidebar, connection, position, home and zero, jog and overrides on the left, the go-to map and console on the right](images/12-machine.png)

| Where | What |
|---|---|
| **Sidebar** | The controller's SD card, the **Current design** entry, and the job box (Run, Pause, Cancel, Stop) |
| **Left column** | **STOP**, connection, position, home & zero, jog, feed and speed overrides |
| **Go to** | A map of the stock — click it to send the tool there |
| **Console** | Everything the controller says, and a box to type commands into |

While the Machine tab is open the sidebar shows the SD card instead of the drawing
tools; switch back to **2D View** to keep designing.

---

## One-time setup: the relay file

Before FreazyKam can talk to a controller, one small file — the **relay** — has to be
copied onto that controller. You do this once per controller.

**Why it's needed.** FreazyKam is a secure (`https://`) website and the controller is a
plain (`http://`) device on your network. Browsers do not let a secure page talk to a
plain one directly. The relay is a tiny page that lives *on* the controller: FreazyKam
opens it in a small window and passes messages through it, and since the relay talks to
its own controller, the browser allows it.

### 1. Download the relay

On the **Machine** tab, while not connected, the Connection section shows
**Download 404.htm**. Click it. (The same download is in **How to install** at the top right of
the Connection section, which also walks through these steps.)

The file is saved as **`404.htm`** — keep that name exactly. Not `404.html`, not
`relay.html`. FluidNC hands any file you ask for by name to the browser as a download
instead of showing it as a page; the one exception is its "page not found" page,
`404.htm`. So the relay goes in under that name, and FreazyKam opens it at an address that
is never a real file — `http://<your controller>/freazykam` — which FluidNC answers with
its not-found page: the relay.

### 2. Copy it onto the controller's flash

1. Open the controller's own web page — the FluidNC WebUI — in your browser, at
   `http://fluidnc.local` or its IP address.
2. Open the **Files** panel and switch its drop-down from **SD** to **Flash**. It must go
   on the flash, *not* the SD card.
3. **Upload** `404.htm` into the top folder, next to `index.html.gz` and your
   `config.yaml`.

Do not rename, replace or delete `index.html.gz` — that is the WebUI itself, and the
relay leaves it alone.

### 3. Check it

Open `http://fluidnc.local/freazykam` (or `http://<IP address>/freazykam`). A small page
titled **FreazyKam link** means the relay is in place. Close that tab.

| You see | Means |
|---|---|
| **FreazyKam link** | Done |
| The browser **downloads a file** | The relay is on the controller under the wrong name — it must be `404.htm` |
| FluidNC's ordinary **not found** page | The relay isn't on the flash — check you uploaded to **Flash**, not SD |

### Good to know

- **The controller must be on your WiFi network** (FluidNC's *station* mode). If it is
  running its own WiFi network (*access point* mode), it answers every unknown address with
  a sign-in page and the relay can't load.
- **Connect before you start a job.** While the machine is moving, FluidNC won't serve
  pages from its flash, so the relay can't open mid-cut. A job that is already running
  keeps running if FreazyKam disconnects.
- A **mistyped address** on the controller now shows the relay page instead of
  "not found". That's harmless — the relay only takes instructions from FreazyKam.
- If connecting starts failing after a FreazyKam update, the relay may have changed:
  download it again and replace the copy on the flash.

---

## Connecting

1. Type the controller's address into the Connection section — `fluidnc.local`, or its
   IP address if `.local` names don't work on your network. Just the address: leave off
   `/freazykam` — FreazyKam adds that itself. (That longer address is only for checking
   the relay by hand, in [step 3](#3-check-it) above.)
2. Press **Connect**. A small **FreazyKam link** window opens: that is the relay. If the
   browser blocks it, allow pop-ups for FreazyKam and press Connect again.
3. Leave that window open — it can sit behind FreazyKam. Closing it disconnects.

Once connected, the Connection section shows:

- **The machine state** — *Idle*, *Run*, *Jog*, *Hold*, *Home*, *Alarm*. An **Unlock**
  button appears beside it in Alarm.
- **The firmware** the controller reports.
- **The WiFi signal** at the controller, as FluidNC reports it. Hover for the network,
  channel and signal in dBm.

| Signal | Colour | Meaning |
|---|---|---|
| 60% and up | Green | A reliable link |
| 45–59% | Amber | Usable, but the connection may drop |
| Below 45% | Red | Expect trouble |

The **Machine** tab shows a green dot while connected, so you can see the link is up from
any other tab.

**If the link drops,** FreazyKam reconnects by itself — up to four tries, two seconds
apart — and the console says how long the connection had been up. Your zeros, the loaded
job and your settings all survive a reconnect. See
[When the link misbehaves](#when-the-link-misbehaves) if it happens often.

---

## STOP

The red **STOP** button at the top of the left column is always there while connected,
and stops whatever is moving:

| Moving | STOP | Result |
|---|---|---|
| A jog, a go-to click, *Safe Z, then X0 Y0* | Feed hold | Slows to a stop and cancels the move. No alarm, position kept |
| A job, or G-code typed in the console | Feed hold | Slows to a stop and pauses. Then **Resume**, or **Cancel** |
| A homing cycle | Soft reset | Homing ignores a hold, so it is reset. The machine alarms |

A feed hold stops quickly but under control: at a typical 1200 mm/min cutting feed the
tool travels about 1 mm while slowing, more from a fast rapid.

**STOP needs the WiFi link.** It is not a substitute for a way to kill the power to the
machine and the router — keep one within reach. FreazyKam has no control over the router's
own switch, so none of the software stops turn the router off.

---

## Position, home and zero

**Position** shows the **Work** position — measured from the zero you set on the stock —
large, and the **Machine** position beside it. Units follow the toolbar's mm/in toggle.

### Home & Zero

| Row | Buttons | Does |
|---|---|---|
| **Home** | All · X · Y · Z | Runs FluidNC's homing cycle against your limit switches (`$H`, `$HX`…) |
| **Zero** | All · X · Y · Z | Makes the current position work zero on that axis |
| **Motors** | Enable · Disable | Powers the stepper motors on, or releases them so the axes move by hand |
| **Go** | Safe Z, then X0 Y0 | Raises Z to the safe height, then moves to the work zero |

- **No limit switches?** Untick **Limit switches** in the section header and the Home row
  disappears. Jog to the stock and zero there instead.
- A **✓** beside an axis means it has been zeroed — by its Zero button, or by a homing
  cycle that finished cleanly — since FreazyKam was opened.
- The line under the buttons says **where to zero**: the stock's origin corner from
  Setup, and whether Z0 is the top surface or the bottom of the stock. Zero where it says
  — that is where the toolpaths are measured from.
- **Disable** releases the motors, but any jog, go-to or job turns them straight back on —
  it is not a lock.
- **Safe Z, then X0 Y0** needs all three axes zeroed, since the safe height is measured
  from Z zero.

---

## Jogging

The **XY pad** reads as you face the machine: up moves **away** from you (+Y), right
moves +X. **Z+** and **Z−** are beside it. The centre **⊗** cancels a jog in progress.

- **Step** — the buttons under the pad: 0.1, 1, 10, 50 mm, or 0.001, 0.01, 0.1, 1 inch in
  inch mode.
- **Feeds** — separate jog feeds for XY and Z, kept between sessions.

Jogs work before anything is zeroed — that's how you get the tool to the stock to zero it.

---

## The go-to map

The **Go to** map shows the stock as set up in Setup, the tool's position (red crosshair),
work zero (red and green axis lines), and one of two things on the stock, depending on
what is picked in the sidebar:

- **Current design** — the toolpaths of the design open in FreazyKam.
- **A file from the SD card** — that file's toolpath, with its name and extent in the
  corner, and a **Runs off the stock** warning if it goes past the stock's edges.

Only cutting moves are drawn — rapids are left out — so the design and a file posted from
it look the same.

**Click anywhere on the map to send the tool there.** This needs X and Y zeroed and the
machine Idle; until then the map says what it's waiting for. If Z has been zeroed and the
tool is below the safe height, Z rises first, so the bit isn't dragged across the stock. A
blue circle marks where you clicked, with a dashed line from the tool, until the move
finishes. **STOP** or the jog pad's **⊗** cancels it.

---

## The SD card

The sidebar lists the files on the controller's SD card. Click a folder to open it, and
**↰** to go up.

| | |
|---|---|
| **Current design** | Shows the design open in FreazyKam on the map |
| **Send to card** | Writes the design's G-code to the card as `<project name>.nc` and loads it, ready to run. Replaces a file of the same name |
| **Upload** (header) | Copies a G-code file from your computer to the folder shown |
| **Refresh** (header) | Re-reads the card |
| **Click a file** | Loads it: reads it off the card and shows its toolpath on the map |
| **Bin** (on hover) | Deletes a file — click once to arm, again to confirm |

- **Loading only reads the file.** Nothing happens on the machine until you press **Run**.
- Uploading and deleting are switched off while a job is running, so the card isn't
  busy with two things at once.
- If a file has a **line longer than 80 characters**, loading it shows a warning. Recent
  FluidNC stops a job at a line over 127 characters with *"Line too long"*. Files
  FreazyKam writes never have such lines; files from elsewhere might.

---

## Running a job

The job box at the bottom of the sidebar names the loaded file.

**Run** starts it from the SD card. It is enabled only when:

- **X, Y and Z are all zeroed** — the job's coordinates mean nothing until they are.
- **The job is what the map is showing** — not the Current design — so what you see is
  what you cut.
- **The card is not busy** loading or uploading — otherwise Run could start the file
  you were moving away from.

While it runs, a **progress bar** shows how far through the file the controller has
read. (It reads a few moves ahead of the cut, so the bar leads the tool slightly.)

| Button | Does |
|---|---|
| **Pause** | Feed hold — slows to a stop and holds. The spindle keeps turning |
| **Resume** | Carries on from where it paused |
| **Cancel job** | Appears once a pause has fully stopped. Ends the job **without an alarm** — position and zero kept — and raises Z to the safe height |
| **Stop** (■) | Stops at once with a soft reset. The machine alarms, because it was moving |

**To end a job early, Pause then Cancel.** *Stopping…* shows while the machine slows
down; Cancel unlocks when it has come to rest. Stopping a moving machine with a reset can
lose position — the gantry's momentum makes the motors skip — which is why FluidNC alarms
and you would need to re-zero.

After a **Stop** or any alarm, press **Unlock** beside the state, then check the machine
before carrying on.

---

## Overrides

Change the feed and speed of a running job without stopping it.

| | |
|---|---|
| **Feed** | −10, −1, +1, +10 %, and ↺ back to 100 %. The actual feed rate is shown on the right |
| **Rapid** | 25, 50 or 100 % |
| **Spindle** | As Feed, for controllers that set the spindle speed |

The percentages shown are what the controller reports, so its limits (10–200 %) read
true. Anything other than 100 % shows in amber.

---

## The console

Everything the controller says, plus the commands FreazyKam sends (lines starting `>`).
Type G-code or a `$` command into the box at the bottom and press Enter. **Clear** empties
it.

Useful commands:

| Command | Does |
|---|---|
| `$X` | Clears an alarm (same as **Unlock**) |
| `$C` | Check mode: runs a job without moving, to prove the file works. `$C` again to leave |
| `[ESP420]` | The controller's status, including its WiFi signal |
| `[ESP410]` | The WiFi networks the controller can hear |

---

## When the link misbehaves

| Symptom | Likely cause | What to do |
|---|---|---|
| *No answer from the relay* on Connect | The controller is off, at a different address, or the relay isn't installed | Check the address; open `http://<controller>/freazykam` — see [Check it](#3-check-it) |
| The relay window downloads a file | The relay was saved under the wrong name | Re-upload it as `404.htm` |
| Connect works, then drops every few minutes | A weak or crowded WiFi link | Check the signal in the Connection section |
| Signal amber or red | The controller is too far from the router, or its antenna is boxed in | Move the antenna clear of metal; use a nearby WiFi extender |
| Connected to the wrong network | It joined the router instead of a closer extender | Give the extender its own network name, then point the controller at it (below) |
| *Line too long* stops a job | A line over 127 characters | Regenerate the file from FreazyKam, or shorten the line |

**Choosing which network the controller joins.** If your extender broadcasts the same
name as your router, the controller may join the farther one. Give the extender's
2.4 GHz network its own name (the controller only uses 2.4 GHz), then in the console:

```
$Sta/SSID=Your_Extender_Name
$Bye
```

`$Bye` restarts the controller onto the new network. Add `$Sta/Password=…` before it if
the extender's password is different. If the name or password is wrong, the controller
starts its own WiFi network (usually called *FluidNC*) instead — join that from your phone
and fix the settings in its WebUI.

**On a busy 2.4 GHz channel,** changing your router's 2.4 GHz channel to 1 or 11 can make
a large difference — the extender follows the router's channel by itself. Pick a fixed
channel rather than Auto, so the router doesn't switch mid-job.

---

## Next

- **[11. When something goes wrong](11-troubleshooting.md)** — problems with the design
  and its toolpaths
- **[Back to the guide](README.md)**
