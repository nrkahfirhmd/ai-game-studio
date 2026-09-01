// Optional prompt enhancer: expands a terse user prompt into a detailed
// sprite / motion brief. Runs before the chroma directive is appended.

import { getProvider } from "./ai/provider.js";

export type EnhanceKind = "sprite" | "motion";

const SYSTEM: Record<EnhanceKind, string> = {
  sprite:
    "You expand a short game-sprite description into ONE vivid, concrete paragraph: " +
    "subject, view angle (side-view unless the input says otherwise), art style, colours, pose. " +
    "No preamble, no lists, no quotes. Do not mention backgrounds or transparency.",
  motion:
    "You expand a short motion description into a precise side-view animation brief: " +
    "the action described phase by phase, character stays centred at the same scale, " +
    "no camera movement, no head tilting unless asked. ONE paragraph, no preamble, no lists.",
};

export async function enhancePrompt(kind: EnhanceKind, prompt: string): Promise<string> {
  const { text } = await getProvider().generateText({
    system: SYSTEM[kind],
    prompt: prompt.trim(),
    temperature: 0.8,
  });
  return text.trim();
}
