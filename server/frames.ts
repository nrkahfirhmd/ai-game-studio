// Animation frames without video: run FLUX.1 Schnell img2img N times from the
// reference sprite, each with a per-frame pose directive, then chroma-key each
// result to a transparent PNG. Output matches what the old ffmpeg frame
// extraction produced, so the spritesheet + GIF pipeline is unchanged.

import { spawn } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { getProvider } from "./ai/provider.js";
import { config } from "./config.js";
import { CHROMA_KEY_FILTER, MOTION_CHROMA_DIRECTIVE } from "./chroma.js";
import { ensureInsideRoot } from "./files.js";

/** Even phase label across the loop so each frame lands at a distinct pose. */
function frameDirective(motionPrompt: string, index: number, count: number): string {
  const pct = count > 1 ? Math.round((index / count) * 100) : 0;
  return (
    `${motionPrompt.trim()}\n\n` +
    `This is frame ${index + 1} of ${count} in a smooth looping animation cycle. ` +
    `Show the character's exact pose at ${pct}% through the motion. ` +
    `Same character, same art style, same scale, side-view. ` +
    `${MOTION_CHROMA_DIRECTIVE}`
  );
}

function keyFrame(inputPng: string, outputPng: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-y", "-i", inputPng, "-vf", CHROMA_KEY_FILTER, outputPng],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    child.on("error", (err) => {
      reject(
        "code" in err && err.code === "ENOENT"
          ? new Error("ffmpeg is not installed")
          : err,
      );
    });
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg chroma-key exited with ${code}`)),
    );
  });
}

export interface GenerateFramesOptions {
  /** data: URL of the reference sprite */
  image: string;
  motionPrompt: string;
  frameCount: number;
  /** absolute path to projects/latest/frames */
  framesDir: string;
}

export async function generateFrames(opts: GenerateFramesOptions): Promise<string[]> {
  const count = Math.max(1, Math.min(48, Math.round(opts.frameCount)));
  ensureInsideRoot(opts.framesDir);

  // Fresh directory
  if (existsSync(opts.framesDir)) {
    for (const f of await readdir(opts.framesDir)) {
      if (f.endsWith(".png")) await rm(path.join(opts.framesDir, f));
    }
  } else {
    await mkdir(opts.framesDir, { recursive: true });
  }

  const rawDir = path.join(opts.framesDir, ".raw");
  ensureInsideRoot(rawDir);
  await mkdir(rawDir, { recursive: true });

  const provider = getProvider();
  const names: string[] = [];

  try {
    for (let i = 0; i < count; i++) {
      const img = await provider.generateImage({
        prompt: frameDirective(opts.motionPrompt, i, count),
        image: opts.image,
        denoise: config.frames.denoise,
      });
      const num = String(i + 1).padStart(5, "0");
      const rawPng = path.join(rawDir, `raw-${num}.png`);
      const outPng = path.join(opts.framesDir, `frame-${num}.png`);
      await writeFile(rawPng, Buffer.from(img.base64, "base64"));
      await keyFrame(rawPng, outPng);
      names.push(`frame-${num}.png`);
    }
  } finally {
    await rm(rawDir, { recursive: true, force: true });
  }

  if (names.length === 0) throw new Error("no frames produced");
  return names.sort();
}
