// ComfyUI backend.
//   Image  → FLUX.1 Schnell text2img (reference sprite).
//   Frames → image-to-video: Stable Video Diffusion by default, or any
//            exported API-format workflow via COMFYUI_VIDEO_WORKFLOW.
// Flow for both: (upload ref) → POST /prompt → poll /history → GET /view.

import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { readPngDims, ROOT_DIR } from "../files.js";
import { normalizeImageToPng } from "../image-normalize.js";
import {
  BackendUnavailableError,
  GenerationError,
  ModelNotInstalledError,
  type BackendHealth,
  type ImageGenerationRequest,
  type ImageGenerationResponse,
} from "./types.js";

const { baseUrl, imageModel } = config.comfyui;
const CLIENT_ID = "ai-game-studio";

const POLL_INTERVAL_MS = 1500;
const POLL_MAX_ATTEMPTS = Math.ceil(config.comfyui.timeoutMs / POLL_INTERVAL_MS);

const UNAVAILABLE_HINT = "Start ComfyUI (python main.py) and check COMFYUI_BASE_URL.";
const MODEL_HINT = "Put the checkpoint in ComfyUI/models/checkpoints/ and restart ComfyUI.";

// ---- shared client ----

async function comfyFetch(pathname: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${baseUrl}${pathname}`, init);
  } catch {
    throw new BackendUnavailableError("ComfyUI", baseUrl, UNAVAILABLE_HINT);
  }
}

function dataUrlToBuffer(dataUrl: string): { buffer: Buffer; ext: string } {
  const m = dataUrl.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!m) throw new GenerationError("reference image is not a valid data URL");
  const ext = m[1] === "jpeg" ? "jpg" : m[1];
  return { buffer: Buffer.from(m[2], "base64"), ext };
}

async function uploadImage(dataUrl: string): Promise<string> {
  const { buffer, ext } = dataUrlToBuffer(dataUrl);
  const name = `ags-ref-${Date.now()}.${ext}`;
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(buffer)], { type: "image/png" }), name);
  form.append("overwrite", "true");
  const res = await comfyFetch("/upload/image", { method: "POST", body: form });
  if (!res.ok) throw new GenerationError(`ComfyUI rejected the reference image (HTTP ${res.status})`);
  const json = (await res.json().catch(() => ({}))) as { name?: string };
  if (!json.name) throw new GenerationError("ComfyUI upload returned no filename");
  return json.name;
}

interface OutputFile {
  filename: string;
  subfolder: string;
  type: string;
}
interface HistoryEntry {
  outputs?: Record<string, { images?: OutputFile[]; gifs?: OutputFile[]; videos?: OutputFile[] }>;
  status?: { status_str?: string };
}

/** Submit a workflow graph, poll until it lands in history, return the entry. */
async function runWorkflow(
  graph: Record<string, unknown>,
  missingModelName: string,
  what: string,
  missingHint = MODEL_HINT,
): Promise<HistoryEntry> {
  const submitRes = await comfyFetch("/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph, client_id: CLIENT_ID }),
  });
  const submitJson = (await submitRes.json().catch(() => ({}))) as {
    prompt_id?: string;
    error?: { message?: string };
  };

  if (!submitRes.ok || !submitJson.prompt_id) {
    const errMsg = submitJson.error?.message ?? `HTTP ${submitRes.status}`;
    if (/ckpt_name|unet_name|checkpoint|value not in list|not in list/i.test(JSON.stringify(submitJson))) {
      throw new ModelNotInstalledError("ComfyUI", missingModelName, missingHint);
    }
    throw new GenerationError(`ComfyUI rejected the ${what} workflow: ${errMsg}`);
  }

  const promptId = submitJson.prompt_id;
  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const histRes = await comfyFetch(`/history/${promptId}`);
    if (!histRes.ok) continue;
    const hist = (await histRes.json().catch(() => ({}))) as Record<string, HistoryEntry>;
    if (hist[promptId]) {
      const entry = hist[promptId];
      if (entry.status?.status_str === "error") {
        throw new GenerationError(`${what} failed in ComfyUI (see the ComfyUI console)`);
      }
      return entry;
    }
  }
  throw new GenerationError(
    `ComfyUI did not finish the ${what} within ${Math.round(config.comfyui.timeoutMs / 1000)}s ` +
      `(raise COMFYUI_TIMEOUT_S if your hardware is slow)`,
  );
}

async function fetchOutput(f: OutputFile): Promise<Buffer> {
  const params = new URLSearchParams({
    filename: f.filename,
    subfolder: f.subfolder ?? "",
    type: f.type ?? "output",
  });
  const res = await comfyFetch(`/view?${params}`);
  if (!res.ok) throw new GenerationError(`Failed to download output from ComfyUI (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

// ---- image: FLUX.1 Schnell ----

function buildImageWorkflow(opts: {
  positive: string;
  width: number;
  height: number;
  seed: number;
  denoise: number;
  inputImageName?: string;
}): Record<string, unknown> {
  const isGguf = /\.gguf$/i.test(imageModel);
  const clipRef = isGguf ? ["1c", 0] : ["1", 1];
  const vaeRef = isGguf ? ["1v", 0] : ["1", 2];

  const g: Record<string, unknown> = {
    "1": isGguf
      ? { class_type: "UnetLoaderGGUF", inputs: { unet_name: imageModel } }
      : { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: imageModel } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: opts.positive, clip: clipRef } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: "", clip: clipRef } },
    "5": {
      class_type: "KSampler",
      inputs: {
        seed: opts.seed,
        steps: 4,
        cfg: 1.0,
        sampler_name: "euler",
        scheduler: "simple",
        denoise: opts.inputImageName ? opts.denoise : 1.0,
        model: ["1", 0],
        positive: ["2", 0],
        negative: ["3", 0],
        latent_image: [opts.inputImageName ? "4b" : "4", 0],
      },
    },
    "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: vaeRef } },
    "7": { class_type: "SaveImage", inputs: { filename_prefix: "ags", images: ["6", 0] } },
  };

  if (isGguf) {
    g["1c"] = {
      class_type: "DualCLIPLoader",
      inputs: { clip_name1: config.comfyui.t5Model, clip_name2: config.comfyui.clipModel, type: "flux" },
    };
    g["1v"] = { class_type: "VAELoader", inputs: { vae_name: config.comfyui.vaeModel } };
  }
  if (opts.inputImageName) {
    g["4a"] = { class_type: "LoadImage", inputs: { image: opts.inputImageName } };
    g["4b"] = { class_type: "VAEEncode", inputs: { pixels: ["4a", 0], vae: vaeRef } };
  } else {
    g["4"] = {
      class_type: "EmptyLatentImage",
      inputs: { width: opts.width, height: opts.height, batch_size: 1 },
    };
  }
  return g;
}

