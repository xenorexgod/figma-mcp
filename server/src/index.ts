import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
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

interface SseSession {
  response: ServerResponse;
  lastSeen: number;
}

loadEnv();

const isHostedMode = Boolean(process.env.PORT || process.env.MCP_HTTP_MODE === "true");
const bridge = new FigmaBridge({
  host: process.env.FIGMA_BRIDGE_HOST ?? "127.0.0.1",
  port: Number(process.env.FIGMA_BRIDGE_PORT ?? 4877),
  timeoutMs: Number(process.env.FIGMA_BRIDGE_TIMEOUT_MS ?? 30000),
  path: process.env.FIGMA_BRIDGE_PATH ?? "/figma"
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

bridge.on("listening", ({ host, port }) => {
  console.error(`Suits Figma bridge listening at ws://${host}:${port}`);
});
bridge.on("plugin-connected", () => {
  console.error("Suits Figma plugin connected.");
});
bridge.on("plugin-disconnected", () => {
  console.error("Suits Figma plugin disconnected.");
});

if (isHostedMode) {
  startHttpServer();
} else {
  startStdioServer();
}

function startHttpServer(): void {
  const sessions = new Map<string, SseSession>();
  const port = Number(process.env.PORT ?? 4878);
  const host = process.env.HOST ?? "0.0.0.0";
  const server = createServer(async (request, response) => {
    try {
      await routeHttpRequest(request, response, sessions);
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  bridge.attachToServer(server);
  server.listen(port, host, () => {
    console.error(`Suits Figma MCP HTTP server listening on ${host}:${port}`);
    console.error(`MCP SSE endpoint: /sse`);
    console.error(`Figma WebSocket endpoint: /figma`);
  });

  setInterval(() => {
    const cutoff = Date.now() - 1000 * 60 * 15;
    for (const [sessionId, session] of sessions) {
      if (session.lastSeen < cutoff || session.response.destroyed) {
        sessions.delete(sessionId);
      }
    }
  }, 1000 * 60).unref();
}

function startStdioServer(): void {
  bridge.start();

  let rpcBuffer = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
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
        void handleRpcRequest(JSON.parse(rawMessage) as JsonRpcRequest).then((message) => {
          if (message) sendStdioRpc(message);
        });
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
      }
    }
  });
}

async function routeHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  sessions: Map<string, SseSession>
): Promise<void> {
  const url = new URL(request.url ?? "/", publicBaseUrl(request));

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    sendJson(response, 200, {
      name: "suits-figma-mcp",
      ok: true,
      pluginConnected: bridge.isPluginConnected(),
      endpoints: {
        mcpSse: "/sse",
        mcpMessages: "/messages",
        mcpHttp: "/mcp",
        figmaWebSocket: "/figma"
      }
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/sse") {
    const sessionId = randomUUID();
    sessions.set(sessionId, { response, lastSeen: Date.now() });
    response.writeHead(200, {
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no"
    });
    writeSse(response, "endpoint", `/messages?sessionId=${sessionId}`);
    writeSse(response, "ready", JSON.stringify({ pluginConnected: bridge.isPluginConnected() }));
    request.on("close", () => sessions.delete(sessionId));
    return;
  }

  if (request.method === "POST" && url.pathname === "/messages") {
    const sessionId = url.searchParams.get("sessionId");
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      sendJson(response, 404, { error: "Unknown or expired SSE session." });
      return;
    }

    session.lastSeen = Date.now();
    const rpcRequest = JSON.parse(await readBody(request)) as JsonRpcRequest;
    const rpcResponse = await handleRpcRequest(rpcRequest);
    if (rpcResponse) writeSse(session.response, "message", JSON.stringify(rpcResponse));
    sendJson(response, 202, { ok: true });
    return;
  }

  if (request.method === "POST" && url.pathname === "/mcp") {
    const rpcRequest = JSON.parse(await readBody(request)) as JsonRpcRequest;
    const rpcResponse = await handleRpcRequest(rpcRequest);
    sendJson(response, 200, rpcResponse ?? { ok: true });
    return;
  }

  if (request.method === "GET" && url.pathname === "/mcp") {
    response.writeHead(200, {
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no"
    });
    writeSse(response, "ready", JSON.stringify({ pluginConnected: bridge.isPluginConnected() }));
    request.on("close", () => response.end());
    return;
  }

  sendJson(response, 404, { error: "Not found." });
}

async function handleRpcRequest(request: JsonRpcRequest): Promise<unknown | undefined> {
  if (request.id === undefined || request.id === null) return undefined;

  try {
    if (request.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "suits-figma-mcp", version: "0.2.0" }
        }
      };
    }

    if (request.method === "tools/list") {
      return { jsonrpc: "2.0", id: request.id, result: { tools } };
    }

    if (request.method === "tools/call") {
      const args = request.params?.arguments ?? {};
      const name = request.params?.name;

      switch (name) {
        case "create_deck":
          return { jsonrpc: "2.0", id: request.id, result: toolResult(await createDeck(bridge, args)) };
        case "update_slide":
          return { jsonrpc: "2.0", id: request.id, result: toolResult(await updateSlide(bridge, args)) };
        case "export_frames":
          return { jsonrpc: "2.0", id: request.id, result: toolResult(await exportFrames(bridge, args)) };
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    }

    throw new Error(`Unsupported method: ${request.method}`);
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

function sendStdioRpc(message: unknown): void {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json"
  });
  response.end(JSON.stringify(value));
}

function writeSse(response: ServerResponse, event: string, data: string): void {
  response.write(`event: ${event}\n`);
  for (const line of data.split(/\r?\n/)) {
    response.write(`data: ${line}\n`);
  }
  response.write("\n");
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function toolResult(value: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }]
  };
}

function publicBaseUrl(request: IncomingMessage): string {
  const host = request.headers.host ?? "localhost";
  const protocol = request.headers["x-forwarded-proto"] ?? "http";
  return `${protocol}://${host}`;
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
