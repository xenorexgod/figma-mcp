import { randomUUID, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";

export type FigmaBridgeCommand = "createDeck" | "updateSlide" | "exportFrames";

export interface FigmaBridgeRequest<TPayload = unknown> {
  id: string;
  command: FigmaBridgeCommand;
  payload: TPayload;
}

export interface FigmaBridgeResponse<TResult = unknown> {
  id: string;
  ok: boolean;
  result?: TResult;
  error?: string;
}

interface PendingRequest {
  resolve: (value: FigmaBridgeResponse) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface FigmaBridgeOptions {
  host: string;
  port: number;
  timeoutMs: number;
}

export class FigmaBridge extends EventEmitter {
  private readonly pending = new Map<string, PendingRequest>();
  private pluginSocket?: Socket;
  private server?: Server;
  private readonly options: FigmaBridgeOptions;

  constructor(options: FigmaBridgeOptions) {
    super();
    this.options = options;
  }

  start(): void {
    if (this.server) return;

    this.server = createServer();
    this.server.on("upgrade", (request, socket) => this.handleUpgrade(request, socket));
    this.server.on("listening", () => this.emit("listening", this.options));
    this.server.listen(this.options.port, this.options.host);
  }

  stop(): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Bridge stopped before Figma responded to ${id}.`));
    }

    this.pending.clear();
    this.pluginSocket?.destroy();
    this.server?.close();
    this.pluginSocket = undefined;
    this.server = undefined;
  }

  isPluginConnected(): boolean {
    return Boolean(this.pluginSocket && !this.pluginSocket.destroyed);
  }

  async send<TPayload, TResult>(
    command: FigmaBridgeCommand,
    payload: TPayload
  ): Promise<TResult> {
    if (!this.isPluginConnected() || !this.pluginSocket) {
      throw new Error(
        `Figma plugin is not connected. Open the Suits Deck Bridge plugin and connect to ws://${this.options.host}:${this.options.port}.`
      );
    }

    const id = randomUUID();
    const request: FigmaBridgeRequest<TPayload> = { id, command, payload };

    const response = await new Promise<FigmaBridgeResponse<TResult>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Figma to complete ${command}.`));
      }, this.options.timeoutMs);

      this.pending.set(id, { resolve: resolve as PendingRequest["resolve"], reject, timer });

      try {
        this.sendWebSocketText(this.pluginSocket as Socket, JSON.stringify(request));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    if (!response.ok) {
      throw new Error(response.error ?? `Figma command ${command} failed.`);
    }

    return response.result as TResult;
  }

  private handleUpgrade(request: IncomingMessage, socket: Socket): void {
    const key = request.headers["sec-websocket-key"];
    if (!key || Array.isArray(key)) {
      socket.destroy();
      return;
    }

    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");

    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        ""
      ].join("\r\n")
    );

    this.pluginSocket?.destroy();
    this.pluginSocket = socket;
    this.emit("plugin-connected");

    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const parsed = this.parseFrames(buffer);
      buffer = parsed.remaining;
      parsed.messages.forEach((message) => this.handlePluginMessage(message));
    });

    socket.on("close", () => {
      if (this.pluginSocket === socket) {
        this.pluginSocket = undefined;
        this.emit("plugin-disconnected");
      }
    });
  }

  private parseFrames(buffer: Buffer): { messages: string[]; remaining: Buffer } {
    const messages: string[] = [];
    let offset = 0;

    while (offset + 2 <= buffer.length) {
      const opcode = buffer[offset] & 0x0f;
      const secondByte = buffer[offset + 1];
      const isMasked = (secondByte & 0x80) === 0x80;
      let payloadLength = secondByte & 0x7f;
      let headerLength = 2;

      if (payloadLength === 126) {
        if (offset + 4 > buffer.length) break;
        payloadLength = buffer.readUInt16BE(offset + 2);
        headerLength = 4;
      } else if (payloadLength === 127) {
        if (offset + 10 > buffer.length) break;
        const high = buffer.readUInt32BE(offset + 2);
        const low = buffer.readUInt32BE(offset + 6);
        payloadLength = high * 2 ** 32 + low;
        headerLength = 10;
      }

      const maskLength = isMasked ? 4 : 0;
      const frameLength = headerLength + maskLength + payloadLength;
      if (offset + frameLength > buffer.length) break;

      const maskOffset = offset + headerLength;
      const payloadOffset = maskOffset + maskLength;
      const payload = Buffer.from(buffer.subarray(payloadOffset, payloadOffset + payloadLength));

      if (isMasked) {
        const mask = buffer.subarray(maskOffset, maskOffset + 4);
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4];
        }
      }

      if (opcode === 0x1) messages.push(payload.toString("utf8"));
      if (opcode === 0x8) this.pluginSocket?.end();

      offset += frameLength;
    }

    return { messages, remaining: buffer.subarray(offset) };
  }

  private sendWebSocketText(socket: Socket, message: string): void {
    const payload = Buffer.from(message, "utf8");
    let header: Buffer;

    if (payload.length < 126) {
      header = Buffer.from([0x81, payload.length]);
    } else if (payload.length <= 65535) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(payload.length, 6);
    }

    socket.write(Buffer.concat([header, payload]));
  }

  private handlePluginMessage(rawMessage: string): void {
    let response: FigmaBridgeResponse;

    try {
      response = JSON.parse(rawMessage) as FigmaBridgeResponse;
    } catch {
      this.emit("plugin-message-error", rawMessage);
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    pending.resolve(response);
  }
}
