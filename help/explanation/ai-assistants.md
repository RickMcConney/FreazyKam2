# Working with an AI assistant

An AI assistant can drive FreazyKam for you: draw parts, set up the toolpaths, check the job
and write the G-code, from a plain request like *"cut out six 80 mm coasters from this
board"*. It works on the project open in your browser, while you watch.

## How it connects

```
  Your AI app  ──►  FreazyKam MCP server  ──►  Your FreazyKam tab
  (Claude, …)       (on your computer)         (in your browser)
```

**MCP** (Model Context Protocol) is a standard way for AI apps to use other programs. Your AI
app starts the FreazyKam MCP server, a small program on your computer. Your FreazyKam tab
connects to it, and tells it everything the assistant may do. The server only passes
messages between them.

New FreazyKam features reach your assistant when the app updates. You don't reinstall
anything.

## What it can do

Nearly everything you can do from the Draw and Paths tabs:

- **Read** the project: paths, toolpaths, tools, stock.
- **Draw** shapes and parts (gears, boxes, text, …), **change** their settings later, move,
  rotate, scale, mirror, group and delete them.
- **Import** SVG, DXF and pictures, and trace a picture into outlines.
- Use the **path tools**: offset, combine, pattern, text along a path, corners, nesting.
- **Make toolpaths** of every kind, add **tabs**, change the cut order.
- **Check the job** (the same check as Export G-code), read the G-code, and export it.
- Add a bit you own to your **tool library**, or change one.

[The full list](../reference/ai-assistant-tools.md).

## What it can't do

- **Run your machine.** The Machine tab is yours alone. The assistant can write a G-code
  file; only you can send it and press Run.
- **See the screen.** It reads numbers (sizes, depths, cut extents, run times), not pixels.
  Ask it to check something and it measures; it does not look.
- **Change your defaults.** The values it picks for one job are not saved as your form
  defaults.

## It shares your undo

Everything the assistant does is one ordinary step in the project's history, with a chip in
the Objects strip, exactly as if you had done it. **Undo** takes it back, and so can the
assistant. You can keep working alongside it: it sees your changes too.

Two things are not in the project, so undo can't reverse them:

- **Your tool library.** When it adds or changes a tool it should tell you. You can
  change it back in the **Tool Library**.
- **Files it writes.** A saved project copy or exported G-code stays on disk. It won't
  replace an existing file unless you say so.

Starting a **new project** or **opening** one would throw away unsaved work, so FreazyKam
refuses until the assistant has asked you and you have said yes.

## Check its work

An assistant is fluent, fast and sometimes wrong. Treat what it makes as you would a
drawing from someone else:

- **Simulate** the job, and read the depths and times.
- Read the **export check**. The assistant runs it too, but you're the one at the machine.
- Look at the cut side, the depth and the tabs before the first cut.

[What a simulation can't tell you](simulation-limits.md) applies to its jobs as much as
yours.

## Privacy

The server and FreazyKam talk over a connection that never leaves your computer. Only
FreazyKam itself (from `freazykam.com`, or a copy you run on your own computer) can connect
to the server. Other websites can't.

**What the assistant reads goes to your AI provider**, as part of your conversation:
path names, sizes, settings, G-code. That's how any AI assistant works. If a project is
confidential, keep the MCP switched off for it.

The switch is per browser, and it stays on until you untick it. Only one FreazyKam tab is
connected at a time. The newest one takes over, and the others can click **Take over** to
take it back.

**How-to:** [Connect an AI assistant](../how-to/connect-an-ai-assistant.md)