export async function generateImage(
  req: ImageGenerationRequest,
): Promise<ImageGenerationResponse> {
  const width = req.width ?? config.image.size.width;
  const height = req.height ?? config.image.size.height;
  const seed = req.seed ?? randomInt(1, 2 ** 31);
  const denoise = req.denoise ?? 0.65;
  const inputImageName = req.image ? await uploadImage(req.image) : undefined;

  // img2img + a custom end-pose workflow configured → use it (stronger model /
  // ControlNet). Otherwise the built-in FLUX graph.
  const endPoseWf = config.video.endPoseWorkflowPath;
  const graph =
    inputImageName && endPoseWf
      ? (substituteTokens(await loadCustomWorkflow(endPoseWf), {
          "%IMAGE%": inputImageName,
          "%PROMPT%": req.prompt,
          "%SEED%": seed,
          "%WIDTH%": width,
          "%HEIGHT%": height,
          "%DENOISE%": denoise,
        }) as Record<string, unknown>)
      : buildImageWorkflow({ positive: req.prompt, width, height, seed, denoise, inputImageName });

  const entry = await runWorkflow(graph, imageModel, "image");

  const files = Object.values(entry.outputs ?? {}).flatMap((o) => o.images ?? []);
  const file = files.find((f) => f.type !== "temp") ?? files[0];
  if (!file) throw new GenerationError("ComfyUI produced no image output");

  const raw = await fetchOutput(file);
  const base64 = await normalizeImageToPng(raw.toString("base64"));
  const dims = readPngDims(Buffer.from(base64, "base64")) ?? { w: width, h: height };
  return { base64, width: dims.w, height: dims.h };
}

