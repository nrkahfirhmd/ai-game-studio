// Reference-sprite generation. Appends the chroma directive, delegates the
// actual generation to the configured AI provider (ComfyUI + FLUX.1 Schnell).

import { getProvider } from "./ai/provider.js";
import { config } from "./config.js";
import { IMAGE_CHROMA_DIRECTIVE } from "./chroma.js";

// Selectable image models. One ComfyUI checkpoint by default; set
// COMFYUI_IMAGE_MODEL to change it. Kept as a list so the client dropdown
// and the /api/models/image contract stay unchanged.
export const IMAGE_MODELS = [
  { id: config.comfyui.imageModel, label: "FLUX.1 Schnell (ComfyUI)" },
] as const;

export type ImageModelId = string;
export const DEFAULT_IMAGE_MODEL: ImageModelId = config.comfyui.imageModel;

export function isImageModelId(value: unknown): value is ImageModelId {
  return typeof value === "string" && IMAGE_MODELS.some((m) => m.id === value);
}

/** Returns base64 PNG. */
export async function generateSpriteImage(prompt: string): Promise<string> {
  const fullPrompt = `${prompt.trim()}\n\n${IMAGE_CHROMA_DIRECTIVE}`;
  const { base64 } = await getProvider().generateImage({
    prompt: fullPrompt,
    width: config.image.size.width,
    height: config.image.size.height,
  });
  return base64;
}
