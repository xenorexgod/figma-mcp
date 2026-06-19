import type { FigmaBridge } from "../figmaBridge.ts";

export interface ExportFramesInput {
  frameIds?: string[];
  format: "PNG" | "JPG" | "SVG" | "PDF";
  scale: number;
}

export interface ExportedFrame {
  frameId: string;
  name: string;
  format: string;
  bytesBase64: string;
}

export interface ExportFramesResult {
  frames: ExportedFrame[];
}

export const exportFramesInputSchema = {
  type: "object",
  properties: {
    frameIds: { type: "array", items: { type: "string" } },
    format: { type: "string", enum: ["PNG", "JPG", "SVG", "PDF"], default: "PNG" },
    scale: { type: "number", minimum: 0.1, maximum: 4, default: 2 }
  }
};

export async function exportFrames(
  bridge: FigmaBridge,
  input: unknown
): Promise<ExportFramesResult> {
  const payload = normalizeExportFramesInput(input);
  return bridge.send<ExportFramesInput, ExportFramesResult>("exportFrames", payload);
}

function normalizeExportFramesInput(input: unknown): ExportFramesInput {
  const source = isRecord(input) ? input : {};
  const requestedFormat = typeof source.format === "string" ? source.format.toUpperCase() : "PNG";
  const format = ["PNG", "JPG", "SVG", "PDF"].includes(requestedFormat)
    ? requestedFormat as ExportFramesInput["format"]
    : "PNG";
  const scale = typeof source.scale === "number" && source.scale > 0 && source.scale <= 4
    ? source.scale
    : 2;

  return {
    frameIds: Array.isArray(source.frameIds) ? source.frameIds.map(String).filter(Boolean) : undefined,
    format,
    scale
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