// ---- frames: image-to-video ----

const VIDEO_TOKENS = (name: string, prompt: string, seed: number, endName?: string) => ({
  "%IMAGE%": name,
  "%IMAGE_END%": endName ?? name, // falls back to the start frame if no end pose
  "%PROMPT%": prompt,
  "%NEG_PROMPT%":
    "camera movement, zoom, pan, dolly, cropping, background change, " +
    "scene change, blurry, smeared, melting, deformed, static, frozen, watermark, text",
  "%SEED%": seed,
  "%FRAMES%": config.video.frames,
  "%WIDTH%": config.video.size.width,
  "%HEIGHT%": config.video.size.height,
  "%MOTION%": config.video.motion,
  "%STRENGTH%": config.video.strength,
  "%END_STRENGTH%": config.video.endGuideStrength,
  "%STEPS%": config.video.steps,
});

const workflowCache = new Map<string, string>();
async function loadCustomWorkflow(p: string): Promise<Record<string, unknown>> {
  let raw = workflowCache.get(p);
  if (raw === undefined) {
    const abs = path.isAbsolute(p) ? p : path.join(ROOT_DIR, p);
    try {
      raw = await readFile(abs, "utf8");
    } catch {
      throw new GenerationError(
        `workflow file not found: ${p} (export an API-format workflow from ComfyUI)`,
      );
    }
    workflowCache.set(p, raw);
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

/** Replace %TOKENS% throughout a workflow graph. A lone token becomes its raw
 *  (possibly numeric) value; an embedded token is string-substituted. */
function substituteTokens(node: unknown, tokens: Record<string, string | number>): unknown {
  if (typeof node === "string") {
    if (node in tokens) return tokens[node];
    let out = node;
    for (const [k, v] of Object.entries(tokens)) out = out.split(k).join(String(v));
    return out;
  }
  if (Array.isArray(node)) return node.map((n) => substituteTokens(n, tokens));
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, substituteTokens(v, tokens)]),
    );
  }
  return node;
}

/** Built-in Stable Video Diffusion graph — single checkpoint, stable nodes. */
function buildSvdWorkflow(imageName: string, seed: number): Record<string, unknown> {
  const { width, height } = config.video.size;
  return {
    "1": { class_type: "ImageOnlyCheckpointLoader", inputs: { ckpt_name: config.video.model } },
    "2": { class_type: "LoadImage", inputs: { image: imageName } },
    "3": {
      class_type: "SVD_img2vid_Conditioning",
      inputs: {
        clip_vision: ["1", 1],
        init_image: ["2", 0],
        vae: ["1", 2],
        width,
        height,
        video_frames: config.video.frames,
        motion_bucket_id: config.video.motion,
        fps: 6,
        augmentation_level: 0.0,
      },
    },
    "4": { class_type: "VideoLinearCFGGuidance", inputs: { model: ["1", 0], min_cfg: 1.0 } },
    "5": {
      class_type: "KSampler",
      inputs: {
        seed,
        steps: config.video.steps,
        cfg: 2.5,
        sampler_name: "euler",
        scheduler: "karras",
        denoise: 1.0,
        model: ["4", 0],
        positive: ["3", 0],
        negative: ["3", 1],
        latent_image: ["3", 2],
      },
    },
    "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    "7": { class_type: "SaveImage", inputs: { filename_prefix: "ags-frame", images: ["6", 0] } },
  };
}

