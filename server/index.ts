import "dotenv/config";
import express, { type Response } from "express";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { config } from "./config.js";
import { getProvider } from "./ai/provider.js";
import {
  BackendUnavailableError,
  GenerationError,
  ModelNotInstalledError,
} from "./ai/types.js";
import {
  DEFAULT_IMAGE_MODEL,
  IMAGE_MODELS,
  generateSpriteImage,
} from "./image.js";
import { enhancePrompt, type EnhanceKind } from "./prompt.js";
import { generateFrames } from "./frames.js";
import { buildPreviewGif } from "./build-gif.js";
import {
  LATEST_DIR,
  PROJECTS_DIR,
  PROJECT_FILES,
  ROOT_DIR,
  ensureInsideRoot,
  readPngDims,
  saveBase64Image,
  saveDataUrlPng,
} from "./files.js";
import {
  deleteSavedProject,
  emptyManifest,
  listSavedProjects,
  loadProjectIntoLatest,
  readManifest,
  saveLatestAs,
  toView,
  updateLatest,
  wipeLatestFramesAndSheet,
  wipeLatestSpritesheet,
} from "./projects.js";
import { rm } from "node:fs/promises";

const PORT = config.port;

// Motion "model" dropdown: same backend as the sprite image. `defaultDuration`
// now carries the default frame count (the field name is kept for the client).
const VIDEO_MODELS = IMAGE_MODELS.map((m) => ({
  id: m.id,
  label: m.label,
  defaultDuration: config.frames.countDefault,
}));
const DEFAULT_VIDEO_MODEL = DEFAULT_IMAGE_MODEL;

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use("/projects", express.static(PROJECTS_DIR, { fallthrough: false }));

function asString(v: unknown, name: string, max = 4_000): string {
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  if (v.length > max) throw new Error(`${name} is too long`);
  return v.trim();
}

function asImageRef(v: unknown): string {
  if (typeof v !== "string" || v.length === 0) throw new Error("image is required");
  if (v.length > 50_000_000) throw new Error("image is too large");
  return v;
}

app.get("/api/health", async (_req, res) => {
  try {
    const h = await getProvider().health();
    res.json({ ok: true, ...h });
  } catch {
    res.json({ ok: false });
  }
});

app.get("/api/models/image", (_req, res) => {
  res.json({ models: IMAGE_MODELS, default: DEFAULT_IMAGE_MODEL });
});

app.get("/api/models/video", (_req, res) => {
  res.json({ models: VIDEO_MODELS, default: DEFAULT_VIDEO_MODEL });
});

app.get("/api/config", (_req, res) => {
  res.json({ promptEnhancer: config.features.promptEnhancer });
});

app.post("/api/prompt/enhance", async (req, res) => {
  try {
    if (!config.features.promptEnhancer) throw new Error("prompt enhancer is disabled");
    const kind = req.body?.kind;
    if (kind !== "sprite" && kind !== "motion") throw new Error("kind must be 'sprite' or 'motion'");
    const prompt = asString(req.body?.prompt, "prompt");
    const enhanced = await enhancePrompt(kind as EnhanceKind, prompt);
    res.json({ enhanced });
  } catch (err) {
    handleError(err, res);
  }
});

app.get("/api/projects/current", async (_req, res) => {
  try {
    res.json(toView(await readManifest("latest")));
  } catch (err) {
    handleError(err, res);
  }
});

app.get("/api/projects", async (_req, res) => {
  try {
    res.json(await listSavedProjects());
  } catch (err) {
    handleError(err, res);
  }
});

app.post("/api/projects/save", async (req, res) => {
  try {
    res.json(await saveLatestAs(asString(req.body?.name, "name", 40)));
  } catch (err) {
    handleError(err, res);
  }
});

app.post("/api/projects/load", async (req, res) => {
  try {
    res.json(await loadProjectIntoLatest(asString(req.body?.name, "name", 40)));
  } catch (err) {
    handleError(err, res);
  }
});

app.post("/api/projects/new", async (_req, res) => {
  try {
    if (existsSync(LATEST_DIR)) await rm(LATEST_DIR, { recursive: true, force: true });
    res.json(toView(emptyManifest("latest")));
  } catch (err) {
    handleError(err, res);
  }
});

app.post("/api/projects/delete", async (req, res) => {
  try {
    await deleteSavedProject(asString(req.body?.name, "name", 40));
    res.json({ ok: true });
  } catch (err) {
    handleError(err, res);
  }
});

app.post("/api/projects/selection", async (req, res) => {
  try {
    const indices = req.body?.selectedIndices;
    if (!Array.isArray(indices) || indices.some((i) => typeof i !== "number")) {
      throw new Error("selectedIndices must be an array of numbers");
    }
    res.json(toView(await updateLatest({ selectedFrameIndices: indices })));
  } catch (err) {
    handleError(err, res);
  }
});

