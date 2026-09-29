/**
 * RTL text-card render validation (acceptance checks for the RTL/font change).
 *
 * 1. English text card still  -> must be visually unchanged (Inter, LTR)
 * 2. Persian/RTL text card still -> Vazirmatn, direction:rtl
 * 3. Full composition render: stock_video scene followed by text_card scene
 *    via selectComposition + renderMedia — verifies no "No frame found" or
 *    other compositor/frame-timing errors.
 *
 * Mirrors the orchestrator's exact render flow (selectComposition before
 * renderStill/renderMedia) — a hand-built composition object does not resolve
 * inputProps in Remotion 4.0.441 and crashes in Main.
 *
 * Usage: npx tsx scripts/rtl-render-check.ts
 */
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import fs from "fs";
import path from "path";

const OUT_DIR = path.resolve("output/rtl-render-check");
const STOCK_VIDEO = path.resolve(
  "output/2026-09-19-164359-sinking-of-the-titanic/assets/scene-4-stock.mp4",
);

const makeWords = (text: string, startS: number) =>
  text
    .split(" ")
    .map((word, i) => ({ word, start: startS + i * 0.4, end: startS + (i + 1) * 0.4 }))
    .filter((w) => w.word);

const EN_TEXT = "The ocean covers seventy percent of the Earth.";
const FA_TEXT = "ذهن خود را کنترل کن، نه رویدادها را";

const textCardScene = (scriptLine: string, transition: "none" | "crossfade") => ({
  visualType: "text_card",
  assetSrc: null,
  motion: "static",
  visualPrompt: "card",
  scriptLine,
  durationInFrames: 90,
  words: makeWords(scriptLine, 0),
  colorPalette: { background: "#1a1a2e", accent: "#e94560", text: "#ffffff" },
  textCardFont: "Inter",
  motionIntensity: 1.2,
  startFrom: 0,
  sourceDurationInSeconds: undefined,
  transition,
  transitionDurationFrames: 15,
});

const stockScene = {
  visualType: "stock_video",
  assetSrc: "assets/scene-0-stock.mp4",
  motion: "static",
  visualPrompt: "stock",
  scriptLine: "Stock footage scene.",
  durationInFrames: 90,
  words: makeWords("Stock footage scene", 0),
  colorPalette: { background: "#1a1a2e", accent: "#e94560", text: "#ffffff" },
  textCardFont: "Inter",
  motionIntensity: 1.2,
  startFrom: 0,
  sourceDurationInSeconds: null,
  transition: "none" as const,
  transitionDurationFrames: 15,
};

const base = {
  captionStyle: "clean",
  voiceoverSrc: null,
  musicSrc: null,
  allWords: [],
  captionAccentColor: "#38A169",
  captionChunkSize: 5,
  captionLingerS: 0.3,
};

const STILL_COMPOSITION = {
  id: "OpenReelsVideo",
  width: 1080,
  height: 1920,
  fps: 30,
  durationInFrames: 90,
} as const;

async function renderTextCardStill(serveUrl: string, scriptLine: string, outFile: string) {
  const inputProps = { ...base, scenes: [textCardScene(scriptLine, "none")] };
  const composition = await selectComposition({
    serveUrl,
    id: "OpenReelsVideo",
    inputProps: inputProps as unknown as Record<string, unknown>,
  });
  await renderStill({
    composition: { ...composition, ...STILL_COMPOSITION },
    serveUrl,
    frame: 30,
    output: outFile,
    inputProps: inputProps as unknown as Record<string, unknown>,
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(STOCK_VIDEO)) throw new Error(`Missing stock video: ${STOCK_VIDEO}`);

  // Public dir so staticFile("assets/scene-0-stock.mp4") resolves
  const publicDir = path.join(OUT_DIR, "public");
  fs.mkdirSync(path.join(publicDir, "assets"), { recursive: true });
  fs.copyFileSync(STOCK_VIDEO, path.join(publicDir, "assets", "scene-0-stock.mp4"));

  console.log("Bundling...");
  const serveUrl = await bundle({
    entryPoint: path.resolve("src/remotion/index.ts"),
    webpackOverride: (c) => c,
    publicDir,
  });

  // ── 1. English text card still ──────────────────────────────────────────
  console.log("Rendering ENGLISH text card still...");
  await renderTextCardStill(serveUrl, EN_TEXT, path.join(OUT_DIR, "textcard-english.png"));
  console.log("  -> textcard-english.png");

  // ── 2. Persian/RTL text card still ──────────────────────────────────────
  console.log("Rendering PERSIAN text card still...");
  await renderTextCardStill(serveUrl, FA_TEXT, path.join(OUT_DIR, "textcard-persian.png"));
  console.log("  -> textcard-persian.png");

  // ── 3. Full render: stock_video scene then text_card scene ─────────────
  console.log("Rendering FULL composition (stock_video -> text_card)...");
  // Exact orchestrator flow: mapScoreToProps-equivalent props, selectComposition,
  // renderMedia. Frame math must match getTotalDurationInFrames: 90 + 90 - 15
  // transition overlap = 165 total frames.
  const props = { ...base, scenes: [stockScene, textCardScene(FA_TEXT, "crossfade")] };
  const composition = await selectComposition({
    serveUrl,
    id: "OpenReelsVideo",
    inputProps: props as unknown as Record<string, unknown>,
  });
  const totalFrames = 90 + 90 - 15;
  const outputMp4 = path.join(OUT_DIR, "full-stock-then-textcard.mp4");
  await renderMedia({
    composition: {
      ...composition,
      width: 1080,
      height: 1920,
      fps: 30,
      durationInFrames: totalFrames,
    },
    serveUrl,
    codec: "h264",
    outputLocation: outputMp4,
    inputProps: props as unknown as Record<string, unknown>,
  });
  const size = fs.statSync(outputMp4).size;
  console.log(`  -> ${outputMp4} (${(size / 1024 / 1024).toFixed(2)} MB, ${totalFrames} frames)`);

  console.log("\nALL RENDER CHECKS PASSED — no frame/compositor errors.");
  process.exit(0);
}

main().catch((err) => {
  console.error("RENDER CHECK FAILED:", err);
  process.exit(1);
});
