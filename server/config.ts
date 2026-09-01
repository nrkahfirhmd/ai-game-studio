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

function parseSize(raw: string): { width: number; height: number } {
  const m = raw.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
  if (!m) return { width: 1024, height: 1024 };
  // FLUX wants multiples of 16
  const round16 = (n: number) => Math.max(256, Math.round(n / 16) * 16);
  return { width: round16(Number(m[1])), height: round16(Number(m[2])) };
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
    size: parseSize(str("IMAGE_SIZE", "1024x1024")),
  },

  frames: {
    denoise: float("FRAME_DENOISE", 0.65),
    countDefault: int("FRAME_COUNT_DEFAULT", 8),
    fps: 12, // legacy duration→count mapping only
  },

  features: {
    promptEnhancer: bool("ENABLE_PROMPT_ENHANCER", true),
  },
} as const;

export type Config = typeof config;
