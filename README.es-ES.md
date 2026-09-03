# AI Game Studio

Una aplicación web local — y el inicio de un AI Game Studio más completo — para generar activos de juegos a partir de prompts de texto. Por ahora: sprites de referencia 2D y fotogramas de animación compuestos en una spritesheet de 1×N con una vista previa animada en bucle. Los fondos se recortan automáticamente a transparencia mediante chroma-key, por lo que los fotogramas pueden insertarse directamente en un motor de juego. Los proyectos se pueden guardar y cargar por nombre.

**Toda la inferencia se ejecuta localmente.** Sin OpenRouter, sin OpenAI, sin clave API, sin coste por petición. El texto usa [Ollama](https://ollama.com); el sprite de referencia lo genera [FLUX.1 Schnell](https://huggingface.co/black-forest-labs/FLUX.1-schnell) y los fotogramas de movimiento un modelo local de imagen-a-video — ambos en [ComfyUI](https://github.com/comfyanonymous/ComfyUI). La velocidad y la calidad dependen de tu hardware.

![Mockup](mockup.png)

## Requisitos

- Node 20+
- `ffmpeg` en el `PATH`
- [Ollama](https://ollama.com) — texto / mejora de prompts
- [ComfyUI](https://github.com/comfyanonymous/ComfyUI) — generación de imágenes y fotogramas

## Instalación local

### 1. Ollama (texto)

Instala desde [ollama.com](https://ollama.com), luego:

```bash
ollama serve
ollama pull qwen3:8b
```

### 2. ComfyUI (imágenes + fotogramas de movimiento)

Instala según la [documentación de ComfyUI](https://github.com/comfyanonymous/ComfyUI#installing), luego descarga los modelos en `ComfyUI/models/`:

**Sprite de referencia** — FLUX.1 Schnell, `checkpoints/flux1-schnell-fp8.safetensors` (~17 GB, de [Comfy-Org/flux1-schnell](https://huggingface.co/Comfy-Org/flux1-schnell)).
¿Poca VRAM? Usa un quant GGUF — ver las notas de `COMFYUI_IMAGE_MODEL` en `.env.example`.

**Fotogramas de movimiento** — un modelo local de imagen-a-video. El predeterminado es Stable Video Diffusion: `checkpoints/svd_xt.safetensors` (~9 GB, de [stabilityai/stable-video-diffusion-img2vid-xt](https://huggingface.co/stabilityai/stable-video-diffusion-img2vid-xt)).
Para LTX-Video / Wan2.1 / CogVideoX (incluidos quants GGUF para poca VRAM), construye el workflow en ComfyUI y apunta `COMFYUI_VIDEO_WORKFLOW` a él — ver [`server/workflows/README.md`](server/workflows/README.md).

Luego inícialo:

```bash
python main.py        # sirve http://127.0.0.1:8188
```

### 3. La aplicación

```bash
npm install
cp .env.example .env  # los valores por defecto coinciden con una instalación estándar de Ollama + ComfyUI
npm run dev
```

Abre http://localhost:5173.

Esto inicia Vite (frontend, :5173) y un servidor Express (backend, :8787) simultáneamente. Deténlo con `Ctrl+C`.

## Cómo usarlo

1. Escribe un prompt de sprite en la columna 1. Opcionalmente haz clic en **✨ Enhance** para ampliarlo con el LLM local → **Generate Reference Sprite**.
2. Escribe un prompt de movimiento en la columna 2 (Enhance también disponible aquí) → **Generate Frames**. La aplicación pasa el sprite de referencia a un modelo local de imagen-a-video en ComfyUI y luego aplica chroma-key a cada fotograma extraído para obtener un PNG transparente.
3. Haz clic en los cuadros de los fotogramas para activar o desactivar cuáles incluir.
4. **Generate Spritesheet** → compone un PNG de 1×N en el cliente y genera una vista previa GIF en bucle en el servidor.
5. **Export PNG** para descargar la spritesheet.
6. Encabezado: **New** para empezar desde cero, **Save** para nombrar y guardar una instantánea del proyecto actual, **Load** para cambiar a uno guardado.

Los artefactos generados se almacenan en `projects/` (ignorado por git). El estado de trabajo actual siempre estará en `projects/latest/`.

## Configuración

Todos los modelos y valores por defecto son variables de entorno (ver `.env.example`):

| Variable | Por defecto | Propósito |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Endpoint de Ollama |
| `OLLAMA_TEXT_MODEL` | `qwen3:8b` | LLM para la mejora de prompts — cámbialo por `qwen3:14b`, `gpt-oss:20b`, etc. |
| `COMFYUI_BASE_URL` | `http://127.0.0.1:8188` | Endpoint de ComfyUI |
| `COMFYUI_IMAGE_MODEL` | `flux1-schnell-fp8.safetensors` | Checkpoint del sprite (o un `.gguf` en `models/unet/`) |
| `IMAGE_SIZE` | `1024x1024` | Dimensiones del sprite de referencia (ajustadas a /16 para FLUX) |
| `COMFYUI_VIDEO_MODEL` | `svd_xt.safetensors` | Checkpoint imagen-a-video (SVD) del workflow integrado |
| `COMFYUI_VIDEO_WORKFLOW` | _(sin definir)_ | Ruta a un workflow exportado en formato API — reemplaza SVD (LTX/Wan/CogVideoX/…) |
| `VIDEO_FRAMES` | `25` | Fotogramas que produce el modelo de video |
| `VIDEO_MOTION` | `127` | Fuerza de movimiento de SVD (1–255) |
| `VIDEO_STEPS` | `20` | Pasos del sampler de video |
| `VIDEO_SIZE` | `768x768` | Dimensiones de video (ajustadas a /64) |
| `COMFYUI_TIMEOUT_S` | `600` | Límite de espera por generación |
| `ENABLE_PROMPT_ENHANCER` | `true` | Mostrar los botones ✨ Enhance |
| `PORT` | `8787` | Puerto de Express |

No se necesita ningún cambio de código para cambiar de modelo — solo edita `.env` y reinicia. Ver [`server/workflows/README.md`](server/workflows/README.md) para pipelines de video personalizados.

## Prompts de ejemplo

### Prompts de sprite

- `A pixel-art knight in silver armor with a longsword, side-view, full body, simple flat colors, standing pose`
- `Female ninja with red scarf, dynamic side-view, 2D sprite, anime style`
- `Cute green slime monster, side-view, big eyes, soft shading`
- `Cyberpunk hacker in a hoodie, glowing visor, side-view full body, gritty style`

### Prompts de movimiento

- `Smooth walk cycle, side-view, no head tilting, no camera movement`
- `Sword slash attack, side-view, fast, no shadows`
- `Idle breathing animation, subtle, looping`
- `Jump arc — crouch, leap, mid-air, land`

Consejos:
- Mantén los prompts de movimiento enfocados en la acción. Frases como *"no camera movement"*, *"side-view"* y *"no head tilting"* ayudan a mantener los fotogramas listos para el juego.
- FLUX.1 Schnell (sprite) es un modelo destilado de 4 pasos — ignora CFG / prompts negativos. El fondo verde chroma se controla con el prompt positivo más la red de seguridad del chroma-key de ffmpeg.
- Los fotogramas vienen de un pase imagen-a-video. SVD da movimiento corto y sutil (bueno para idle/respiración); para locomoción (caminar/correr/atacar) usa un modelo condicionado por texto vía `COMFYUI_VIDEO_WORKFLOW` (LTX-Video, Wan2.1) para que el prompt de movimiento realmente lo dirija.
- `VIDEO_MOTION` ajusta cuánto se mueve SVD; `VIDEO_FRAMES` fija cuántos fotogramas obtienes para recortar en la cuadrícula.

## Solución de problemas

| Problema | Solución |
|---|---|
| `Cannot connect to Ollama` | `ollama serve`; comprueba `OLLAMA_BASE_URL`. |
| `Text model "…" is not installed` | `ollama pull qwen3:8b` |
| `Cannot connect to ComfyUI` | Inicia ComfyUI (`python main.py`); comprueba `COMFYUI_BASE_URL`. |
| `checkpoint "…" not found` / `model "…" is not installed` | Pon el archivo en la carpeta correcta de `ComfyUI/models/` y reinicia ComfyUI. Para video con poca VRAM, usa `COMFYUI_VIDEO_WORKFLOW` con un workflow GGUF de LTX/Wan. |
| `ComfyUI did not finish … in time` | Sube `COMFYUI_TIMEOUT_S`. |
| Sin memoria | Modelo de texto más pequeño (`qwen3:4b`); FLUX GGUF Q4; workflow de video GGUF; baja `IMAGE_SIZE` / `VIDEO_SIZE` / `VIDEO_FRAMES`. |
| Generación lenta | Aceleración por GPU para ComfyUI; baja `VIDEO_FRAMES` / `VIDEO_STEPS`; tamaños más pequeños. |

## TO-DO

- [ ] Generación de fondos
- [ ] Generación de tilemaps
- [ ] Exportación a formato Aseprite
- [ ] Exportación a formato Tiled
- [ ] Generación de SFX
- [ ] Generación de música
- [ ] Generación de voz
- [ ] Exportación de estructura completa de activos

## Más información

Consulta [AGENTS.md](AGENTS.md) para la especificación completa, arquitectura, lista de endpoints y la capa de proveedores. Consulta [docs/spec.md](docs/spec.md) para la especificación de migración a IA local.
