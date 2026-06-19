figma.showUI(__html__, { width: 360, height: 420, themeColors: true });

type Layout = "title" | "section" | "content" | "metric" | "image" | "closing";
type ExportFormat = "PNG" | "JPG" | "SVG" | "PDF";

interface SlidePayload {
  title?: string;
  subtitle?: string;
  body?: string[];
  notes?: string;
  layout?: Layout;
  imagePath?: string;
}

interface ThemePayload {
  background: string;
  foreground: string;
  accent: string;
  muted: string;
}

interface BridgeRequest<TPayload = unknown> {
  id: string;
  command: "createDeck" | "updateSlide" | "exportFrames";
  payload: TPayload;
}

interface CreateDeckPayload {
  name: string;
  sourceDeckPath?: string;
  brandImagePath?: string;
  slides: SlidePayload[];
  theme: ThemePayload;
}

interface UpdateSlidePayload {
  frameId?: string;
  slideIndex?: number;
  slide: Partial<SlidePayload>;
}

interface ExportFramesPayload {
  frameIds?: string[];
  format: ExportFormat;
  scale: number;
}

const generatedFrameIds: string[] = [];
let currentTheme: ThemePayload = {
  background: "#050505",
  foreground: "#FFFFFF",
  accent: "#C9A24D",
  muted: "#A7A7A7"
};

