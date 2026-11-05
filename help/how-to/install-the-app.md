# Install FreazyKam and use it offline

Installing gives FreazyKam its own window and lets it open with no internet, which is handy
if your shop has none.

## Install it

**Chrome or Edge:**

1. Open [FreazyKam](/app/).
2. Click the **Install** icon at the right of the address bar. If it isn't there in Chrome,
   open the **⋮** menu and choose **Cast, Save and Share**, then the install option.
3. Click **Install**.

It then opens from your Applications folder or Start menu, like any other app.

**Safari on a Mac** (macOS 14 or later):

1. Open [FreazyKam](/app/).
2. Choose **File > Add to Dock**.
3. Click **Add**.

The Safari app starts empty: tools, settings and autosaves stay in Safari. Open it once with
internet so it can work offline.

## Use it offline

Open FreazyKam once with internet. The status bar says **FreazyKam can now open without
internet** when it's ready. After that it opens anywhere, installed or in a normal browser
tab, as long as it's the same browser.

Everything works offline: drawing, toolpaths, the simulator, G-code and your machine. Only
the Help and Guide pages need internet.

Your machine doesn't use the internet. FreazyKam talks to it over your shop network, so it
works offline once the [relay](install-the-relay.md) is installed.

## Get updates

FreazyKam checks for a new version whenever it's open and online. When one is ready, the
status bar shows **Update ready, reload**. Click it when it suits you.

Nothing changes until you click. An update never reloads FreazyKam by itself.

**Connected to a machine?** The button says **Update ready, disconnect to install** and
can't be clicked. Reloading drops the connection, and FreazyKam can't reconnect while the
machine is moving, so wait until the job is done, then disconnect.

## Good to know

- The address has to be `https://freazykam.com`. Offline doesn't work from a plain `http://`
  address or a file on your computer, except `localhost`.
- The first visit downloads about 20 MB in the background.

**Why a relay?** [Why the machine needs a relay file](../explanation/relay.md)
