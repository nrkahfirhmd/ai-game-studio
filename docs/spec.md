# Spec: Replace OpenRouter with Fully Local AI

**Status:** Implemented. See git history + `AGENTS.md` "Local Mode" for the shipped design.
**Goal:** Run AI Game Studio end-to-end on a developer machine with no OpenRouter key, no cloud AI API, no per-request cost.

- **Text / LLM** → Ollama (`qwen3:8b`, configurable)
- **Reference sprite** → ComfyUI, FLUX.1 Schnell text2img (configurable)
- **Movement frames** → ComfyUI **image-to-video** (Stable Video Diffusion by default, or any exported workflow via `COMFYUI_VIDEO_WORKFLOW`), then ffmpeg chroma-key per frame

Preserve the existing three-column "Sprite Sheet Builder" UX and generation workflow. Keep all provider-specific code behind a service layer.

> **Amendment (post-review):** §2 Gap B originally proposed N independent FLUX img2img
> passes for frames. That was implemented, then rejected — a text-to-image model has no
> animation priors, so the frames don't form a coherent cycle at any denoise. Replaced
> with a real local image-to-video workflow in ComfyUI (`server/ai/comfyui.ts`
> `generateVideoFrames`, `AIProvider.generateFrames`). SVD is the built-in default;
> `COMFYUI_VIDEO_WORKFLOW` points at an exported API-format workflow (LTX-Video, Wan2.1,
> CogVideoX, AnimateDiff — including GGUF quants for low VRAM) with `%TOKEN%` substitution.
> `FRAME_DENOISE` / `FRAME_COUNT_DEFAULT` / the `frameCount` request param are gone;
> `VIDEO_*` vars replace them. See `server/workflows/README.md`.

---

## 1. Phase 1 — Existing architecture (as-built)

### 1.1 Stack

| Layer | Tech | Notes |
|---|---|---|
| Frontend | Vite + TypeScript SPA, no framework | Tiny `Store` with one `subscribe` listener re-renders. `src/main.ts` → `src/app.ts`. |
| Backend | Express 4 (ESM, `tsx watch`) | Port `8787` (`PORT` override). Vite (`5173`) proxies `/api` + `/projects` → `8787`. |
| AI provider | **OpenRouter only** | Raw `fetch`, no SDK. Two endpoints: `/api/v1/images`, `/api/v1/videos`. |
| Media tooling | `ffmpeg` on `PATH` | Frame extraction (chroma-key → RGBA PNG), JPEG→PNG normalize, GIF preview. |
| Asset storage | `projects/` (gitignored) | Working state always in `projects/latest/`; named snapshots in `projects/<name>/`. Manifest `sprite.json`. |

### 1.2 Current generation flow

```
UI (src/app.ts handlers)
 ↓  POST /api/sprites/generate        POST /api/sprites/animate
 ↓
Express routes (server/index.ts)
 ↓
generateSpriteImage()  (server/image.ts)   generateSpriteMotionVideo()  (server/video.ts)
 ↓                                          ↓
OpenRouter  POST /api/v1/images            OpenRouter  POST /api/v1/videos  → poll → download mp4
 ↓                                          ↓
base64 PNG → projects/latest/ref/sprite.png  source.mp4 → scripts/extract-frames.sh (ffmpeg chromakey)
                                             ↓
                                            projects/latest/frames/frame-*.png
```

There is **no LLM / text-generation call anywhere in the codebase.** The only model calls are image (`/images`) and image-to-video (`/videos`).

### 1.3 Every OpenRouter touchpoint

| File | Lines | What |
|---|---|---|
| `server/image.ts` | 1, 5, 55, 118–144 | `OPENROUTER_BASE`, `OPENROUTER_API_KEY`, `POST {base}/images`, error strings |
| `server/video.ts` | 1–10, 71–158 | `OPENROUTER_BASE`, key, `POST {base}/videos`, poll loop, `isOpenRouterHost`, bearer-to-openrouter-only rule |
| `server/index.ts` | 47, 53–61, 270–279, 283–285 | `HAS_KEY`, `requireKey` middleware (500 if no key), `redact(sk-or-…)`, boot warning |
| `src/app.ts` | 441–447 | Boot health check → "OPENROUTER_API_KEY is missing" banner |
| `.env.example` | 1 | `OPENROUTER_API_KEY=` |
| `README.md`, `README.es-ES.md`, `AGENTS.md` | many | Setup, model tables, architecture, security notes |