figma.ui.onmessage = async (message: BridgeRequest) => {
  try {
    if (message.command === "createDeck") {
      const result = await createDeck(message.payload as CreateDeckPayload);
      figma.ui.postMessage({ id: message.id, ok: true, result });
      return;
    }

    if (message.command === "updateSlide") {
      const result = await updateSlide(message.payload as UpdateSlidePayload);
      figma.ui.postMessage({ id: message.id, ok: true, result });
      return;
    }

    if (message.command === "exportFrames") {
      const result = await exportFrames(message.payload as ExportFramesPayload);
      figma.ui.postMessage({ id: message.id, ok: true, result });
      return;
    }

    throw new Error(`Unknown command: ${message.command}`);
  } catch (error) {
    figma.ui.postMessage({
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};

async function createDeck(payload: CreateDeckPayload) {
  currentTheme = payload.theme;
  generatedFrameIds.length = 0;

  await figma.loadFontAsync({ family: "Inter", style: "Regular" });
  await figma.loadFontAsync({ family: "Inter", style: "Bold" });

  const section = figma.createSection();
  section.name = payload.name;
  section.x = figma.viewport.center.x - 640;
  section.y = figma.viewport.center.y - 360;

  payload.slides.forEach((slide, index) => {
    const frame = buildSlideFrame(slide, index, payload.theme);
    frame.x = index * 1360;
    frame.y = 0;
    section.appendChild(frame);
    generatedFrameIds.push(frame.id);
  });

  section.resizeWithoutConstraints(Math.max(1280, payload.slides.length * 1360), 840);
  figma.currentPage.selection = generatedFrameIds
    .map((id) => figma.getNodeById(id))
    .filter((node): node is FrameNode => node?.type === "FRAME");
  figma.viewport.scrollAndZoomIntoView(figma.currentPage.selection);

  return {
    deckName: payload.name,
    frameIds: [...generatedFrameIds],
    slideCount: generatedFrameIds.length
  };
}

async function updateSlide(payload: UpdateSlidePayload) {
  const frame = resolveFrame(payload.frameId, payload.slideIndex);
  const slideIndex = generatedFrameIds.indexOf(frame.id);
  const nextSlide: SlidePayload = {
    title: getPluginData(frame, "title"),
    subtitle: getPluginData(frame, "subtitle"),
    body: JSON.parse(getPluginData(frame, "body") || "[]"),
    layout: (getPluginData(frame, "layout") as Layout) || "content",
    ...payload.slide
  };

  frame.children.slice().forEach((child) => child.remove());
  applySlideContent(frame, nextSlide, slideIndex, currentTheme);
  setSlidePluginData(frame, nextSlide);

  return {
    frameId: frame.id,
    slideIndex,
    updated: true
  };
}

async function exportFrames(payload: ExportFramesPayload) {
  const ids = payload.frameIds?.length ? payload.frameIds : generatedFrameIds;
  const frames = ids.map((id) => {
    const node = figma.getNodeById(id);
    if (!node || node.type !== "FRAME") {
      throw new Error(`Frame not found: ${id}`);
    }
    return node;
  });

  const exported = [];
  for (const frame of frames) {
    const bytes = await frame.exportAsync({
      format: payload.format,
      constraint: payload.format === "SVG" || payload.format === "PDF"
        ? undefined
        : { type: "SCALE", value: payload.scale }
    });

    exported.push({
      frameId: frame.id,
      name: frame.name,
      format: payload.format,
      bytesBase64: figma.base64Encode(bytes)
    });
  }

  return { frames: exported };
}

function buildSlideFrame(slide: SlidePayload, index: number, theme: ThemePayload) {
  const frame = figma.createFrame();
  frame.name = `${String(index + 1).padStart(2, "0")} - ${slide.title || "Untitled"}`;
  frame.resize(1280, 720);
  frame.fills = [{ type: "SOLID", color: hexToRgb(theme.background) }];
  frame.clipsContent = true;
  applySlideContent(frame, slide, index, theme);
  setSlidePluginData(frame, slide);
  return frame;
}

function applySlideContent(frame: FrameNode, slide: SlidePayload, index: number, theme: ThemePayload) {
  const accentBar = figma.createRectangle();
  accentBar.name = "Accent Bar";
  accentBar.resize(8, 560);
  accentBar.x = 80;
  accentBar.y = 80;
  accentBar.fills = [{ type: "SOLID", color: hexToRgb(theme.accent) }];
  frame.appendChild(accentBar);

  const eyebrow = createText(`SUITS WORKSPACES  /  ${String(index + 1).padStart(2, "0")}`, 16, theme.muted, "Regular");
  eyebrow.x = 120;
  eyebrow.y = 86;
  eyebrow.resize(760, 28);
  frame.appendChild(eyebrow);

  const title = createText(slide.title || "Untitled slide", titleSizeForLayout(slide.layout), theme.foreground, "Bold");
  title.x = 120;
  title.y = slide.layout === "title" ? 210 : 145;
  title.resize(slide.layout === "metric" ? 760 : 920, 160);
  frame.appendChild(title);

  if (slide.subtitle) {
    const subtitle = createText(slide.subtitle, 30, theme.muted, "Regular");
    subtitle.x = 120;
    subtitle.y = title.y + title.height + 18;
    subtitle.resize(860, 84);
    frame.appendChild(subtitle);
  }

  const bodyTop = slide.subtitle ? title.y + title.height + 120 : title.y + title.height + 56;
  const bodyItems = slide.body ?? [];
  bodyItems.slice(0, 5).forEach((item, itemIndex) => {
    const line = createText(item, 24, theme.foreground, "Regular");
    line.x = 156;
    line.y = bodyTop + itemIndex * 54;
    line.resize(820, 42);
    frame.appendChild(line);

    const dot = figma.createEllipse();
    dot.name = "Bullet";
    dot.resize(9, 9);
    dot.x = 124;
    dot.y = line.y + 13;
    dot.fills = [{ type: "SOLID", color: hexToRgb(theme.accent) }];
    frame.appendChild(dot);
  });

  if (slide.layout === "metric") {
    const metricPanel = figma.createRectangle();
    metricPanel.name = "Metric Panel";
    metricPanel.resize(300, 420);
    metricPanel.x = 900;
    metricPanel.y = 150;
    metricPanel.cornerRadius = 8;
    metricPanel.fills = [{ type: "SOLID", color: hexToRgb("#171717") }];
    frame.appendChild(metricPanel);

    const metric = createText("CRE OS", 56, theme.accent, "Bold");
    metric.x = 940;
    metric.y = 250;
    metric.resize(220, 80);
    frame.appendChild(metric);
  }

  const footer = createText("Private deck frame generated through Suits Deck Bridge", 13, theme.muted, "Regular");
  footer.x = 120;
  footer.y = 650;
  footer.resize(620, 24);
  frame.appendChild(footer);
}

function resolveFrame(frameId?: string, slideIndex?: number): FrameNode {
  const id = frameId ?? (slideIndex !== undefined ? generatedFrameIds[slideIndex] : undefined);
  if (!id) throw new Error("No frame id or slide index was provided.");

  const node = figma.getNodeById(id);
  if (!node || node.type !== "FRAME") {
    throw new Error(`Frame not found: ${id}`);
  }
  return node;
}

function createText(content: string, fontSize: number, color: string, style: "Regular" | "Bold") {
  const node = figma.createText();
  node.fontName = { family: "Inter", style };
  node.characters = content;
  node.fontSize = fontSize;
  node.lineHeight = { unit: "PERCENT", value: 116 };
  node.fills = [{ type: "SOLID", color: hexToRgb(color) }];
  return node;
}

function titleSizeForLayout(layout: Layout = "content") {
  if (layout === "title" || layout === "closing") return 64;
  if (layout === "section") return 56;
  if (layout === "metric") return 48;
  return 44;
}

function setSlidePluginData(frame: FrameNode, slide: SlidePayload) {
  frame.setPluginData("title", slide.title ?? "");
  frame.setPluginData("subtitle", slide.subtitle ?? "");
  frame.setPluginData("body", JSON.stringify(slide.body ?? []));
  frame.setPluginData("layout", slide.layout ?? "content");
}

function getPluginData(node: BaseNode & PluginDataMixin, key: string) {
  return node.getPluginData(key);
}

function hexToRgb(hex: string): RGB {
  const normalized = hex.replace("#", "");
  const value = Number.parseInt(
    normalized.length === 3
      ? normalized.split("").map((character) => character + character).join("")
      : normalized,
    16
  );

  return {
    r: ((value >> 16) & 255) / 255,
    g: ((value >> 8) & 255) / 255,
    b: (value & 255) / 255
  };
}
