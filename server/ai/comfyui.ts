// ComfyUI image backend, running FLUX.1 Schnell.
// Flow: (optional) upload ref image → POST /prompt (workflow graph) → poll /history
//       → GET /view the SaveImage output → normalize to PNG.

import { randomInt } from "node:crypto";
import { config } from "../config.js";
import { readPngDims } from "../files.js";
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

const POLL_INTERVAL_MS = 750;
const POLL_MAX_ATTEMPTS = 200; // ~2.5 min

const UNAVAILABLE_HINT =
  "Start ComfyUI (python main.py) and check COMFYUI_BASE_URL.";
const MODEL_HINT =
  "Put the checkpoint in ComfyUI/models/checkpoints/ and restart ComfyUI.";

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
  if (!res.ok) {
    throw new GenerationError(`ComfyUI rejected the reference image (HTTP ${res.status})`);
  }
  const json = (await res.json().catch(() => ({}))) as { name?: string };
  if (!json.name) throw new GenerationError("ComfyUI upload returned no filename");
  return json.name;
}

// ---- Workflow graph (FLUX.1 Schnell, API format) ----

function buildWorkflow(opts: {
  positive: string;
  width: number;
  height: number;
  seed: number;
  denoise: number;
  inputImageName?: string;
}): Record<string, unknown> {
  const g: Record<string, unknown> = {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: imageModel },
    },
    "2": {
      class_type: "CLIPTextEncode",
      inputs: { text: opts.positive, clip: ["1", 1] },
    },
    "3": {
      class_type: "CLIPTextEncode",
      inputs: { text: "", clip: ["1", 1] },
    },
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
    "6": {
      class_type: "VAEDecode",
      inputs: { samples: ["5", 0], vae: ["1", 2] },
    },
    "7": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "ags", images: ["6", 0] },
    },
  };

  if (opts.inputImageName) {
    g["4a"] = { class_type: "LoadImage", inputs: { image: opts.inputImageName } };
    g["4b"] = { class_type: "VAEEncode", inputs: { pixels: ["4a", 0], vae: ["1", 2] } };
  } else {
    g["4"] = {
      class_type: "EmptyLatentImage",
      inputs: { width: opts.width, height: opts.height, batch_size: 1 },
    };
  }

  return g;
}

interface HistoryEntry {
  outputs?: Record<
    string,
    { images?: Array<{ filename: string; subfolder: string; type: string }> }
  >;
  status?: { status_str?: string; completed?: boolean; messages?: unknown[] };
}

export async function generateImage(
  req: ImageGenerationRequest,
): Promise<ImageGenerationResponse> {
  const width = req.width ?? config.image.size.width;
  const height = req.height ?? config.image.size.height;
  const seed = req.seed ?? randomInt(1, 2 ** 31);
  const denoise = req.denoise ?? config.frames.denoise;

  const inputImageName = req.image ? await uploadImage(req.image) : undefined;

  const workflow = buildWorkflow({
    positive: req.prompt,
    width,
    height,
    seed,
    denoise,
    inputImageName,
  });

  const submitRes = await comfyFetch("/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: CLIENT_ID }),
  });

  const submitJson = (await submitRes.json().catch(() => ({}))) as {
    prompt_id?: string;
    error?: { message?: string; type?: string };
    node_errors?: Record<string, unknown>;
  };

  if (!submitRes.ok || !submitJson.prompt_id) {
    const errMsg = submitJson.error?.message ?? `HTTP ${submitRes.status}`;
    if (/ckpt_name|checkpoint|value not in list/i.test(JSON.stringify(submitJson))) {
      throw new ModelNotInstalledError("ComfyUI", imageModel, MODEL_HINT);
    }
    throw new GenerationError(`ComfyUI rejected the workflow: ${errMsg}`);
  }

  const promptId = submitJson.prompt_id;

  let entry: HistoryEntry | undefined;
  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const histRes = await comfyFetch(`/history/${promptId}`);
    if (!histRes.ok) continue;
    const hist = (await histRes.json().catch(() => ({}))) as Record<string, HistoryEntry>;
    if (hist[promptId]) {
      entry = hist[promptId];
      break;
    }
  }

  if (!entry) {
    throw new GenerationError("ComfyUI did not finish the image in time");
  }
  if (entry.status?.status_str === "error") {
    throw new GenerationError("Image generation failed in ComfyUI (see the ComfyUI console)");
  }

  const image = Object.values(entry.outputs ?? {})
    .flatMap((o) => o.images ?? [])
    .find((im) => im.type !== "temp") ??
    Object.values(entry.outputs ?? {}).flatMap((o) => o.images ?? [])[0];

  if (!image) {
    throw new GenerationError("ComfyUI produced no image output");
  }

  const params = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder ?? "",
    type: image.type ?? "output",
  });
  const viewRes = await comfyFetch(`/view?${params}`);
  if (!viewRes.ok) {
    throw new GenerationError(`Failed to download image from ComfyUI (HTTP ${viewRes.status})`);
  }

  const raw = Buffer.from(await viewRes.arrayBuffer());
  const base64 = await normalizeImageToPng(raw.toString("base64"));
  const dims = readPngDims(Buffer.from(base64, "base64")) ?? { w: width, h: height };

  return { base64, width: dims.w, height: dims.h };
}

export async function health(): Promise<BackendHealth> {
  const base: BackendHealth = {
    backend: "comfyui",
    baseUrl,
    reachable: false,
    model: imageModel,
    installed: false,
  };

  let statsRes: Response;
  try {
    statsRes = await fetch(`${baseUrl}/system_stats`);
  } catch {
    return base;
  }
  if (!statsRes.ok) return { ...base, reachable: true };

  try {
    const infoRes = await fetch(`${baseUrl}/object_info/CheckpointLoaderSimple`);
    if (!infoRes.ok) return { ...base, reachable: true };
    const info = (await infoRes.json()) as Record<
      string,
      { input?: { required?: { ckpt_name?: unknown[][] } } }
    >;
    const list = info.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
    const installed = Array.isArray(list) && list.includes(imageModel);
    return { ...base, reachable: true, installed };
  } catch {
    return { ...base, reachable: true };
  }
}
