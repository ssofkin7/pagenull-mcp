# @pagenull/mcp

An [MCP](https://modelcontextprotocol.io) server for [pagenull](https://pagenull.dev): let an AI assistant turn HTML or a URL
into a PDF or screenshot, render your templates, check receipts and see your usage. It runs on your machine over stdio and calls
the pagenull API with your own key.

Files come back to the assistant as base64, or are written to a path you give with `save_to`. pagenull keeps no copy either way.

## Tools

| Tool | What it does | API call |
|---|---|---|
| `render_pdf` | HTML or a public URL to PDF: format, margins, landscape, backgrounds, page numbers, test mode, and any other API option | `POST /v1/pdf` |
| `screenshot` | HTML or a public URL to PNG or JPEG | `POST /v1/screenshot` |
| `list_templates` | Your saved templates and the built-in ones | `GET /v1/templates` |
| `render_template` | A template plus JSON data to PDF | `POST /v1/templates/{id}/render` |
| `verify_receipt` | Check a receipt's signature with pagenull's published key, and that a file matches it | `GET /.well-known/pagenull-keys.json` |
| `get_usage` | This month's renders, limit and rate limit | `GET /v1/usage` |

Every render result has the file plus `renderId`, `receipt`, `warnings`, `pages`, `sha256` and `quota`. Errors come back with
the API's own `code` and `message` (see [errors](https://pagenull.dev/docs/api#errors)), so the assistant can fix the request.

`save_to` writes the file on your machine instead of returning base64. Use it for large files, and when you'd rather the
PDF didn't pass through the AI provider at all. The folder must exist; an existing file is only replaced with
`overwrite: true`.

## Settings

| Variable | |
|---|---|
| `PAGENULL_API_KEY` | Your API key, from the [dashboard](https://pagenull.dev/dashboard/keys). Needed for everything except `verify_receipt`. |
| `PAGENULL_API_BASE` | Optional. Default `https://api.pagenull.dev`. |

The server never logs, and the key only goes into the `Authorization` header of requests to the API.

## Setup

Requires Node.js 18 or later.

### Claude Desktop

In `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "pagenull": {
      "command": "npx",
      "args": ["-y", "@pagenull/mcp"],
      "env": { "PAGENULL_API_KEY": "pm_live_…" }
    }
  }
}
```

### Claude Code

```sh
claude mcp add pagenull -e PAGENULL_API_KEY=pm_live_… -- npx -y @pagenull/mcp
```

### Cursor

In `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project), the same `mcpServers` block as for Claude Desktop.

### VS Code

In `.vscode/mcp.json`. VS Code asks for the key once and keeps it out of the file:

```json
{
  "inputs": [{ "type": "promptString", "id": "pagenull-key", "description": "pagenull API key", "password": true }],
  "servers": {
    "pagenull": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@pagenull/mcp"],
      "env": { "PAGENULL_API_KEY": "${input:pagenull-key}" }
    }
  }
}
```

### Windows

- If the client says it can't find `npx`, run it through `cmd`: `"command": "cmd", "args": ["/c", "npx", "-y", "@pagenull/mcp"]`.
- To try the server by hand in PowerShell: `$env:PAGENULL_API_KEY = "pm_live_…"; npx -y @pagenull/mcp`. It then waits for
  an MCP client on stdin; stop it with Ctrl+C.
- `save_to` takes Windows paths, e.g. `C:\Users\you\Documents\invoice.pdf`.

## Privacy

pagenull renders and keeps nothing, whoever calls it. With an AI assistant in the loop, the HTML you ask it to render, and the
base64 PDF unless you use `save_to`, also pass through the AI provider, under that provider's own data policy. More on
[pagenull.dev/docs/ai-agents](https://pagenull.dev/docs/ai-agents).

## Development

```sh
pnpm --filter @pagenull/mcp build   # compiles to dist/
pnpm --filter @pagenull/mcp test    # mocked API, plus a stdio run of the built server
PAGENULL_MCP_LIVE=1 PAGENULL_API_KEY=pm_live_… pnpm --filter @pagenull/mcp test   # also one free test render on the live API
```

## Licence

MIT. See [LICENSE](LICENSE). This licence covers this package only.
