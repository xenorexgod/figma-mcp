import type { FigmaBridge } from "../figmaBridge.ts";

export type SlideLayout = "title" | "section" | "content" | "metric" | "image" | "closing";

export interface SlideInput {
  title: string;
  subtitle?: string;
  body: string[];
  notes?: string;
  layout: SlideLayout;
  imagePath?: string;
}

export interface CreateDeckInput {
  name: string;
  sourceDeckPath?: string;
  brandImagePath?: string;
  slides: SlideInput[];
  theme: {
    background: string;
    foreground: string;
    accent: string;
    muted: string;
  };
}

export interface CreateDeckResult {
  deckName: string;
  frameIds: string[];
  slideCount: number;
}

export const createDeckInputSchema = {
  type: "object",
  properties: {
    name: { type: "string", default: "Suits Workspaces Pitch Deck" },
    sourceDeckPath: { type: "string" },
    brandImagePath: { type: "string" },
    slides: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          subtitle: { type: "string" },
          body: { type: "array", items: { type: "string" }, default: [] },
          notes: { type: "string" },
          layout: {
            type: "string",
            enum: ["title", "section", "content", "metric", "image", "closing"],
            default: "content"
          },
          imagePath: { type: "string" }
        },
        required: ["title"]
      }
    },
    theme: {
      type: "object",
      properties: {
        background: { type: "string", default: "#050505" },
        foreground: { type: "string", default: "#FFFFFF" },
        accent: { type: "string", default: "#C9A24D" },
        muted: { type: "string", default: "#A7A7A7" }
      }
    }
  },
  required: ["slides"]
};

export async function createDeck(
  bridge: FigmaBridge,
  input: unknown
): Promise<CreateDeckResult> {
  const payload = normalizeCreateDeckInput(input);
  return bridge.send<CreateDeckInput, CreateDeckResult>("createDeck", payload);
}

export function normalizeSlide(input: unknown, partial = false): Partial<SlideInput> {
  if (!isRecord(input)) throw new Error("Slide must be an object.");
  const output: Partial<SlideInput> = {};

  if (typeof input.title === "string" && input.title.trim()) output.title = input.title.trim();
  else if (!partial) throw new Error("Slide title is required.");

  if (typeof input.subtitle === "string") output.subtitle = input.subtitle;
  if (Array.isArray(input.body)) output.body = input.body.map(String);
  else if (!partial) output.body = [];
  if (typeof input.notes === "string") output.notes = input.notes;
  if (typeof input.imagePath === "string") output.imagePath = input.imagePath;

  const layout = typeof input.layout === "string" ? input.layout : "content";
  if (["title", "section", "content", "metric", "image", "closing"].includes(layout)) {
    output.layout = layout as SlideLayout;
  } else if (!partial) {
    output.layout = "content";
  }

  return output;
}

function normalizeCreateDeckInput(input: unknown): CreateDeckInput {
  if (!isRecord(input)) throw new Error("create_deck input must be an object.");
  if (!Array.isArray(input.slides) || input.slides.length === 0) {
    throw new Error("create_deck requires at least one slide.");
  }

  const theme = isRecord(input.theme) ? input.theme : {};

  return {
    name: typeof input.name === "string" && input.name.trim()
      ? input.name.trim()
      : "Suits Workspaces Pitch Deck",
    sourceDeckPath: typeof input.sourceDeckPath === "string" ? input.sourceDeckPath : undefined,
    brandImagePath: typeof input.brandImagePath === "string" ? input.brandImagePath : undefined,
    slides: input.slides.map((slide) => normalizeSlide(slide) as SlideInput),
    theme: {
      background: stringOrDefault(theme.background, "#050505"),
      foreground: stringOrDefault(theme.foreground, "#FFFFFF"),
      accent: stringOrDefault(theme.accent, "#C9A24D"),
      muted: stringOrDefault(theme.muted, "#A7A7A7")
    }
  };
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
