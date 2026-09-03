// Image format guards + JPEG→PNG normalization via ffmpeg.

import { spawn } from "node:child_process";

export function isPng(buffer: Buffer): boolean {
  return (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  );
}

export function isJpeg(buffer: Buffer): boolean {
  return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

/** Return base64 PNG. Pass-through if already PNG; transcode if JPEG; throw otherwise. */
export async function normalizeImageToPng(
  base64: string,
  declaredMediaType?: string,
): Promise<string> {
  const source = Buffer.from(base64, "base64");
  if (isPng(source)) return base64;

  if (!isJpeg(source)) {
    const format = declaredMediaType ?? "unknown format";
    throw new Error(`unsupported image format: ${format}`);
  }

  const png = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let stderr = "";
    const child = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-vcodec",
        "png",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      const message =
        "code" in err && err.code === "ENOENT" ? "ffmpeg is not installed" : err.message;
      reject(new Error(`JPEG to PNG conversion failed: ${message}`));
    });
    child.stdin.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code !== "EPIPE") reject(err);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `JPEG to PNG conversion failed${stderr.trim() ? `: ${stderr.trim()}` : ` (ffmpeg exited with ${code})`}`,
          ),
        );
        return;
      }
      const output = Buffer.concat(chunks);
      if (!isPng(output)) {
        reject(new Error("JPEG to PNG conversion did not produce a PNG"));
        return;
      }
      resolve(output);
    });

    child.stdin.end(source);
  });

  return png.toString("base64");
}
