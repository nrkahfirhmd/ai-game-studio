// Provider-agnostic AI interface. Application code depends on this, never on a
// concrete backend (Ollama / ComfyUI).

export interface TextGenerationRequest {
  system?: string;
  prompt: string;
  json?: boolean;
  temperature?: number;
}

export interface TextGenerationResponse {
  text: string;
}

export interface ImageGenerationRequest {
  prompt: string;
  /** data: URL — when set, run img2img from this reference. */
  image?: string;
  width?: number;
  height?: number;
  /** img2img strength (0–1); ignored for pure text2img. */
  denoise?: number;
  seed?: number;
}

export interface ImageGenerationResponse {
  /** normalized PNG, base64 (no data: prefix) */
  base64: string;
  width: number;
  height: number;
}

export interface BackendHealth {
  backend: string;
  baseUrl: string;
  reachable: boolean;
  model: string;
  installed: boolean;
}

export interface ProviderHealth {
  text: BackendHealth;
  image: BackendHealth;
}

export interface FramesRequest {
  /** data: URL of the reference sprite (start / first frame) */
  image: string;
  /** data: URL of the end-pose sprite (last frame) — two-keyframe mode */
  endImage?: string;
  /** motion prompt (+ any directives) — used by text-conditioned video models */
  prompt: string;
  seed?: number;
}

/** Ordered animation frames as base64 PNGs, before chroma-keying. */
export type FramesResponse = string[];

export interface AIProvider {
  generateText(req: TextGenerationRequest): Promise<TextGenerationResponse>;
  generateImage(req: ImageGenerationRequest): Promise<ImageGenerationResponse>;
  generateFrames(req: FramesRequest): Promise<FramesResponse>;
  health(): Promise<ProviderHealth>;
}

/** Backend unreachable (connection refused / DNS / timeout). */
export class BackendUnavailableError extends Error {
  constructor(
    public backend: string,
    public baseUrl: string,
    public hint: string,
  ) {
    super(`Cannot connect to ${backend} at ${baseUrl}. ${hint}`);
    this.name = "BackendUnavailableError";
  }
}

/** Configured model / checkpoint not installed on the backend. */
export class ModelNotInstalledError extends Error {
  constructor(
    public backend: string,
    public model: string,
    public hint: string,
  ) {
    super(`${backend} model "${model}" is not installed. ${hint}`);
    this.name = "ModelNotInstalledError";
  }
}

/** Backend reached but the generation itself failed. */
export class GenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationError";
  }
}
