/**
 * Standalone Alpha image-provider check.
 *
 * Exercises `AlphaImage` in isolation — no `resolveVisualAsset()`, no
 * orchestrator, no Remotion, no rest of the pipeline — to separate
 * "the Alpha implementation is broken" from "the account/API request is
 * unavailable" (billing, quota, auth, gateway outage).
 *
 * It submits one harmless prompt, saves the returned bytes to a temp file and
 * verifies the file exists, is non-empty, and carries a real image container
 * (PNG / WEBP / JPEG magic bytes plus decoded dimensions).
 *
 * The API key is never printed.
 *
 * Usage: pnpm exec tsx --env-file=.env scripts/test-alpha-image.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AlphaImage } from "../src/providers/image/alpha.js";

const PROMPT = "a small red apple resting on a clean wooden table, soft daylight";

interface ImageInfo {
  format: "png" | "webp" | "jpeg" | "unknown";
  width?: number;
  height?: number;
}

/** Detect the container format and decode dimensions straight from the bytes. */
function describeImage(buffer: Buffer): ImageInfo {
  if (buffer.length > 24 && buffer.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") {
    return { format: "png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  if (
    buffer.length > 30 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    const chunk = buffer.subarray(12, 16).toString("ascii");
    if (chunk === "VP8X") {
      const read24 = (offset: number) =>
        buffer[offset]! | (buffer[offset + 1]! << 8) | (buffer[offset + 2]! << 16);
      return { format: "webp", width: read24(24) + 1, height: read24(27) + 1 };
    }
    if (chunk === "VP8 ") {
      return {
        format: "webp",
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      };
    }
    if (chunk === "VP8L") {
      const bits = buffer.readUInt32LE(21);
      return { format: "webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return { format: "webp" };
  }

  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return { format: "jpeg" };
  }

  return { format: "unknown" };
}

async function main(): Promise<void> {
  console.log("=== Standalone AlphaImage check ===");
  console.log(`ALPHA_API_KEY set: ${Boolean(process.env["ALPHA_API_KEY"])}`);
  if (!process.env["ALPHA_API_KEY"]) {
    console.log("RESULT: SKIPPED (no ALPHA_API_KEY in the environment)");
    return;
  }

  const provider = new AlphaImage();
  console.log(`Prompt: "${PROMPT}"`);
  console.log("Submitting to Alpha (submit -> poll -> download)...");

  const startedAt = Date.now();
  try {
    const image = await provider.generate(PROMPT);
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(2);

    console.log(`\nElapsed: ${seconds}s`);
    console.log(`Returned Buffer: ${Buffer.isBuffer(image)}`);
    console.log(`Bytes: ${image.length}`);
    console.log(`First 16 bytes (hex): ${image.subarray(0, 16).toString("hex")}`);

    const outPath = path.join(os.tmpdir(), `alpha-image-check-${Date.now()}.bin`);
    fs.writeFileSync(outPath, image);
    const stat = fs.statSync(outPath);
    console.log(`Saved to: ${outPath}`);
    console.log(`File exists: ${fs.existsSync(outPath)} (size on disk: ${stat.size} bytes)`);

    const info = describeImage(image);
    console.log(
      `Container: ${info.format}${info.width ? ` ${info.width}x${info.height}` : " (dimensions unknown)"}`,
    );

    const ok = Buffer.isBuffer(image) && image.length > 0 && stat.size === image.length;
    const readable = info.format !== "unknown";
    console.log(
      `VERDICT: ${ok && readable ? "ALPHA WORKS (valid, readable image data)" : "ALPHA RETURNED UNUSABLE DATA"}`,
    );
  } catch (err) {
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(2);
    console.log(`\nElapsed: ${seconds}s`);
    console.log("VERDICT: ALPHA REQUEST FAILED");
    console.log(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Alpha image check crashed:", err);
  process.exit(1);
});
