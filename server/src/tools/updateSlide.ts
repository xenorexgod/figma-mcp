import type { FigmaBridge } from "../figmaBridge.ts";
import { normalizeSlide, type SlideInput } from "./createDeck.ts";

export interface UpdateSlideInput {
  frameId?: string;
  slideIndex?: number;
  slide: Partial<SlideInput>;
}

export interface UpdateSlideResult {
  frameId: string;
  slideIndex: number;
  updated: boolean;
}

export const updateSlideInputSchema = {
  type: "object",
  properties: {
    frameId: { type: "string" },
    slideIndex: { type: "number", minimum: 0 },
    slide: {
      type: "object",
      properties: {
        title: { type: "string" },
        subtitle: { type: "string" },
        body: { type: "array", items: { type: "string" } },
        notes: { type: "string" },
        layout: { type: "string", enum: ["title", "section", "content", "metric", "image", "closing"] },
        imagePath: { type: "string" }
      }
    }
  },
  required: ["slide"]
};

export async function updateSlide(
  bridge: FigmaBridge,
  input: unknown
): Promise<UpdateSlideResult> {
  const payload = normalizeUpdateSlideInput(input);
  return bridge.send<UpdateSlideInput, UpdateSlideResult>("updateSlide", payload);
}

function normalizeUpdateSlideInput(input: unknown): UpdateSlideInput {
  if (!isRecord(input)) throw new Error("update_slide input must be an object.");
  const frameId = typeof input.frameId === "string" && input.frameId.trim()
    ? input.frameId.trim()
    : undefined;
  const slideIndex = Number.isInteger(input.slideIndex) && Number(input.slideIndex) >= 0
    ? Number(input.slideIndex)
    : undefined;

  if (!frameId && slideIndex === undefined) {
    throw new Error("Provide either frameId or slideIndex.");
  }

  return {
    frameId,
    slideIndex,
    slide: normalizeSlide(input.slide, true)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