### 1.4 Config / env vars (current)

- `OPENROUTER_API_KEY` — required; every model route 500s without it.
- `PORT` — optional, default `8787`.

### 1.5 API routes

| Route | Purpose |
|---|---|
| `GET /api/health` | `{ ok, hasApiKey }` |
| `GET /api/models/image` | `{ models: [{id,label}], default }` — allowlist + client dropdown |
| `GET /api/models/video` | `{ models: [{id,label,defaultDuration}], default }` |
| `GET /api/projects/current` \| `GET /api/projects` | working view / snapshot list |
| `POST /api/projects/new \| save \| load \| delete \| selection \| spritesheet` | project lifecycle + persistence |
| `POST /api/sprites/generate` | `{prompt, model?}` → image |
| `POST /api/sprites/animate` | `{image, text, model?, duration?}` → video → frames |

### 1.6 Prompt construction (must stay semantically equivalent)

- **Image** (`server/image.ts` `CHROMA_DIRECTIVE`): user prompt + `\n\n` + hardcoded flat-chroma-green (`#00b140`) directive. Body: `{ model, prompt }`.
- **Video** (`server/video.ts` `CHROMA_DIRECTIVE`): motion prompt + `\n\n` + "keep the green background stable, no camera movement" directive.
- Chroma hex `#00b140` is duplicated in **3 places**: `server/image.ts`, `server/video.ts`, `scripts/extract-frames.sh` (`chromakey=0x00b140:0.15:0.08`). Keep in sync.

### 1.7 Response parsing

- Image: `json.data[0].b64_json` (+ optional `media_type`) → `normalizeImageToPng()` (ffmpeg if JPEG) → base64 PNG.
- Video: `job.id`, `job.status`, `job.polling_url`, `job.unsigned_urls[0]`. Poll every 3 s, max 100 attempts.

### 1.8 Generated asset storage

`projects/latest/` — `sprite.json` (manifest, source of truth), `ref/sprite.png`, `source.mp4`, `frames/frame-XXXXX.png`, `spritesheet.png`, `preview.gif`. Manifest: `name`, `spritePrompt`, `spriteModel`, `motionPrompt`, `motionModel`, `sprite`, `spriteDimensions`, `frames[]`, `selectedFrameIndices[]`, `spritesheet`, `previewGif`, `updatedAt`. URLs built at view time against `/projects/latest/`; `?v=updatedAt` cache-bust.

---

## 2. Gap analysis

The migration plan assumes an LLM-driven "idea → game design → image prompt → image" pipeline. **This app is not that.** It is an image + image-to-video sprite tool. Three gaps, all now resolved:

### Gap A — No text/LLM usage exists → **ship prompt enhancer**

Nothing calls an LLM today. Build the text provider behind the abstraction and give it a real job: a **prompt enhancer** that expands a terse user prompt into a detailed sprite / motion description before the chroma directive is appended.

- New route `POST /api/prompt/enhance { kind: "sprite" | "motion", prompt } → { enhanced }`.
- UI: a small "✨ Enhance" button beside each prompt textarea (columns 1 and 2). Click → fills the textarea with the enhanced text (user can edit before generating).
- `ENABLE_PROMPT_ENHANCER` env gates the feature; **default `true`** (feature is shipped). When `false`, the button is hidden and generation is byte-for-byte the current behavior.
- The existing `CHROMA_DIRECTIVE` concatenation is untouched — the enhancer runs before it.

### Gap B — Image-to-video has no local equivalent → **N-image frame generation via ComfyUI**

`Generate Frames` becomes: for an N-frame request, run FLUX.1 Schnell N times through ComfyUI, each as **img2img** from the reference sprite + a per-frame pose directive derived from the motion prompt (e.g. walk cycle → contact / down / passing / up phases). Output is the same `projects/latest/frames/frame-XXXXX.png` sequence the rest of the pipeline consumes.

