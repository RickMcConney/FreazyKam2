# 13. Working with an AI assistant

FreazyKam can be driven by an AI assistant: Claude, ChatGPT, Cursor, or any other AI app
that supports **MCP**, the Model Context Protocol. You describe the job in plain words, and
the assistant draws the parts, sets up the toolpaths, checks the job and writes the G-code,
in the project open in your browser, while you watch.

It's not a separate mode. The assistant uses the same actions you do, through the same undo
history, so you can stop it, take over, undo what it did, or carry on by hand at any point.

---

## How it fits together

```
  Your AI app  ──stdio──►  freazykam-mcp  ──local connection──►  Your FreazyKam tab
```

- **Your AI app** starts the **FreazyKam MCP server** (`freazykam-mcp`), a small program
  that runs on your computer. You set this up once.
- **Your FreazyKam tab** connects to the server when you allow it, and tells it what an
  assistant may do there.
- **The server** passes requests and answers between them. It knows nothing about CAM
  itself, which is why new FreazyKam features reach your assistant as soon as the app
  updates, with nothing to reinstall.

## Setting it up

You need [Node.js](https://nodejs.org) 18 or later, which runs the server.

**1. Add the server to your AI app.** In **Claude Desktop**: Settings → Developer →
**Edit Config**, and add this to `claude_desktop_config.json` (inside the existing
`mcpServers` section, if the file has one):

```json
{
  "mcpServers": {
    "freazykam": { "command": "npx", "args": ["-y", "freazykam-mcp"] }
  }
}
```

In **Claude Code**, run:

```
claude mcp add freazykam -- npx -y freazykam-mcp
```

Any other MCP app: add a server whose command is `npx -y freazykam-mcp`.

**2. Restart your AI app.** From now on it starts the server itself.

**3. Allow the connection in FreazyKam.** Click **MCP** in the toolbar and tick **Allow AI
assistants to connect to this tab**. The light beside it, and on the toolbar button, turns
green within a few seconds. The setting is remembered, so next time there is nothing to do.

| Light | Means |
|---|---|
| Green | Connected |
| Amber | Waiting for the server: is your AI app running, set up as above? |
| Grey | Off, or another FreazyKam tab has taken the connection (**Take over** takes it back) |
| Red | The connection failed, and the dialog says why |

While connected, the dialog also shows the assistant's last request, which is a quick way to
see that it's really talking to this tab.

The server listens on port 47615. If something else on your computer uses it, open
**Port** at the bottom of the dialog and choose another. The setup commands shown above it
change to match, so copy them into your AI app again.

## A first session

Ask for something small first:

> What's in my FreazyKam project?

The assistant reads the project and reports the stock, the paths and the toolpaths. Then a
real job:

> Draw a 30-tooth gear, module 2, in the middle of the stock. Cut the bore and the spokes
> out with my 1/8" end mill, then the outline with four tabs, all through the stock.

The assistant draws the gear, finds the tool in your library, makes the toolpaths, adds the
tabs, and runs the export check. Check the cut order it chose in **Paths → Toolpaths**: the
holes should come before the outline, so the part is still held while they are cut. Ask it
to reorder them if not. Each step appears on the canvas and as a chip in the Objects strip as it
happens.

Then change your mind:

> Make it 36 teeth.

It changes the gear's settings, as you would in the Properties panel, rather than drawing a
new one. The toolpaths that cut it regenerate to follow.

## What it can and can't do

It can do nearly everything the **Draw** and **Paths** tabs can:

- read the project, the tool library and the stock;
- draw any shape or part, change its settings later, and move, rotate, scale, mirror, group
  and delete;
- import SVG, DXF and pictures, and trace a picture into outlines;
- offset, combine, pattern, round corners, lay text along a path, and nest parts;
- make every kind of toolpath, add tabs, and change the cut order;
- run the export check, read the G-code, and export it to a file;
- add a bit you own to your tool library, or change one.

The full list is in the help's
[reference](../help/reference/ai-assistant-tools.md).

It **can't**:

- **run your machine.** The Machine tab is yours alone. The assistant can write a G-code
  file; only you send it and press Run;
- **see the screen.** It works from numbers: sizes, depths, cut extents, run times,
  warnings. Asked to check something, it measures; it doesn't look;
- **change your defaults.** What it picks for one job isn't saved as your form defaults.

## Undo, and what undo doesn't cover

Everything the assistant does to the project is an ordinary step in its history, with a chip
in the Objects strip. **Undo** reverses it, whether you press it or the assistant asks for it.
You can work alongside it: it sees your changes the next time it looks.

Three things sit outside the project, so undo doesn't reach them:

- **The tool library.** Adding or changing a tool changes your library, which outlives the
  project. The assistant is told to say so when it does. Change it back in the
  **Tool Library** tab.
- **Files.** A project copy it saves, or G-code it exports, stays on disk. It won't replace an
  existing file unless you have told it to.
- **Opening a project or starting a new one.** These replace what's open. If the open project
  has unsaved changes, FreazyKam refuses until the assistant has asked you and you have
  agreed.

## Checking its work

An assistant is quick and confident, and sometimes wrong in ways that look perfectly
reasonable. Check its jobs exactly as you would a file from someone else:

- **simulate** the job and read the readouts (chapter 10);
- read the **export check** yourself — the assistant runs it, but you're the one at the
  machine;
- look at the cut side, the depth and the tabs before the first cut.

## Privacy and safety

The server and the FreazyKam tab talk over a connection that never leaves your computer.
Only FreazyKam's own pages (`freazykam.com`, or a copy running on your own computer) can
connect. Other websites you have open can't.

**What the assistant reads is sent to your AI provider**, as part of the conversation: path
names, sizes, settings and G-code. That is how every AI assistant works. For a project you
want to keep to yourself, leave the MCP switched off.

Only one FreazyKam tab is connected at a time. Opening a second tab with the switch on moves
the connection to it, and the first shows **Take over** to bring it back.
