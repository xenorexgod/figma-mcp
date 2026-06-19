import { existsSync, readFileSync } from "node:fs";
import { FigmaBridge } from "./figmaBridge.ts";
import { createDeck, createDeckInputSchema } from "./tools/createDeck.ts";
import { updateSlide, updateSlideInputSchema } from "./tools/updateSlide.ts";
import { exportFrames, exportFramesInputSchema } from "./tools/exportFrames.ts";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: {
    name?: string;
    arguments?: unknown;
  };
}

loadEnv();

const bridge = new FigmaBridge({
  host: process.env.FIGMA_BRIDGE_HOST ?? "127.0.0.1",
  port: Number(process.env.FIGMA_BRIDGE_PORT ?? 4877),
  timeoutMs: Number(process.env.FIGMA_BRIDGE_TIMEOUT_MS ?? 30000)
});

const tools = [
  {
    name: "create_deck",
    description:
      "Create a Suits Workspaces pitch deck as 16:9 Figma frames using structured slide content.",
    inputSchema: createDeckInputSchema
  },
  {
    name: "update_slide",
    description:
      "Update an existing Suits pitch deck slide frame by frame id or zero-based slide index.",
    inputSchema: updateSlideInputSchema
  },
  {
    name: "export_frames",
    description:
      "Export selected Figma deck frames, or all generated deck frames, as base64 assets.",
    inputSchema: exportFramesInputSchema
  }
];

bridge.start();
bridge.on("listening", ({ host, port }) => {
  console.error(`Suits Figma bridge listening at ws://${host}:${port}`);
});
bridge.on("plugin-connected", () => {
  console.error("Suits Figma plugin connected.");
});
bridge.on("plugin-disconnected", () => {
  console.error("Suits Figma plugin disconnected.");
});

let rpcBuffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => readRpcChunk(chunk));

async function handleRequest(request: JsonRpcRequest): Promise<void> {
  if (request.id === undefined || request.id === null) return;

  try {
    if (request.method === "initialize") {
      sendRpc({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "suits-figma-mcp", version: "0.1.0" }
        }
      });
      return;
    }

    if (request.method === "tools/list") {
      sendRpc({ jsonrpc: "2.0", id: request.id, result: { tools } });
      return;
    }

    if (request.method === "tools/call") {
      const args = request.params?.arguments ?? {};
      const name = request.params?.name;

      switch (name) {
        case "create_deck":
          sendRpc({ jsonrpc: "2.0", id: request.id, result: toolResult(await createDeck(bridge, args)) });
          return;
        case "update_slide":
          sendRpc({ jsonrpc: "2.0", id: request.id, result: toolResult(await updateSlide(bridge, args)) });
          return;
        case "export_frames":
          sendRpc({ jsonrpc: "2.0", id: request.id, result: toolResult(await exportFrames(bridge, args)) });
          return;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    }

    throw new Error(`Unsupported method: ${request.method}`);
  } catch (error) {
    sendRpc({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error)
      }
    });
  }
}

function readRpcChunk(chunk: Buffer): void {
  rpcBuffer = Buffer.concat([rpcBuffer, chunk]);

  while (rpcBuffer.length > 0) {
    const headerEnd = rpcBuffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;

    const header = rpcBuffer.subarray(0, headerEnd).toString("utf8");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      rpcBuffer = Buffer.alloc(0);
      return;
    }

    const contentLength = Number(match[1]);
    const messageStart = headerEnd + 4;
    const messageEnd = messageStart + contentLength;
    if (rpcBuffer.length < messageEnd) return;

    const rawMessage = rpcBuffer.subarray(messageStart, messageEnd).toString("utf8");
    rpcBuffer = rpcBuffer.subarray(messageEnd);

    try {
      void handleRequest(JSON.parse(rawMessage) as JsonRpcRequest);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
}

function sendRpc(message: unknown): void {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function toolResult(value: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }]
  };
}

function loadEnv(): void {
  const envPath = new URL("../.env", import.meta.url);
  if (!existsSync(envPath)) return;

  const contents = readFileSync(envPath, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    process.env[key] ??= value;
  }
}

process.on("SIGINT", () => {
  bridge.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  bridge.stop();
  process.exit(0);
});
