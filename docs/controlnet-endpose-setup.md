# ControlNet end-pose rig (crisp attack / jump animation)

The two-keyframe flow generates an **end-pose sprite**, then LTX-Video interpolates
`reference → end-pose`. FLUX Schnell can't repose a character without also
changing it. This rig fixes that:

```
(pure txt2img) SDXL "<motion>, dynamic action pose"  ──► rough figure  ──► DWPose ──► OpenPose skeleton
                                                                                          │
reference sprite ──► IPAdapter (identity)  ─┐                                              │
                                            ├─► SDXL, empty latent ◄── OpenPose ControlNet(skeleton)
                                            │                          ──► original character IN the pose
```

Identity comes from IPAdapter (not img2img — img2img from a standing sprite drags
the result back to standing). Pose comes from the ControlNet skeleton. The latent
starts empty so there's no standing bias.

Workflow file: [`../server/workflows/endpose-controlnet.json`](../server/workflows/endpose-controlnet.json).

---

## 1. Custom nodes

**comfyui_controlnet_aux** (`DWPreprocessor`) and **ComfyUI_IPAdapter_plus**
(`IPAdapterUnifiedLoader`):

```bash
cd ~/ComfyUI-Installs/ComfyUI/ComfyUI/custom_nodes
git clone https://github.com/Fannovel16/comfyui_controlnet_aux
git clone https://github.com/cubiq/ComfyUI_IPAdapter_plus
~/ComfyUI-Installs/ComfyUI/ComfyUI/.venv/bin/python -m pip install -r comfyui_controlnet_aux/requirements.txt
```

Restart ComfyUI. (Original single-node instructions below still apply if you only
want `comfyui_controlnet_aux`.)

- ComfyUI → Manager → Custom Nodes Manager → search "controlnet aux" → install → restart.
- Or: `cd ComfyUI/custom_nodes && git clone https://github.com/Fannovel16/comfyui_controlnet_aux && pip install -r comfyui_controlnet_aux/requirements.txt`

First run downloads the DWPose ONNX models (`yolox_l.onnx`, `dw-ll_ucoco_384.onnx`)
automatically — needs internet once. They run on CPU (fine on M-series).

## 2. Models

Into `ComfyUI/models/`:

| File | Folder | Size | Source |
|---|---|---|---|
| `sd_xl_base_1.0.safetensors` | `checkpoints/` | ~6.5 GB | [stabilityai/stable-diffusion-xl-base-1.0](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0) |
| `controlnet-openpose-sdxl-1.0.safetensors` | `controlnet/` | ~2.5 GB | [xinsir/controlnet-openpose-sdxl-1.0](https://huggingface.co/xinsir/controlnet-openpose-sdxl-1.0) |
| `ip-adapter-plus_sdxl_vit-h.safetensors` | `ipadapter/` | ~850 MB | [h94/IP-Adapter](https://huggingface.co/h94/IP-Adapter) |
| `CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors` | `clip_vision/` | ~2.5 GB | [h94/IP-Adapter](https://huggingface.co/h94/IP-Adapter) (image_encoder) |

```bash
cd ~/ComfyUI-Shared/models/checkpoints
curl -L -o sd_xl_base_1.0.safetensors \
  "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors?download=true"

cd ~/ComfyUI-Shared/models/controlnet
curl -L -o controlnet-openpose-sdxl-1.0.safetensors \
  "https://huggingface.co/xinsir/controlnet-openpose-sdxl-1.0/resolve/main/diffusion_pytorch_model.safetensors?download=true"

mkdir -p ~/ComfyUI-Shared/models/ipadapter
cd ~/ComfyUI-Shared/models/ipadapter
curl -L -o ip-adapter-plus_sdxl_vit-h.safetensors \
  "https://huggingface.co/h94/IP-Adapter/resolve/main/sdxl_models/ip-adapter-plus_sdxl_vit-h.safetensors?download=true"

cd ~/ComfyUI-Shared/models/clip_vision
curl -L -o CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors \
  "https://huggingface.co/h94/IP-Adapter/resolve/main/models/image_encoder/model.safetensors?download=true"
```

(A pixel-art or anime SDXL fine-tune usually beats base SDXL for game sprites —
swap the `ckpt_name` in the workflow JSON if you have one.)

## 3. Enable it

`.env`:

```bash
COMFYUI_VIDEO_WORKFLOW=server/workflows/ltxv-keyframes.json
COMFYUI_ENDPOSE_WORKFLOW=server/workflows/endpose-controlnet.json
VIDEO_ENDPOSE_DENOISE=0.8    # ControlNet holds the pose, so denoise can be high
VIDEO_END_STRENGTH=0.8       # LTX end-frame guide — high, the pose is trustworthy now
VIDEO_SIZE=512x512
VIDEO_FRAMES=25
COMFYUI_TIMEOUT_S=1200       # SDXL x2 + DWPose + LTX per Generate Frames
```

Restart `npm run dev`. `Generate Frames` now runs: SDXL rough → DWPose → SDXL
(IPAdapter + ControlNet) end pose → LTX interpolation → chroma-key. Expect
~5–10 min per action on an M5. The workflow writes `ags-debug-rough_*.png` and
`ags-debug-skeleton_*.png` to ComfyUI/output — check those if the end pose is off.

## 4. Tuning

| Symptom | Change |
|---|---|
| End character doesn't match the sprite | IPAdapter `weight` (node 6) → `1.0`; try `embeds_scaling: "K+V"` |
| Pose ignored, character stands neutral | ControlNet `strength` (node 43) → `0.9`; `end_percent` → `1.0`; check `ags-debug-skeleton` is actually dynamic |
| End pose still too close to idle | Raise the rough-pass `denoise` (node 21) toward `0.95`; sharpen the motion prompt ("right arm fully extended, torso rotated, weight on front foot") |
| End character drifts from the reference | Lower `VIDEO_ENDPOSE_DENOISE` (0.6–0.7); raise ControlNet `strength` (node 43) is fine, that only holds pose |
| Skeleton is garbage / DWPose finds nothing | The rough figure is unreadable — lower rough `denoise` to `0.8` so it stays a clean humanoid |
| Legs / arms cut off in the end pose | Add "full body, head to feet in frame, centered" to node 41; the reference already has margin |
| Green background lost in the end pose | Node 41 already asks for `#00b140`; raise its weight or lower `denoise` |

## 5. Cheaper fallback

No SDXL headroom? Set `COMFYUI_ENDPOSE_WORKFLOW` to a **FLUX Dev** img2img
workflow instead (tokens `%IMAGE% %PROMPT% %SEED% %WIDTH% %HEIGHT% %DENOISE%`).
FLUX Dev follows pose prompts far better than Schnell — no ControlNet, no SDXL,
just a bigger checkpoint. Weaker pose fidelity than the ControlNet rig, stronger
than Schnell.