- `source.mp4` step dropped. `server/video.ts` deleted.
- `scripts/extract-frames.sh` retained only for the chroma-key + scale filter, applied per generated frame (or that filter moves into `server/frames.ts`).
- GIF preview (`server/build-gif.ts`) unchanged.
- `POST /api/sprites/animate` param `duration` → `frameCount` (back-compat: server maps a legacy `duration` to `Math.round(duration * DEFAULT_FPS)`, default `frameCount = 8`).
- Manifest `motionModel` records the ComfyUI image model / workflow id.

### Gap C — Local image backend → **ComfyUI + FLUX.1 Schnell**

Image generation (reference sprite **and** every frame) goes through a local **ComfyUI** instance via its HTTP API, running **FLUX.1 Schnell** (Apache-2.0, 4-step distilled text-to-image, ComfyUI-native).

- Default `COMFYUI_BASE_URL=http://127.0.0.1:8188`.
- Default checkpoint `flux1-schnell-fp8.safetensors` (single-file fp8 build — one download, standard `CheckpointLoaderSimple`).
- No paid service, no cloud fallback, no key.
- Ollama is **text only**. It does not touch image generation.

---

## 3. Target architecture

```
AI Game Studio
│
├── Text ──── AIProvider.generateText() ──── Ollama  /v1/chat/completions ──── qwen3:8b
│                                              └ used by: prompt enhancer (POST /api/prompt/enhance)
│
├── Image ─── AIProvider.generateImage() ───── ComfyUI  POST /prompt (workflow graph) → poll /history → GET /view
│                                              └ FLUX.1 Schnell (flux1-schnell-fp8.safetensors)
│
└── Frames ── N × AIProvider.generateImage()  with per-frame pose directive + ref sprite as img2img input
              (replaces OpenRouter image-to-video)
```

```
UI
 ↓
Express routes (server/index.ts)        ← route shapes unchanged except /api/health, + /api/prompt/enhance
 ↓
server/ai/provider.ts   (AIProvider interface + factory)
 ├── server/ai/ollama.ts    (text)          → 127.0.0.1:11434
 └── server/ai/comfyui.ts   (image)         → 127.0.0.1:8188
```

---

## 4. Phase 2 — Provider abstraction

New directory `server/ai/`. Application code depends only on the interface.

```ts
// server/ai/types.ts
export interface TextGenerationRequest {
  system?: string;
  prompt: string;
  json?: boolean;
  stream?: boolean;
  temperature?: number;
}
export interface TextGenerationResponse { text: string; }

export interface ImageGenerationRequest {
  prompt: string;
  image?: string;              // data: URL or absolute path — img2img reference
  width?: number;
  height?: number;
  denoise?: number;            // img2img strength; ignored for pure text2img
  seed?: number;
}
export interface ImageGenerationResponse {
  base64: string;              // PNG, normalized
  width: number;
  height: number;
}

export interface AIProvider {
  generateText(req: TextGenerationRequest): Promise<TextGenerationResponse>;
  generateTextStream?(req: TextGenerationRequest): AsyncIterable<string>;
  generateImage(req: ImageGenerationRequest): Promise<ImageGenerationResponse>;
  health(): Promise<ProviderHealth>;
}

export interface ProviderHealth {
  text:  { backend: "ollama";  baseUrl: string; reachable: boolean; model: string; installed: boolean };
  image: { backend: "comfyui"; baseUrl: string; reachable: boolean; model: string; installed: boolean };
}
```

```ts
// server/ai/provider.ts
export function getProvider(): AIProvider;   // composes ollama (text) + comfyui (image); memoized
```

- `server/image.ts` becomes a thin adapter: keep `CHROMA_DIRECTIVE` + `normalizeImageToPng` + `IMAGE_MODELS` list, delegate the network call to `getProvider().generateImage()`.
- `server/video.ts` deleted. New `server/frames.ts` orchestrates N × `generateImage()` + per-frame pose directives.
- New `server/prompt.ts` (Gap A) wraps `getProvider().generateText()` for the enhancer.
- New `server/config.ts` — typed config, read `process.env` once at boot.

---

## 5. Phase 3 — Ollama text generation