/** Split an encoded clip (mp4/webm/webp/gif) into ordered PNG frames (base64). */
async function extractClipFrames(buffer: Buffer, ext: string): Promise<string[]> {
  const dir = await mkdtemp(path.join(tmpdir(), "ags-clip-"));
  try {
    const clipPath = path.join(dir, `clip.${ext}`);
    await writeFile(clipPath, buffer);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "ffmpeg",
        ["-hide_banner", "-loglevel", "error", "-y", "-i", clipPath, path.join(dir, "f-%05d.png")],
        { stdio: ["ignore", "ignore", "inherit"] },
      );
      child.on("error", (err) =>
        reject("code" in err && err.code === "ENOENT" ? new Error("ffmpeg is not installed") : err),
      );
      child.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`ffmpeg clip extract exited with ${code}`)),
      );
    });
    const pngs = (await readdir(dir)).filter((f) => f.endsWith(".png")).sort();
    return Promise.all(pngs.map(async (f) => (await readFile(path.join(dir, f))).toString("base64")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Run the image-to-video workflow, return ordered frame PNGs (base64, pre chroma-key). */
export async function generateVideoFrames(opts: {
  image: string; // data URL, start frame
  endImage?: string; // data URL, end frame (two-keyframe mode)
  prompt: string;
  seed?: number;
}): Promise<string[]> {
  const seed = opts.seed ?? randomInt(1, 2 ** 31);
  const imageName = await uploadImage(opts.image);
  const endName = opts.endImage ? await uploadImage(opts.endImage) : undefined;

  const custom = config.video.workflowPath;
  const graph = custom
    ? (substituteTokens(
        await loadCustomWorkflow(custom),
        VIDEO_TOKENS(imageName, opts.prompt, seed, endName),
      ) as Record<string, unknown>)
    : buildSvdWorkflow(imageName, seed);

  const videoHint = custom
    ? `Check the models named in ${custom} are installed in ComfyUI.`
    : `svd_xt.safetensors must be in ComfyUI/models/checkpoints/. Low on VRAM? ` +
      `Set COMFYUI_VIDEO_WORKFLOW to an LTX-Video / Wan2.1 GGUF workflow — see server/workflows/README.md.`;
  const entry = await runWorkflow(graph, config.video.model, "image-to-video", videoHint);

  const outputs = Object.values(entry.outputs ?? {});
  const clipFile =
    outputs.flatMap((o) => o.videos ?? []).at(0) ?? outputs.flatMap((o) => o.gifs ?? []).at(0);

  if (clipFile) {
    const buffer = await fetchOutput(clipFile);
    const ext = (clipFile.filename.split(".").pop() || "webp").toLowerCase();
    const frames = await extractClipFrames(buffer, ext);
    if (frames.length === 0) throw new GenerationError("clip contained no frames");
    return frames;
  }

  const imageFiles = outputs.flatMap((o) => o.images ?? []).filter((f) => f.type !== "temp");
  if (imageFiles.length === 0) throw new GenerationError("ComfyUI produced no frames");
  return Promise.all(imageFiles.map(async (f) => (await fetchOutput(f)).toString("base64")));
}

// ---- health ----

async function checkModel(node: string, field: string, model: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/object_info/${node}`);
    if (!res.ok) return false;
    const info = (await res.json()) as Record<
      string,
      { input?: { required?: Record<string, unknown[][]> } }
    >;
    const list = info[node]?.input?.required?.[field]?.[0];
    return Array.isArray(list) && list.includes(model);
  } catch {
    return false;
  }
}

export async function health(): Promise<BackendHealth> {
  const base: BackendHealth = {
    backend: "comfyui",
    baseUrl,
    reachable: false,
    model: imageModel,
    installed: false,
  };
  try {
    const statsRes = await fetch(`${baseUrl}/system_stats`);
    if (!statsRes.ok) return { ...base, reachable: true };
  } catch {
    return base;
  }

  const isGguf = /\.gguf$/i.test(imageModel);
  const installed = await checkModel(
    isGguf ? "UnetLoaderGGUF" : "CheckpointLoaderSimple",
    isGguf ? "unet_name" : "ckpt_name",
    imageModel,
  );
  return { ...base, reachable: true, installed };
}
