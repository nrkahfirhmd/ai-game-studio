// Single source of truth for the keyable background colour. Referenced by the
// image prompt, the frame prompt, and the ffmpeg key filter.

export const CHROMA_HEX = "0x00b140"; // #00b140  RGB(0,177,64)

/** ffmpeg filter: key the green, scale to 320 wide, emit RGBA. */
export const CHROMA_KEY_FILTER = `chromakey=${CHROMA_HEX}:0.15:0.08,scale=320:-1,format=rgba`;

export const IMAGE_CHROMA_DIRECTIVE =
  "Place the subject on a perfectly flat solid pure chroma green background, " +
  "hex #00b140 (RGB 0, 177, 64). The background must be one uniform color " +
  "with no gradients, no shadows, no lighting variation, and no texture. " +
  "The subject itself must contain no green elements that could conflict " +
  "with chroma keying. Centered, full subject visible.";

export const MOTION_CHROMA_DIRECTIVE =
  "Keep the exact same flat solid pure chroma green background, hex #00b140, " +
  "with no background changes, no environmental elements, no shadows on the " +
  "background, and no camera movement. The subject stays centered at the same scale.";
