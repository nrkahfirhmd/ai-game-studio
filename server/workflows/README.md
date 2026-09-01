# Custom image-to-video workflows

By default, movement frames come from **Stable Video Diffusion** (`server/ai/comfyui.ts`,
`buildSvdWorkflow`). To use **LTX-Video**, **Wan2.1**, **CogVideoX**, **AnimateDiff**,
or any other ComfyUI video pipeline, export it as an API-format workflow, add the
placeholder tokens below, and point `COMFYUI_VIDEO_WORKFLOW` at the file.

## How

1. Build the workflow in ComfyUI and confirm it runs on its own.
2. Enable **Settings → Enable dev mode options**, then **Save (API Format)**.
   You get a JSON object of `{ "<nodeId>": { "class_type": ..., "inputs": {...} }, ... }`.
3. Replace concrete values with tokens (see table). Save it under `server/workflows/`.
4. Set `COMFYUI_VIDEO_WORKFLOW=server/workflows/your-file.json` in `.env` and restart.

The app uploads the reference sprite to ComfyUI first, then substitutes tokens and
submits the graph. It reads frames back from whichever node produces them:

- a `SaveImage` node emitting a **batch** of frames, **or**
- a `VHS_VideoCombine` / `SaveAnimatedWEBP` / `SaveVideo` node emitting one clip
  (the app runs `ffmpeg` to split it into frames).

All frames are then chroma-keyed (`#00b140` → transparent) and scaled, same as before.

## Tokens

| Token | Replaced with | Typical node input |
|---|---|---|
| `%IMAGE%` | uploaded reference filename (string) | `LoadImage.image` |
| `%PROMPT%` | motion prompt + chroma directive (string) | positive `CLIPTextEncode.text` |
| `%NEG_PROMPT%` | a generic negative (string) | negative `CLIPTextEncode.text` |
| `%SEED%` | random int | sampler `seed` / `noise_seed` |
| `%FRAMES%` | `VIDEO_FRAMES` (number) | `length` / `video_frames` / `batch_size` |
| `%WIDTH%` | `VIDEO_SIZE` width (number) | `width` |
| `%HEIGHT%` | `VIDEO_SIZE` height (number) | `height` |
| `%MOTION%` | `VIDEO_MOTION` (number) | SVD `motion_bucket_id`, LTX `frame_rate`, etc. |
| `%STEPS%` | `VIDEO_STEPS` (number) | sampler `steps` |

A value that is *exactly* a token (`"seed": "%SEED%"`) is replaced with the raw
number. A token inside a longer string (`"text": "side view, %PROMPT%"`) is
string-substituted. Unused tokens are harmless.

## Example skeleton (LTX-Video I2V — adapt node names to your ComfyUI version)

```json
{
  "1":  { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "ltx-video-2b-v0.9.5.safetensors" } },
  "2":  { "class_type": "CLIPLoader", "inputs": { "clip_name": "t5xxl_fp16.safetensors", "type": "ltxv" } },
  "3":  { "class_type": "LoadImage", "inputs": { "image": "%IMAGE%" } },
  "4":  { "class_type": "CLIPTextEncode", "inputs": { "text": "%PROMPT%", "clip": ["2", 0] } },
  "5":  { "class_type": "CLIPTextEncode", "inputs": { "text": "%NEG_PROMPT%", "clip": ["2", 0] } },
  "6":  { "class_type": "LTXVImageToVideo",
          "inputs": { "positive": ["4",0], "negative": ["5",0], "vae": ["1",2], "image": ["3",0],
                      "width": "%WIDTH%", "height": "%HEIGHT%", "length": "%FRAMES%", "batch_size": 1 } },
  "7":  { "class_type": "KSampler",
          "inputs": { "seed": "%SEED%", "steps": "%STEPS%", "cfg": 3.0, "sampler_name": "euler",
                      "scheduler": "normal", "denoise": 1.0, "model": ["1",0],
                      "positive": ["6",0], "negative": ["6",1], "latent_image": ["6",2] } },
  "8":  { "class_type": "VAEDecode", "inputs": { "samples": ["7",0], "vae": ["1",2] } },
  "9":  { "class_type": "SaveImage", "inputs": { "filename_prefix": "ags-frame", "images": ["8",0] } }
}
```
