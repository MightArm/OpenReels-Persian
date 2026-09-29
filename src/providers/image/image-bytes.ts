/**
 * Image-container validation shared by every AI image provider and by the
 * pipeline that persists their output.
 *
 * A provider only guarantees "an HTTP 200 carrying some bytes". Gateways and
 * CDNs in front of the provider also serve HTML/JSON error pages with a 200
 * status, and a truncated transfer yields a partial file. Writing those bytes
 * to `scene-N-ai.png` produces an asset Remotion cannot decode, which surfaces
 * as a black beat with no error trail anywhere. Detecting the container here
 * turns that silent failure into a precise, persisted error.
 */

export type ImageFormat = "png" | "jpeg" | "webp" | "gif" | "bmp";

interface ContainerProbe {
  format: ImageFormat;
  matches: (buffer: Buffer) => boolean;
}

const CONTAINERS: ContainerProbe[] = [
  {
    format: "png",
    matches: (b) => b.length > 8 && b.subarray(0, 8).toString("hex") === "89504e470d0a1a0a",
  },
  {
    format: "jpeg",
    matches: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    format: "webp",
    matches: (b) =>
      b.length > 12 &&
      b.subarray(0, 4).toString("ascii") === "RIFF" &&
      b.subarray(8, 12).toString("ascii") === "WEBP",
  },
  { format: "gif", matches: (b) => b.length > 6 && b.subarray(0, 3).toString("ascii") === "GIF" },
  { format: "bmp", matches: (b) => b.length > 2 && b.subarray(0, 2).toString("ascii") === "BM" },
];

/** Detect the image container from magic bytes, or null when it is not an image. */
export function detectImageFormat(buffer: Buffer): ImageFormat | null {
  for (const container of CONTAINERS) {
    if (container.matches(buffer)) return container.format;
  }
  return null;
}

/** Short, log-safe description of a payload that is not a recognised image. */
function describeNonImage(buffer: Buffer): string {
  if (buffer.length === 0) return "the payload is empty (0 bytes)";

  const head = buffer.subarray(0, 64).toString("utf-8").trimStart();
  const lower = head.toLowerCase();
  if (lower.startsWith("<!doctype html") || lower.startsWith("<html")) {
    return "the payload is an HTML page (gateway/CDN error page served with a 200?)";
  }
  if (head.startsWith("{") || head.startsWith("[")) {
    return `the payload is JSON, not an image: ${buffer.subarray(0, 160).toString("utf-8")}`;
  }

  const hex = buffer.subarray(0, 8).toString("hex");
  return `the payload is not a known image container (first bytes: ${hex})`;
}

/**
 * Assert that a buffer is a non-empty, decodable image container.
 * Returns the detected format so callers can log it.
 *
 * @param context Human-readable origin used in the thrown message.
 */
export function assertImageBuffer(buffer: Buffer, context: string): ImageFormat {
  if (buffer.length === 0) {
    throw new Error(`${context}: ${describeNonImage(buffer)}`);
  }

  const format = detectImageFormat(buffer);
  if (!format) {
    throw new Error(`${context}: ${describeNonImage(buffer)}`);
  }
  return format;
}
