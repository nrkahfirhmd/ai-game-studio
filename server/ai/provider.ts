// Composes the concrete backends into one AIProvider: Ollama for text,
// ComfyUI for image. Application code imports getProvider(), nothing else.

import * as ollama from "./ollama.js";
import * as comfyui from "./comfyui.js";
import type { AIProvider } from "./types.js";

const provider: AIProvider = {
  generateText: ollama.generateText,
  generateImage: comfyui.generateImage,
  async health() {
    const [text, image] = await Promise.all([ollama.health(), comfyui.health()]);
    return { text, image };
  },
};

export function getProvider(): AIProvider {
  return provider;
}