app.post("/api/projects/spritesheet", async (req, res) => {
  try {
    const dataUrl = asString(req.body?.dataUrl, "dataUrl", 50_000_000);
    const spritesheetAbs = path.join(LATEST_DIR, PROJECT_FILES.spritesheet);
    await saveDataUrlPng(dataUrl, spritesheetAbs);

    let m = await updateLatest({ spritesheet: PROJECT_FILES.spritesheet });

    try {
      const gifName = await buildPreviewGif(m.selectedFrameIndices);
      m = await updateLatest({ previewGif: gifName });
    } catch (gifErr) {
      console.warn(
        "[api] preview gif build failed:",
        gifErr instanceof Error ? gifErr.message : String(gifErr),
      );
      m = await updateLatest({ previewGif: null });
    }

    res.json(toView(m));
  } catch (err) {
    handleError(err, res);
  }
});

app.post("/api/sprites/generate", async (req, res) => {
  try {
    const prompt = asString(req.body?.prompt, "prompt");
    const base64 = await generateSpriteImage(prompt);

    await wipeLatestFramesAndSheet();

    const refAbs = path.join(LATEST_DIR, PROJECT_FILES.ref);
    await saveBase64Image(base64, refAbs);
    const dims = readPngDims(await readFile(refAbs));

    const m = await updateLatest({
      spritePrompt: prompt,
      spriteModel: DEFAULT_IMAGE_MODEL,
      sprite: PROJECT_FILES.ref,
      spriteDimensions: dims,
      frames: [],
      selectedFrameIndices: [],
      spritesheet: null,
      previewGif: null,
    });

    res.json({ view: toView(m), dataUrl: `data:image/png;base64,${base64}` });
  } catch (err) {
    handleError(err, res);
  }
});

app.post("/api/sprites/animate", async (req, res) => {
  try {
    const image = asImageRef(req.body?.image);
    const text = asString(req.body?.text, "text");

    let frameCount = config.frames.countDefault;
    if (typeof req.body?.frameCount === "number") {
      frameCount = req.body.frameCount;
    } else if (typeof req.body?.duration === "number") {
      // legacy: seconds → frames
      frameCount = Math.round(req.body.duration * config.frames.fps);
    }

    const imageInput = await resolveImageInput(image);

    await wipeLatestSpritesheet();

    const framesAbs = path.join(LATEST_DIR, PROJECT_FILES.framesDir);
    const frameFiles = await generateFrames({
      image: imageInput,
      motionPrompt: text,
      frameCount,
      framesDir: framesAbs,
    });
    const frames = frameFiles.map((f) => `${PROJECT_FILES.framesDir}/${f}`);

    const m = await updateLatest({
      motionPrompt: text,
      motionModel: DEFAULT_IMAGE_MODEL,
      frames,
      selectedFrameIndices: frames.map((_, i) => i),
      spritesheet: null,
      previewGif: null,
    });

    res.json(toView(m));
  } catch (err) {
    handleError(err, res);
  }
});

async function resolveImageInput(image: string): Promise<string> {
  if (image.startsWith("data:")) return image;
  if (image.startsWith("/projects/")) {
    const cleanPath = image.split("?")[0];
    const abs = path.join(ROOT_DIR, cleanPath.replace(/^\//, ""));
    ensureInsideRoot(abs);
    if (!existsSync(abs)) throw new Error("sprite image not found on disk");
    const buf = await readFile(abs);
    return `data:image/png;base64,${buf.toString("base64")}`;
  }
  throw new Error("unsupported image reference");
}

function handleError(err: unknown, res: Response) {
  const message = err instanceof Error ? err.message : "Unknown error";
  console.error("[api error]", err);

  let status = 400;
  if (err instanceof BackendUnavailableError) status = 503;
  else if (err instanceof ModelNotInstalledError) status = 422;
  else if (err instanceof GenerationError) status = 502;

  res.status(status).json({ error: message });
}

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  getProvider()
    .health()
    .then((h) => {
      if (!h.text.reachable) {
        console.warn(
          `[server] Ollama unreachable at ${h.text.baseUrl} — text/enhancer disabled until it is running (ollama serve)`,
        );
      } else if (!h.text.installed) {
        console.warn(
          `[server] Ollama model "${h.text.model}" not installed — run: ollama pull ${h.text.model}`,
        );
      }
      if (!h.image.reachable) {
        console.warn(
          `[server] ComfyUI unreachable at ${h.image.baseUrl} — image generation will fail until it is running (python main.py)`,
        );
      } else if (!h.image.installed) {
        console.warn(
          `[server] ComfyUI checkpoint "${h.image.model}" not found in models/checkpoints/`,
        );
      }
    })
    .catch(() => {});
});
