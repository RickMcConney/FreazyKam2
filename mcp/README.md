# freazykam-mcp

Lets an AI assistant — Claude, ChatGPT, Cursor or any other MCP client — work with the
project open in [FreazyKam](https://freazykam.com), the browser-based CNC CAM app: read it, draw
shapes, create toolpaths and tabs, check the job and read the G-code.

```
AI app ──stdio──► freazykam-mcp ──ws://127.0.0.1:47615──► your FreazyKam tab
```

It runs on your computer and talks to FreazyKam over a local connection only. It cannot run
your machine.

## Setup

Needs [Node.js](https://nodejs.org) 18 or later. Any MCP client runs it with the command
`npx -y freazykam-mcp` (stdio). For example:

**Claude Desktop** — Settings → Developer → Edit Config, and add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "freazykam": { "command": "npx", "args": ["-y", "freazykam-mcp"] }
  }
}
```

**Claude Code:**

```
claude mcp add freazykam -- npx -y freazykam-mcp
```

Then restart your AI app, open FreazyKam, click **MCP** in the toolbar and turn on
**Allow AI assistants to connect to this tab**. The light turns green when they are connected.

## How it works

The FreazyKam page declares its own tools when it connects; this server only relays them.
New FreazyKam features reach your assistant when the page updates — this package does not need to.

Only pages from `https://freazykam.com` (and `localhost`, for development) may connect.

## Options

| Environment variable | Default | |
| --- | --- | --- |
| `FREAZYKAM_MCP_PORT` | `47615` | Port to listen on; set the same port in FreazyKam's MCP dialog |
| `FREAZYKAM_MCP_ORIGINS` | | Extra page origins allowed to connect, comma-separated |
| `FREAZYKAM_MCP_CACHE` | `~/.cache/freazykam-mcp/tools-<port>.json` | Where the last tab's tool list is kept |

## License

MIT — see [LICENSE](LICENSE).
