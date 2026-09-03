// Ollama text backend (OpenAI-compatible chat endpoint).

import { config } from "../config.js";
import {
  BackendUnavailableError,
  GenerationError,
  ModelNotInstalledError,
  type BackendHealth,
  type TextGenerationRequest,
  type TextGenerationResponse,
} from "./types.js";

const { baseUrl, textModel } = config.ollama;

const UNAVAILABLE_HINT =
  "Install it from ollama.com and run: ollama serve";

function pullHint(model: string): string {
  return `Run: ollama pull ${model}`;
}

async function ollamaFetch(pathname: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${baseUrl}${pathname}`, init);
  } catch (err) {
    throw new BackendUnavailableError("Ollama", baseUrl, UNAVAILABLE_HINT);
  }
}

/** Strip qwen3-style <think>…</think> reasoning blocks. */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string } | string;
}

export async function generateText(
  req: TextGenerationRequest,
): Promise<TextGenerationResponse> {
  const messages: Array<{ role: string; content: string }> = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  messages.push({ role: "user", content: req.prompt });

  const body: Record<string, unknown> = {
    model: textModel,
    messages,
    stream: false,
    temperature: req.temperature ?? 0.7,
    // qwen3: disable reasoning where the template supports it
    chat_template_kwargs: { enable_thinking: false },
  };
  if (req.json) body.response_format = { type: "json_object" };

  const res = await ollamaFetch("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = (await res.json().catch(() => ({}))) as ChatResponse;

  if (!res.ok) {
    const msg =
      typeof json.error === "string" ? json.error : json.error?.message ?? `HTTP ${res.status}`;
    if (res.status === 404 || /not found|no such model|not installed/i.test(msg)) {
      throw new ModelNotInstalledError("Ollama", textModel, pullHint(textModel));
    }
    throw new GenerationError(`Ollama text generation failed: ${msg}`);
  }

  let text = stripThinking(json.choices?.[0]?.message?.content ?? "");
  if (!text) throw new GenerationError("Ollama returned an empty response");

  if (req.json) {
    // Guarantee valid JSON or fail loudly.
    try {
      text = JSON.stringify(JSON.parse(text));
    } catch {
      throw new GenerationError(
        `The model did not return valid JSON. Try a different OLLAMA_TEXT_MODEL.`,
      );
    }
  }

  return { text };
}

export async function health(): Promise<BackendHealth> {
  const base: BackendHealth = {
    backend: "ollama",
    baseUrl,
    reachable: false,
    model: textModel,
    installed: false,
  };
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/tags`);
  } catch {
    return base;
  }
  if (!res.ok) return { ...base, reachable: true };
  const json = (await res.json().catch(() => ({}))) as {
    models?: Array<{ name?: string; model?: string }>;
  };
  const names = (json.models ?? []).flatMap((m) => [m.name, m.model].filter(Boolean) as string[]);
  const installed = names.some((n) => n === textModel || n.split(":")[0] === textModel.split(":")[0]);
  return { ...base, reachable: true, installed };
}
