// Animation frames from a local ComfyUI image-to-video workflow.
// Provider returns ordered raw PNG frames; here we chroma-key + scale each to a
// transparent PNG so the spritesheet + GIF pipeline downstream is unchanged.

import { spawn } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { getProvider } from "./ai/provider.js";
import { CHROMA_KEY_FILTER, MOTION_CHROMA_DIRECTIVE } from "./chroma.js";
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

  const rawFrames = await getProvider().generateFrames({
    image: opts.image,
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
