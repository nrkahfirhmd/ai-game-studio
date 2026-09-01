// Animation frames from a local ComfyUI image-to-video workflow.
//
// Single-keyframe (VIDEO_ENDPOSE_DENOISE=0): feed the reference sprite to I2V.
//   Good for idle / breathing / sway; weak for directed motion (the model just
//   makes the still picture move a little).
// Two-keyframe (VIDEO_ENDPOSE_DENOISE>0): first generate an end-pose sprite
//   (FLUX img2img from the reference, prompted with the motion), then let the
//   video model interpolate start -> end. Gives real directed motion for
//   attacks / jumps, at the cost of one extra image generation.
//
// Either way, every returned frame is chroma-keyed + scaled so the spritesheet
// + GIF pipeline downstream is unchanged.

import { spawn } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { getProvider } from "./ai/provider.js";
import { config } from "./config.js";
import { CHROMA_KEY_FILTER, IMAGE_CHROMA_DIRECTIVE, MOTION_CHROMA_DIRECTIVE } from "./chroma.js";
import { ensureInsideRoot } from "./files.js";

const MAX_FRAMES = 120;

function keyFrame(inputPng: string, outputPng: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-y", "-i", inputPng, "-vf", CHROMA_KEY_FILTER, outputPng],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    child.on("error", (err) =>
      reject("code" in err && err.code === "ENOENT" ? new Error("ffmpeg is not installed") : err),
    );
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg chroma-key exited with ${code}`)),
    );
  });
}

/** FLUX img2img from the reference sprite into the peak pose of the motion.
 *  The sprite prompt is deliberately NOT included — it pins the neutral stance
 *  and the end frame comes out identical to the start. The reference image keeps
 *  the character on-model; the text only describes the new pose. */
async function generateEndPose(refImage: string, motionPrompt: string): Promise<string> {
  const prompt =
    `${motionPrompt.trim()}. The character is frozen at the PEAK of this action — ` +
    `limbs fully committed, weight shifted, a dynamic pose clearly different from ` +
    `a neutral standing stance. Same character, outfit, art style and colours as ` +
    `the source image. Full body in frame, side view, centered. ${IMAGE_CHROMA_DIRECTIVE}`;
  const { base64 } = await getProvider().generateImage({
    prompt,
    image: refImage,
    denoise: config.video.endPoseDenoise,
    width: config.image.size.width,
    height: config.image.size.height,
  });
  return `data:image/png;base64,${base64}`;
}

export interface GenerateFramesOptions {
  /** data: URL of the reference sprite */
  image: string;
  motionPrompt: string;
  /** absolute path to projects/latest/frames */
  framesDir: string;
}

export async function generateFrames(opts: GenerateFramesOptions): Promise<string[]> {
  ensureInsideRoot(opts.framesDir);

  if (existsSync(opts.framesDir)) {
    for (const f of await readdir(opts.framesDir)) {
      if (f.endsWith(".png")) await rm(path.join(opts.framesDir, f));
    }
  } else {
    await mkdir(opts.framesDir, { recursive: true });
  }

  const endImage =
    config.video.endPoseDenoise > 0
      ? await generateEndPose(opts.image, opts.motionPrompt)
      : undefined;

  const rawFrames = await getProvider().generateFrames({
    image: opts.image,
    endImage,
    prompt: `${opts.motionPrompt.trim()}\n\n${MOTION_CHROMA_DIRECTIVE}`,
  });
  if (rawFrames.length === 0) throw new Error("no frames produced");

  const rawDir = path.join(opts.framesDir, ".raw");
  ensureInsideRoot(rawDir);
  await mkdir(rawDir, { recursive: true });

  const names: string[] = [];
  try {
    const frames = rawFrames.slice(0, MAX_FRAMES);
    for (let i = 0; i < frames.length; i++) {
      const num = String(i + 1).padStart(5, "0");
      const rawPng = path.join(rawDir, `raw-${num}.png`);
      const outPng = path.join(opts.framesDir, `frame-${num}.png`);
      await writeFile(rawPng, Buffer.from(frames[i], "base64"));
      await keyFrame(rawPng, outPng);
      names.push(`frame-${num}.png`);
    }
  } finally {
    await rm(rawDir, { recursive: true, force: true });
  }

  return names.sort();
}