- Endpoint: `${OLLAMA_BASE_URL}/v1/chat/completions` (OpenAI-compatible — supports `stream`, `response_format: { type: "json_object" }`, system + user roles).
- Model: `OLLAMA_TEXT_MODEL` (default `qwen3:8b`). No hardcoded model name in the provider.
- `system` → role `system`; `prompt` → role `user`.
- `json:true` → `response_format: { type: "json_object" }`; provider parses and re-serializes or throws `StructuredOutputError`.
- Streaming: `generateTextStream()` yields token deltas. Enhancer UI streams into the textarea if `stream` is supported; otherwise fills on completion.
- Errors: connection refused → `OllamaUnavailableError`; `404` model not found → `ModelNotInstalledError(model)`. Both carry the remediation string (Phase 10).
- **Note (qwen3):** qwen3 emits `<think>…</think>` reasoning blocks. The enhancer strips these before returning; pass `{"enable_thinking": false}` via `chat_template_kwargs` where supported, else regex-strip.

### 5.1 Enhancer prompts (`server/prompt.ts`)

- **sprite kind** system prompt: "You expand a short game-sprite description into one vivid, concrete paragraph: subject, view angle (side-view unless stated), art style, colours, pose. No preamble. Do not mention backgrounds."
- **motion kind** system prompt: "You expand a short motion description into a precise side-view animation brief: the action, phase-by-phase, keeping the character centred, no camera movement. One paragraph."
- User message = raw prompt. Output replaces the textarea contents.

---

## 6. Phase 4 / 5 — ComfyUI image generation (FLUX.1 Schnell)

### 6.1 ComfyUI HTTP API

| Call | Use |
|---|---|
| `GET /system_stats` | reachability / health |
| `GET /object_info` | lists installed checkpoints/nodes → model-installed check |
| `POST /upload/image` (multipart) | upload ref sprite for img2img frames |
| `POST /prompt` `{ prompt: <graph>, client_id }` | enqueue a workflow → `{ prompt_id }` |
| `GET /history/{prompt_id}` | poll until present → node outputs with `{filename, subfolder, type}` |
| `GET /view?filename=&subfolder=&type=` | fetch the produced PNG bytes |
| `WS /ws?clientId=` | optional live progress (not required — polling is fine) |

`server/ai/comfyui.ts` owns a **workflow template** (API-format JSON) with placeholders. Two templates:

**text2img (reference sprite):**
```
CheckpointLoaderSimple(flux1-schnell-fp8.safetensors)
  → CLIPTextEncode(positive = "<prompt + CHROMA_DIRECTIVE>")
  → CLIPTextEncode(negative = "")            # Schnell ignores CFG; keep empty
  → EmptyLatentImage(width, height, batch=1)
  → KSampler(seed, steps=4, cfg=1.0, sampler="euler", scheduler="simple", denoise=1.0)
  → VAEDecode → SaveImage(prefix="ags")
```

**img2img (frames):**
```
… LoadImage(<uploaded ref>) → VAEEncode → KSampler(denoise=FRAME_DENOISE, steps=4) → VAEDecode → SaveImage
```

Placeholders substituted per call: positive prompt, `width`, `height`, `seed`, `denoise`, input image name. Poll `/history/{id}` every ~750 ms, cap ~120 s. On completion, `GET /view` the `SaveImage` output, run `normalizeImageToPng()`.

### 6.2 Config

- `COMFYUI_BASE_URL` (default `http://127.0.0.1:8188`).
- `COMFYUI_IMAGE_MODEL` — checkpoint filename (default `flux1-schnell-fp8.safetensors`). No hardcoded name in code.
- `IMAGE_SIZE` (default `1024x1024`) — default sprite dimensions; parsed to `width`/`height`.
- `FRAME_DENOISE` (default `0.65`) — img2img strength for frames.
- `FRAME_COUNT_DEFAULT` (default `8`).
- Optional `COMFYUI_WORKFLOW_DIR` — override the bundled workflow templates with custom JSON (Phase 9 flexibility).

### 6.3 Feature-by-feature compatibility

