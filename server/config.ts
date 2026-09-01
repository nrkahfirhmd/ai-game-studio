// Typed runtime configuration. Read process.env once here; never scatter it.

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

function int(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

function float(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function parseSize(raw: string, multiple: number, fallback: number): { width: number; height: number } {
  const m = raw.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
  const snap = (n: number) => Math.max(multiple * 4, Math.round(n / multiple) * multiple);
  if (!m) return { width: fallback, height: fallback };
  return { width: snap(Number(m[1])), height: snap(Number(m[2])) };
}

export const config = {
  port: int("PORT", 8787),

  ollama: {
    baseUrl: str("OLLAMA_BASE_URL", "http://127.0.0.1:11434").replace(/\/+$/, ""),
    textModel: str("OLLAMA_TEXT_MODEL", "qwen3:8b"),
  },

  comfyui: {
    baseUrl: str("COMFYUI_BASE_URL", "http://127.0.0.1:8188").replace(/\/+$/, ""),
    imageModel: str("COMFYUI_IMAGE_MODEL", "flux1-schnell-fp8.safetensors"),
    // Only used when COMFYUI_IMAGE_MODEL ends in .gguf (split model files).
    t5Model: str("COMFYUI_T5_MODEL", "t5xxl_fp8_e4m3fn.safetensors"),
    clipModel: str("COMFYUI_CLIP_MODEL", "clip_l.safetensors"),
    vaeModel: str("COMFYUI_VAE_MODEL", "ae.safetensors"),
    // Per-image wait cap. Local GGUF on modest hardware can take many minutes.
    timeoutMs: int("COMFYUI_TIMEOUT_S", 600) * 1000,
  },

  image: {
    // FLUX wants multiples of 16
    size: parseSize(str("IMAGE_SIZE", "1024x1024"), 16, 1024),
  },

  // Animation frames come from a local ComfyUI image-to-video workflow.
  // Default: Stable Video Diffusion (single checkpoint, stable node graph).
  // Point COMFYUI_VIDEO_WORKFLOW at an exported API-format workflow to use
  // LTX-Video / Wan2.1 / CogVideoX / etc. instead — see server/workflows/.
  video: {
    model: str("COMFYUI_VIDEO_MODEL", "svd_xt.safetensors"),
    workflowPath: process.env.COMFYUI_VIDEO_WORKFLOW?.trim() || null,
    frames: int("VIDEO_FRAMES", 25),
    motion: int("VIDEO_MOTION", 127), // SVD motion_bucket_id: 1–255, higher = more motion
    steps: int("VIDEO_STEPS", 20),
    // img2vid faithfulness to the input sprite (LTX-Video). Higher = keeps the
    // character + background, less camera drift; lower = more (often wrong) motion.
    strength: float("VIDEO_STRENGTH", 0.85),
    // SVD wants multiples of 64
    size: parseSize(str("VIDEO_SIZE", "768x768"), 64, 768),
    // Two-keyframe mode: FLUX img2img denoise for the generated end-pose sprite.
    // Higher = more pose change (less character consistency). 0 disables the
    // end-pose step (single-image I2V only).
    endPoseDenoise: float("VIDEO_ENDPOSE_DENOISE", 0),
    // How hard the video model pins the end-pose frame (LTXVAddGuide strength).
    // 1.0 = exact; lower lets it blend the start character back in.
    endGuideStrength: float("VIDEO_END_STRENGTH", 0.7),
    // Optional: exported img2img workflow for the end-pose sprite (tokens:
    // %IMAGE% %PROMPT% %SEED% %WIDTH% %HEIGHT% %DENOISE%). Use this for a
    // stronger model (FLUX Dev) or a ControlNet pose rig — FLUX Schnell can't
    // do a big pose change without also swapping the character.
    endPoseWorkflowPath: process.env.COMFYUI_ENDPOSE_WORKFLOW?.trim() || null,
  },

  features: {
    promptEnhancer: bool("ENABLE_PROMPT_ENHANCER", true),
  },
} as const;

export type Config = typeof config;
