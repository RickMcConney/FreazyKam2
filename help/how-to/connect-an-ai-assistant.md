# Connect an AI assistant

Let Claude, ChatGPT, Cursor or another AI app that supports **MCP** work with the project
open in FreazyKam. Do steps 1–3 once per computer.

## 1. Install Node.js

Get [Node.js](https://nodejs.org) 18 or later, if you don't have it. The FreazyKam MCP server
runs on it.

## 2. Add the server to your AI app

| AI app | Do this |
|---|---|
| **Claude Desktop** | Settings → Developer → **Edit Config**, and add the block below to `claude_desktop_config.json` |
| **Claude Code** | Run `claude mcp add freazykam -- npx -y freazykam-mcp` |
| **Any other MCP app** | Add a server whose command is `npx -y freazykam-mcp` |

```json
{
  "mcpServers": {
    "freazykam": { "command": "npx", "args": ["-y", "freazykam-mcp"] }
  }
}
```

If the file already has an `mcpServers` section, add the `freazykam` entry inside it.

## 3. Restart your AI app

It starts the server for you from now on.

## 4. Turn it on in FreazyKam

1. Click **MCP** in the toolbar.
2. Tick **Allow AI assistants to connect to this tab**.
3. The light turns green within a few seconds.

The light also shows on the **MCP** button, so you can close the dialog and still see it.

| Light | Means |
|---|---|
| 🟢 Green | Connected. Ask away |
| 🟠 Amber | Waiting for the server. Is your AI app running, set up as in step 2? |
| ⚪ Grey | Off, or another FreazyKam tab took over. Click **Take over** to bring it back |
| 🔴 Red | The connection failed. The dialog says why |

## 5. Ask

Start with something small, to see it working:

> What's in my FreazyKam project?

Then try something real:

> Draw a 100 mm hexagon in the middle of the stock and cut it out with my 1/4" end mill,
> 12 mm deep, with four tabs.

## If something else uses port 47615

Open **Port** at the bottom of the MCP dialog and pick another. The setup commands in the
dialog change to match: copy them again into your AI app.

**Related:** [What an assistant can and can't do](../explanation/ai-assistants.md) ·
[Everything it can ask FreazyKam to do](../reference/ai-assistant-tools.md)