| Existing feature | Local plan |
|---|---|
| Prompt generation | Unchanged. `CHROMA_DIRECTIVE` still appended server-side. Optional enhancer runs before it. |
| Image dimensions | `IMAGE_SIZE` → `EmptyLatentImage`. Actual dims read back via `readPngDims` (already present) → `spriteDimensions`. FLUX wants multiples of 16. |
| Aspect ratio | Square default. Any `WxH` via `IMAGE_SIZE`. |
| Output format | PNG (ComfyUI `SaveImage` is PNG). |
| Image storage / URLs / cache-bust | Unchanged. |
| Loading / error states | Unchanged surface; new messages (Phase 10). ComfyUI queue position surfaced in status text. |
| Regeneration | Unchanged — re-click; `wipeLatestFramesAndSheet()` still runs. New random `seed` each click unless pinned. |
| Download / export PNG | Unchanged (client canvas + `<a download>`). |
| Image previews | Unchanged. |
| Frames (was image-to-video) | Changed — §2 Gap B. Same on-disk sequence, grid, spritesheet, GIF. |

### 6.4 Documented differences

- Frames are independent img2img stills, not video-extracted. Temporal coherence depends on `FRAME_DENOISE` and Schnell's consistency — expect more inter-frame jitter than Grok/Seedance clips. Lower `FRAME_DENOISE` → steadier but less motion.
- No sub-second frame timing; `frameCount` replaces `duration`.
- FLUX.1 Schnell has weak negative-prompt / CFG response (distilled) — the chroma directive leans on the positive prompt plus the existing ffmpeg chroma-key safety net.
- Generation is hardware-bound: FLUX fp8 needs ~12 GB VRAM for comfortable speed; CPU or low-VRAM works but is slow.

---

## 7. Phase 6 / 9 — Configuration

`.env.example` (new):

```bash
# --- Text (Ollama, local, no key) ---
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_TEXT_MODEL=qwen3:8b

# --- Image + frames (ComfyUI, local, no key) ---
COMFYUI_BASE_URL=http://127.0.0.1:8188
COMFYUI_IMAGE_MODEL=flux1-schnell-fp8.safetensors

# --- Generation defaults ---
IMAGE_SIZE=1024x1024
FRAME_DENOISE=0.65
FRAME_COUNT_DEFAULT=8

# --- Features ---
ENABLE_PROMPT_ENHANCER=true

# --- Server ---
PORT=8787
```

- `OPENROUTER_API_KEY` removed entirely.
- All model names configurable — swap to `qwen3:14b` / `qwen3:30b` / `gpt-oss:20b`, or another ComfyUI checkpoint (`flux1-dev`, an SDXL model with a matching workflow), via env only.
- `server/config.ts` reads env once into a typed object; no scattered `process.env`.

---

## 8. Phase 7 / 10 — Health check & error handling

### 8.1 Startup

On `server/index.ts` boot, call `getProvider().health()`:

1. Ollama reachable at `OLLAMA_BASE_URL` (`GET /api/version`)? `OLLAMA_TEXT_MODEL` in `GET /api/tags`?
2. ComfyUI reachable at `COMFYUI_BASE_URL` (`GET /system_stats`)? `COMFYUI_IMAGE_MODEL` in `GET /object_info` checkpoint list?

Log actionable warnings. **Do not crash** — UI loads and shows a banner.

### 8.2 `GET /api/health` (shape change)

```json
{
  "ok": true,
  "text":  { "backend": "ollama",  "reachable": true,  "model": "qwen3:8b",                    "installed": true  },
  "image": { "backend": "comfyui", "reachable": false, "model": "flux1-schnell-fp8.safetensors","installed": false }
}
```

`src/app.ts` boot check: replace the `hasApiKey` branch with `reachable` / `installed` checks; show the matching remediation inline near column 1. Enhance buttons hidden if text backend down or `ENABLE_PROMPT_ENHANCER=false`.

### 8.3 Error catalog (server → user message; full error to server log only)

| Condition | Message |
|---|---|
| Ollama unreachable | `Cannot connect to Ollama at <baseUrl>. Install it from ollama.com and run: ollama serve` |
| Text model missing | `Text model "<model>" is not installed. Run: ollama pull <model>` |
| ComfyUI unreachable | `Cannot connect to ComfyUI at <baseUrl>. Start ComfyUI (python main.py) and check COMFYUI_BASE_URL.` |
| Image model missing | `Checkpoint "<model>" not found in ComfyUI. Put it in ComfyUI/models/checkpoints/ and restart ComfyUI.` |
| ComfyUI workflow error | `Image generation failed in ComfyUI. Check the server log and the ComfyUI console.` |
| Generation failure / timeout | `Generation failed. Check the server log for details.` |
| Structured-output parse failure | `The model did not return valid JSON. Try a different OLLAMA_TEXT_MODEL.` |
| ffmpeg missing (unchanged) | `ffmpeg is not installed.` |
| Zero frames produced (unchanged) | `No frames produced.` |

