# Suits Figma MCP

Local MCP server and Figma plugin bridge for creating, updating, and exporting Suits Workspaces pitch deck frames in Figma.

## Structure

```text
server/
  package.json
  .env
  src/
    index.ts
    figmaBridge.ts
    tools/
      createDeck.ts
      updateSlide.ts
      exportFrames.ts
figma-plugin/
  manifest.json
  code.ts
  ui.html
```

## Run

```bash
cd server
npm start
```

The server exposes MCP tools over stdio and starts a local WebSocket bridge at:

```text
ws://127.0.0.1:4877
```

Open the Figma plugin, click `Connect`, then call the MCP tools from your client:

- `create_deck`
- `update_slide`
- `export_frames`

The server is intentionally dependency-free for the initial scaffold and runs directly on Node 24.
