# AI Game Studio

A local web app — and the start of a fuller AI Game Studio — for generating game assets from text prompts. Today: 2D reference sprites and animation frames composed into a 1×N spritesheet with a looping animated preview. Backgrounds are chroma-keyed to transparency automatically, so frames drop straight into a game engine. Projects can be saved and loaded by name.

**All inference runs locally.** No OpenRouter, no OpenAI, no API key, no per-request cost. Text generation runs on [Ollama](https://ollama.com); image and frame generation run on [ComfyUI](https://github.com/comfyanonymous/ComfyUI) with [FLUX.1 Schnell](https://huggingface.co/black-forest-labs/FLUX.1-schnell). Speed and quality depend on your hardware.

![Mockup](mockup.png)

## Requirements

- Node 20+
- `ffmpeg` on `PATH`
- [Ollama](https://ollama.com) — text / prompt enhancer
- [ComfyUI](https://github.com/comfyanonymous/ComfyUI) — image + frame generation

## Local setup

### 1. Ollama (text)

Install from [ollama.com](https://ollama.com), then:

```bash
ollama serve
ollama pull qwen3:8b
```

### 2. ComfyUI (image)

Install per the [ComfyUI docs](https://github.com/comfyanonymous/ComfyUI#installing). Download the FLUX.1 Schnell fp8 checkpoint (~17 GB) into `ComfyUI/models/checkpoints/`:

```
flux1-schnell-fp8.safetensors
```

(from [Comfy-Org/flux1-schnell](https://huggingface.co/Comfy-Org/flux1-schnell)). Then start it:

```bash
python main.py        # serves http://127.0.0.1:8188
```

### 3. The app

```bash
npm install
cp .env.example .env  # defaults match a standard Ollama + ComfyUI install
npm run dev
```

Open http://localhost:5173.

This starts Vite (frontend, :5173) and an Express server (backend, :8787) together. Stop with `Ctrl+C`.

## Using it

1. Type a sprite prompt in column 1. Optionally click **✨ Enhance** to expand it with the local LLM → **Generate Reference Sprite**.
2. Type a motion prompt in column 2 (Enhance available here too) → **Generate Frames**. The app runs FLUX.1 Schnell img2img once per frame from the reference sprite, then chroma-keys each result to a transparent PNG.
3. Click frame tiles to toggle which ones to include.
4. **Generate Spritesheet** → composes a 1×N PNG client-side, builds a looping GIF preview server-side.
5. **Export PNG** to download the spritesheet.
6. Header: **New** to start fresh, **Save** to name and snapshot the current project, **Load** to switch to a saved one.

Generated artifacts live under `projects/` (gitignored). The current working state is always in `projects/latest/`.

## Configuration

All models and defaults are environment variables (see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama endpoint |
| `OLLAMA_TEXT_MODEL` | `qwen3:8b` | LLM for the prompt enhancer — swap for `qwen3:14b`, `gpt-oss:20b`, etc. |
| `COMFYUI_BASE_URL` | `http://127.0.0.1:8188` | ComfyUI endpoint |
| `COMFYUI_IMAGE_MODEL` | `flux1-schnell-fp8.safetensors` | Checkpoint name in `ComfyUI/models/checkpoints/` |
| `IMAGE_SIZE` | `1024x1024` | Reference-sprite dimensions (rounded to /16 for FLUX) |
| `FRAME_DENOISE` | `0.65` | img2img strength for frames — lower = steadier, less motion |
| `FRAME_COUNT_DEFAULT` | `8` | Frames generated per **Generate Frames** run |
| `ENABLE_PROMPT_ENHANCER` | `true` | Show the ✨ Enhance buttons |
| `PORT` | `8787` | Express port |

No code change is needed to switch models — just edit `.env` and restart.

## Example prompts

### Sprite prompts

- `A pixel-art knight in silver armor with a longsword, side-view, full body, simple flat colors, standing pose`
- `Female ninja with red scarf, dynamic side-view, 2D sprite, anime style`
- `Cute green slime monster, side-view, big eyes, soft shading`
- `Cyberpunk hacker in a hoodie, glowing visor, side-view full body, gritty style`

### Motion prompts

- `Smooth walk cycle, side-view, no head tilting, no camera movement`
- `Sword slash attack, side-view, fast, no shadows`
- `Idle breathing animation, subtle, looping`
- `Jump arc — crouch, leap, mid-air, land`

Tips:
- Keep motion prompts focused on the action. Phrases like *"no camera movement"*, *"side-view"*, and *"no head tilting"* help keep frames game-ready.
- FLUX.1 Schnell is a 4-step distilled model — it ignores CFG / negative prompts. The chroma-green background is driven by the positive prompt plus the ffmpeg chroma-key safety net.
- Frames are independent img2img stills, not video, so expect some inter-frame jitter. Lower `FRAME_DENOISE` for steadier characters, raise it for more motion.

## Troubleshooting

| Problem | Fix |
|---|---|
| `Cannot connect to Ollama` | `ollama serve`; check `OLLAMA_BASE_URL`. |
| `Text model "…" is not installed` | `ollama pull qwen3:8b` |
| `Cannot connect to ComfyUI` | Start ComfyUI (`python main.py`); check `COMFYUI_BASE_URL`. |
| `checkpoint "…" not found` | Put the `.safetensors` file in `ComfyUI/models/checkpoints/` and restart ComfyUI. |
| Out of memory | Smaller text model (`qwen3:4b`); a GGUF Q4 FLUX checkpoint; lower `IMAGE_SIZE`. |
| Slow generation | GPU acceleration for ComfyUI; fewer frames (`FRAME_COUNT_DEFAULT`); smaller `IMAGE_SIZE`. |

## TO-DO

- [ ] Background generation
- [ ] Tilemap generation
- [ ] Aseprite format export
- [ ] Tiled format export
- [ ] SFX generation
- [ ] Music generation
- [ ] Voice generation
- [ ] Full asset scaffolding export

## More

See [AGENTS.md](AGENTS.md) for the full spec, architecture, endpoint list, and the provider layer. See [docs/spec.md](docs/spec.md) for the local-AI migration spec.