- `redact()` in `server/index.ts`: drop the `sk-or-` rule (no keys left). Keep "log full, return safe" in `handleError`.
- `requireKey` middleware deleted. Routes surface provider errors through `handleError` with status: `503` unreachable, `422` missing model, `502` backend error.

---

## 9. Phase 12 — OpenRouter removal checklist

- [ ] `server/video.ts` — delete (replaced by `server/frames.ts`).
- [ ] `server/image.ts` — strip `OPENROUTER_BASE`, key check, `fetch(/images)`; delegate to provider.
- [ ] `server/index.ts` — remove `HAS_KEY`, `requireKey`, `sk-or-` redaction, boot key warning, `./video.js` import; add `/api/prompt/enhance`, provider health.
- [ ] `src/app.ts` — replace `OPENROUTER_API_KEY` boot banner; add Enhance buttons; `duration`→`frameCount` in `animateSprite` call.
- [ ] `src/lib/api.ts` — `enhancePrompt()`, health type change.
- [ ] `.env.example` — replace contents (§7).
- [ ] `README.md`, `README.es-ES.md` — rewrite Requirements / Install / Run / model notes / TO-DO.
- [ ] `AGENTS.md` — add **Local Mode** section (§10.1); keep cloud notes as historical context, marked superseded.
- [ ] `package.json` — no OpenRouter dep exists; confirm nothing else.

Acceptance grep (zero hits outside `docs/spec.md`, `CHANGELOG`, superseded `AGENTS.md` history block):

```bash
grep -rani "openrouter\|OPENROUTER_API_KEY\|api\.openrouter\.ai\|sk-or-" --exclude-dir=node_modules .
```

---

## 10. Phase 8 / 13 — README & docs

README **Requirements**:

```
- Node.js 20+
- ffmpeg on PATH
- Ollama            (https://ollama.com)          — text
- ComfyUI           (https://github.com/comfyanonymous/ComfyUI)  — image
```

README **Local setup**:

```bash
# 1. Ollama — text
#    install from ollama.com, then:
ollama serve
ollama pull qwen3:8b

# 2. ComfyUI — image
#    clone + install per ComfyUI docs, then download FLUX.1 Schnell (fp8, ~17 GB):
#    → ComfyUI/models/checkpoints/flux1-schnell-fp8.safetensors
#    (https://huggingface.co/Comfy-Org/flux1-schnell / -fp8)
python main.py            # serves http://127.0.0.1:8188

# 3. App
npm install
cp .env.example .env      # defaults match standard Ollama + ComfyUI installs
npm run dev               # Vite :5173 + Express :8787
```

State plainly: inference is 100% local; no OpenRouter/OpenAI account; no API key; no per-request cost; speed and quality scale with local CPU/GPU/RAM.

README **Troubleshooting**:
- *Ollama not running* → `ollama serve`; check `OLLAMA_BASE_URL`.
- *ComfyUI not running / wrong port* → `python main.py`; check `COMFYUI_BASE_URL`.
- *Model missing* → `ollama pull <model>` / drop checkpoint into `ComfyUI/models/checkpoints/`.
- *Out of memory* → smaller text model (`qwen3:4b`); FLUX fp8 or GGUF Q4 checkpoint; lower `IMAGE_SIZE`.
- *Slow generation* → GPU acceleration for ComfyUI; fewer frames (`FRAME_COUNT_DEFAULT`); smaller `IMAGE_SIZE`.

### 10.1 `AGENTS.md` — new "Local Mode" section

Add a top-level section documenting: the Ollama (text) + ComfyUI (image) architecture, the `server/ai/` provider layer, the env vars, the ComfyUI workflow-template mechanism, the `frameCount` model, and the chroma sync points (`server/image.ts`, `server/frames.ts`, `scripts/extract-frames.sh`). Keep the existing OpenRouter sections but prefix with a note: *"Superseded — see Local Mode. Retained for history."*

---

## 11. Phase 11 — Test plan

> **Environment not yet available:** Ollama and ComfyUI are not installed on the dev machine. These are the acceptance tests to run once both are up; treat as pending until then.

