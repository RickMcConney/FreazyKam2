# Install the relay file (once)

FreazyKam needs one small file on your FluidNC controller before it can connect. Do this
once per controller.

## 1. Find your FluidNC version

Open the controller's web page (`http://fluidnc.local`) and check **About**.

## 2. Download the relay

| FluidNC | File name | Get it from |
|---|---|---|
| **v4 or later** | `freazyKam.html` | **Machine** tab → **Download freazyKam.html** |
| **v3** | `404.htm` | **Machine** tab → **How to install** → **download it as 404.htm** |

Don't rename it.

## 3. Upload it

1. On the controller's web page, open **Files**.
2. Switch the drop-down from **SD** to **Flash**.
3. Click **Upload** and pick the file.

Don't touch `index.html.gz`.

## 4. Check it

Open `http://fluidnc.local/flash/freazyKam.html`.

| You see | Means |
|---|---|
| **FreazyKam link** | Done |
| A file downloads | v3: rename it to `404.htm` and upload again |
| Blank or not found | It's on SD, not Flash, or the name is wrong |

**v3 only:** the controller must join your WiFi, not run its own network.

**Next:** [Connect to your machine](connect-to-your-machine.md)

**Related:** [Why a relay is needed](../explanation/relay.md)
