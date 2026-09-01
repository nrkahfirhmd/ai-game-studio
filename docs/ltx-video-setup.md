# LTX-Video setup (movement frames) — macOS / Apple Silicon

Target: MacBook Pro M-series, 24 GB unified memory. ComfyUI already installed and
running (you have the GGUF FLUX sprite path working).

LTX-Video 2B is the movement-frame model: native ComfyUI nodes, runs on MPS,
text-conditioned (the motion prompt actually steers it), ~30–90 s per clip.

---

## 1. Update ComfyUI

LTX nodes need a recent build.

```bash
cd /path/to/ComfyUI
git pull
# activate the same venv/conda env you normally run ComfyUI with, then:
python -m pip install -r requirements.txt
```

Restart ComfyUI (`python main.py`). It serves http://127.0.0.1:8188.

---

## 2. Download models

### LTX-Video 2B checkpoint (~6 GB)

Public, not gated. Pick the latest **2B** file from
[Lightricks/LTX-Video](https://huggingface.co/Lightricks/LTX-Video/tree/main)
(NOT the 13B — too big for 24 GB).

```bash
cd /path/to/ComfyUI/models/checkpoints
curl -L -o ltx-video-2b-v0.9.6.safetensors \
  "https://huggingface.co/Lightricks/LTX-Video/resolve/main/ltx-video-2b-v0.9.6.safetensors?download=true"
```

### Text encoder (T5) — you already have this

The `t5xxl_fp8_e4m3fn.safetensors` from your FLUX GGUF setup works. It must be in
`ComfyUI/models/text_encoders/` (newer ComfyUI) or `ComfyUI/models/clip/` (older).

```bash
ls /path/to/ComfyUI/models/text_encoders/ /path/to/ComfyUI/models/clip/ | grep t5xxl
```

If missing:

```bash
cd /path/to/ComfyUI/models/text_encoders
curl -L -o t5xxl_fp8_e4m3fn.safetensors \
  "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors?download=true"
```

Restart ComfyUI so it picks up the new files.

---

## 3. Get the LTXV template working in ComfyUI

1. Open http://127.0.0.1:8188.
2. **Workflow → Browse Templates → Video → "LTX-Video Image to Video"**
   (or grab the JSON from the [ComfyUI LTXV docs](https://docs.comfy.org/tutorials/video/ltxv)
   and drag it onto the canvas).
3. In the loaded graph:
   - Checkpoint loader → `ltx-video-2b-v0.9.6.safetensors`
   - CLIP loader → `t5xxl_fp8_e4m3fn.safetensors`, type `ltxv`
   - `LoadImage` → upload any test sprite PNG (green background is fine)
   - Positive prompt → e.g. `side view, character walking, walk cycle, no camera movement`
   - `LTXVImageToVideo`: width `768`, height `512`, length `25`
4. **Queue Prompt.**
   - First run is slow (Metal shader compile). Then ~30–90 s.
   - You should get a batch of frames / a short clip out of the final node.

### If it fails on Apple Silicon

| Symptom | Fix |
|---|---|
| Out of memory / MPS allocation error | length `17`, or size `640x384`; close other GPU apps |
| `mps` op not implemented | `git pull` ComfyUI again; some ops fall back to CPU automatically |
| Very slow / stuck first run | wait it out once (shader cache); later runs are fast |
| Black / static output | raise steps to `30`, cfg to `3.5`; check the prompt landed on the **positive** node |

Do not continue until the template runs cleanly on its own.

---

## 4. Export the workflow as API format

1. ComfyUI **Settings** (gear icon) → enable **"Enable Dev mode Options"**.
2. **Workflow → Export (API)** (or "Save (API Format)").
3. Save the file, then move it into this repo:

```bash
mv ~/Downloads/workflow_api.json \
   /Users/nurkahfirahmada/Documents/Code/SUKA-SUKA/ai-game-studio/server/workflows/ltxv-i2v.json
```

The file is a flat map: `{ "6": { "class_type": "...", "inputs": {...} }, ... }`.

---

## 5. Tokenize the JSON

Open `server/workflows/ltxv-i2v.json` in an editor. Replace the concrete values
you set in step 3 with these tokens (keep the quotes — the server converts lone
numeric tokens back to numbers):

| Find (your test value) | Replace with | Which node input |
|---|---|---|
| `"image": "your-test.png"` | `"image": "%IMAGE%"` | `LoadImage` |
| positive prompt text | `"%PROMPT%"` | positive `CLIPTextEncode.text` |
| negative prompt text | `"%NEG_PROMPT%"` | negative `CLIPTextEncode.text` |
| `"width": 768` | `"width": "%WIDTH%"` | `LTXVImageToVideo` |
| `"height": 512` | `"height": "%HEIGHT%"` | `LTXVImageToVideo` |
| `"length": 25` | `"length": "%FRAMES%"` | `LTXVImageToVideo` |
| `"noise_seed": 123…` (or `"seed"`) | `"%SEED%"` | sampler |
| `"steps": 25` | `"%STEPS%"` | `LTXVScheduler` |

Leave everything else. The final node should be `SaveImage` (a batch) — a
`SaveAnimatedWEBP` / `VHS_VideoCombine` clip node also works (the app splits it
with ffmpeg).

See [`../server/workflows/README.md`](../server/workflows/README.md) for the full
token contract and a reference skeleton.

---

## 6. Point the app at it

Edit `.env`:

```bash
COMFYUI_VIDEO_WORKFLOW=server/workflows/ltxv-i2v.json
VIDEO_SIZE=768x512
VIDEO_FRAMES=25
VIDEO_STEPS=25
COMFYUI_TIMEOUT_S=600
```

`VIDEO_SIZE` must be multiples of 32; `VIDEO_FRAMES` should be `8n+1` (17, 25, 41…).
Keep `IMAGE_SIZE=1024x1024` for the sprite — the video step resizes.

---

## 7. Restart and test

```bash
# Ctrl+C the running `npm run dev`, then:
npm run dev
```

Check both backends:

```bash
curl -s localhost:8787/api/health | python3 -m json.tool
# text.reachable + image.reachable should both be true
```

In the UI:
1. Column 1 → sprite prompt → **Generate Reference Sprite**
2. Column 2 → `walk cycle, side view, no camera movement` → **Generate Frames**
3. Wait for the LTX run. Frames appear in the grid, all selected.
4. Toggle off the bad ones → **Generate Spritesheet** → **Export PNG**

---

## Troubleshooting (app side)

| Error | Cause / fix |
|---|---|
| `COMFYUI_VIDEO_WORKFLOW file not found` | Path is relative to the repo root; check the filename. |
| `ComfyUI model "…" is not installed` | The `ckpt_name` in the JSON ≠ the file in `models/checkpoints/`. |
| `ComfyUI rejected the image-to-video workflow: …` | A node error. Open the ComfyUI console, load the raw (pre-token) workflow, and Queue it manually to see which node fails. |
| `ComfyUI did not finish … in time` | Raise `COMFYUI_TIMEOUT_S`, or lower `VIDEO_FRAMES` / `VIDEO_STEPS`. |
| `ComfyUI produced no frames` | Final node isn't `SaveImage` / a recognized video node. Add a `SaveImage` fed by the `VAEDecode`. |
| Frames come out with no motion | `%PROMPT%` didn't land on the positive `CLIPTextEncode`; re-check step 5. |
| Chroma key eats the character | The sprite or the video drifted toward green. Regenerate the sprite; keep green out of the character. |
| Motion is jittery between frames | Expected — it's generated video, not hand-animated. Lower `VIDEO_STEPS` variance by fixing the seed in the JSON, or trim to the cleanest run of frames in the grid. |