### Text
- [ ] Simple prompt → non-empty response.
- [ ] Long (~2k char) prompt → no truncation error.
- [ ] System + user messages honored.
- [ ] `json:true` → parseable JSON.
- [ ] Streaming yields incremental deltas into the textarea.
- [ ] `qwen3` `<think>` blocks stripped from enhancer output.
- [ ] `OLLAMA_TEXT_MODEL=nope` → `ModelNotInstalledError` + pull hint, no crash.
- [ ] Ollama stopped → `OllamaUnavailableError`, banner, no crash; image generation still works.

### Images (ComfyUI + FLUX.1 Schnell)
- [ ] Basic prompt → PNG at `projects/latest/ref/sprite.png`, dims caption shown.
- [ ] Game-asset prompt (knight, slime) → flat chroma-green background present, keys clean.
- [ ] `IMAGE_SIZE=768x768` respected.
- [ ] Regenerate → old frames/spritesheet/gif wiped; new seed.
- [ ] Frames: motion prompt → N img2img frames from the ref sprite, character recognizably consistent.
- [ ] Image persists across refresh.
- [ ] Checkpoint missing → actionable error.
- [ ] ComfyUI stopped → actionable error, banner, no crash.

### Full workflow (no OpenRouter)
- [ ] prompt (+ optional Enhance) → reference sprite → motion prompt (+ optional Enhance) → frame set → toggle selection → Generate Spritesheet → 1×N PNG + `preview.gif` → Export PNG.
- [ ] Save / Load / New / Delete unaffected.
- [ ] Fresh checkout: install Ollama + ComfyUI, pull models, `npm install`, `npm run dev` → text + image succeed, **no API key**.
- [ ] `grep -rani "openrouter"` → zero runtime hits.

---

## 12. Definition of Done

A fresh developer installs Ollama + ComfyUI, pulls `qwen3:8b` and `flux1-schnell-fp8.safetensors`, runs `npm install && npm run dev`, and generates both text (prompt enhancer) and images (reference sprite + frames) with no OpenRouter, no OpenAI API, no key, no paid service. No required runtime dependency on OpenRouter remains.

---

## 13. Limitations & non-reproducible features

| Feature | Status | Local equivalent |
|---|---|---|
| Image-to-video motion (Grok/MiniMax/Seedance) | **Not reproducible** | N independent img2img frames via ComfyUI + per-frame pose directives. Lower temporal coherence. |
| Per-model video duration ranges | Removed | `frameCount` parameter. |
| Cloud GPU speed | Removed | Local hardware; FLUX fp8 ≈ 12 GB VRAM for good speed, slower on CPU/low-VRAM. |
| `unsigned_urls` / signed-download handling | Removed (no cloud) | n/a |
| Strong negative prompts / CFG steering | Weak with FLUX.1 Schnell (distilled) | Positive-prompt chroma directive + ffmpeg chroma-key safety net. |
| LLM-driven "game design" pipeline from the migration plan | Never existed in this repo | Prompt enhancer only. |
| Zero-dependency single-service local run | Not achievable | Two local services (Ollama + ComfyUI) + ffmpeg. Documented in setup. |

---

## 14. Resolved decisions

1. **Prompt enhancer** — ship it. `ENABLE_PROMPT_ENHANCER=true` default, Enhance buttons on both prompt fields.
2. **Frames** — integrate immediately with **ComfyUI + FLUX.1 Schnell**, N-image img2img from the reference sprite.
3. **Image backend** — ComfyUI (`http://127.0.0.1:8188`), FLUX.1 Schnell fp8 checkpoint. Ollama is text-only. *(Ollama not yet installed on the dev machine — install is part of setup.)*
4. **`AGENTS.md`** — add a "Local Mode" section; keep OpenRouter sections marked superseded/historical.

### Remaining unknowns (confirm during build)

- Exact FLUX.1 Schnell workflow that keys cleanest at `#00b140` — tune `FRAME_DENOISE`, sampler, steps against real output.
- Whether img2img at any denoise gives acceptable character consistency for walk/attack cycles, or whether a ControlNet/pose pass is needed (out of scope for v1 — documented if it falls short).
- ComfyUI checkpoint vs. split unet/clip/vae loading — pick whichever the fp8 release ships as.
