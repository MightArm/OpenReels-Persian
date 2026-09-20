import { execFileSync } from "node:child_process";
import * as readline from "node:readline";
import type { LanguageModel } from "ai";
import type { ActualCostBreakdown, CostBreakdown } from "../cli/cost-estimator.js";
import type { DirectorScore, VisualType } from "../schema/director-score.js";
import type {
  ImageProvider,
  ImageProviderKey,
  LLMProvider,
  MusicProvider,
  MusicProviderKey,
  StockProvider,
  TTSProvider,
  TTSProviderKey,
  VideoProvider,
  VideoProviderKey,
  WordTimestamp,
} from "../schema/providers.js";

// Stage names matching the pipeline execution order
export const STAGE_NAMES = [
  "research",
  "director",
  "tts",
  "visuals",
  "assembly",
  "critic",
] as const;
export type StageName = (typeof STAGE_NAMES)[number];

/**
 * Stock Only mode: map an LLM-authored visual type onto its stock equivalent.
 * ai_image scenes resolve as stock images and ai_video scenes as stock videos
 * (preferring motion); already-stock types and text_card pass through unchanged.
 */
export function toStockVisualType(type: VisualType): VisualType {
  if (type === "ai_video") return "stock_video";
  if (type === "ai_image") return "stock_image";
  return type;
}

/**
 * Read the Stock Only preference from the STOCK_ONLY environment variable.
 * Returns undefined when unset or unrecognized so callers can prompt (CLI)
 * or fall back to the default (worker/server contexts).
 */
export function stockOnlyFromEnv(): boolean | undefined {
  const raw = process.env.STOCK_ONLY;
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(v)) return true;
  if (["false", "0", "no", "n", "off"].includes(v)) return false;
  return undefined;
}

/**
 * Resolve the Stock Only preference for an interactive CLI run: the explicit
 * flag/env value (--stock-only/--no-stock-only, STOCK_ONLY) wins; otherwise
 * ask once at startup on TTYs. Non-interactive runs default to disabled.
 */
export async function resolveStockOnlyPreference(
  cliStockOnly: boolean | undefined,
  opts: { yes: boolean },
): Promise<boolean> {
  if (cliStockOnly !== undefined) return cliStockOnly;
  if (opts.yes || !process.stdin.isTTY) return false;
  const enabled = await confirm("Use cost-free stock media only?");
  console.log(
    enabled
      ? "Stock Only mode enabled: AI image/video providers will not be called."
      : "Stock Only mode disabled.",
  );
  return enabled;
}

export interface PipelineCallbacks {
  onStageStart?(stage: StageName): void;
  onStageComplete?(stage: StageName, detail: string, durationSec: number): void;
  onStageSkip?(stage: StageName, reason: string): void;
  onStageError?(stage: StageName, error: string): void;
  onProgress?(stage: StageName, data: Record<string, unknown>): void;
  onCostEstimate?(
    estimate: CostBreakdown,
    imageProvider: ImageProviderKey,
    stockSceneCount?: number,
  ): Promise<boolean>;
  onActualCost?(cost: ActualCostBreakdown): void;
  onLog?(message: string): void;
  /** Called once the run directory is created, before any stage runs. */
  onRunDir?(runDir: string): void;
  /** Called when pipeline is cancelled between stages. Return true if cancelled. */
  isCancelled?(): boolean;
}

export interface PipelineOptions {
  topic: string;
  llm: LLMProvider;
  tts: TTSProvider;
  ttsProvider: TTSProviderKey;
  imageGen: ImageProvider;
  imageProvider: ImageProviderKey;
  stock: StockProvider[];
  archetype?: string;
  pacing?: string;
  platform: string;
  dryRun: boolean;
  preview: boolean;
  outputDir: string;
  yes: boolean;
  noMusic?: boolean;
  musicProvider?: MusicProvider;
  musicProviderKey?: MusicProviderKey;
  stockVerify?: boolean;
  stockConfidence?: number;
  stockMaxAttempts?: number;
  verifyModel?: LanguageModel;
  videoProviders?: VideoProvider[];
  videoProvider?: VideoProviderKey;
  noVideo?: boolean;
  /**
   * Stock Only mode: resolve every scene with cost-free stock media and never
   * call AI image/video providers. Inquiries from the LLM (ai_image/ai_video)
   * are remapped to stock equivalents; the stock resolver's AI fallback is off.
   */
  stockOnly?: boolean;
  direction?: string;
  replayScore?: DirectorScore;
}

export interface PipelineResult {
  outputDir: string;
  videoPath: string | null;
  thumbnailPath: string | null;
  scorePath: string;
  logPath: string;
}

export function shouldAutoConfirm(yes: boolean): boolean {
  return yes || !process.stdin.isTTY;
}

export function shouldSkipPreview(): boolean {
  return !process.stdin.isTTY;
}

export function splitWordsIntoScenes(
  score: DirectorScore,
  allWords: WordTimestamp[],
): WordTimestamp[][] {
  // Split word timestamps into per-scene groups for duration calculation.
  // Uses ReelMistri's proportional scaling approach to handle ElevenLabs
  // text normalization (numbers/abbreviations expand into different word counts).
  //
  // Note: This is only used for scene DURATION calculation. Captions use
  // allWords directly with absolute timestamps (timeline-centric approach).

  if (allWords.length === 0) {
    return score.scenes.map(() => []);
  }

  // Count expected words per scene from script text
  const wordsPerScene = score.scenes.map((s) => s.script_line.split(/\s+/).filter(Boolean).length);
  const totalExpected = wordsPerScene.reduce((sum, n) => sum + n, 0);
  const totalActual = allWords.length;

  const sceneWords: WordTimestamp[][] = [];
  let wordIndex = 0;

  for (let i = 0; i < score.scenes.length; i++) {
    const expectedCount = wordsPerScene[i] ?? 0;

    // Proportionally scale word consumption if TTS word count differs
    // (ReelMistri: tts.py lines 179-182)
    let wordsToConsume = expectedCount;
    if (totalExpected !== totalActual && totalExpected > 0) {
      wordsToConsume = Math.round((expectedCount * totalActual) / totalExpected);
      wordsToConsume = Math.max(1, wordsToConsume);
    }

    const words: WordTimestamp[] = [];
    for (let j = 0; j < wordsToConsume && wordIndex < allWords.length; j++) {
      const w = allWords[wordIndex];
      if (w) words.push(w);
      wordIndex++;
    }

    sceneWords.push(words);
  }

  // Any remaining words go to the last scene
  const lastScene = sceneWords[sceneWords.length - 1];
  if (lastScene) {
    while (wordIndex < allWords.length) {
      const w = allWords[wordIndex];
      if (w) lastScene.push(w);
      wordIndex++;
    }
  }

  return sceneWords;
}

export function getVideoDuration(filePath: string): number | null {
  try {
    const result = execFileSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath],
      { encoding: "utf-8" },
    );
    const duration = parseFloat(result.trim());
    return Number.isFinite(duration) ? duration : null;
  } catch {
    return null;
  }
}

export function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} [Y/n] `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() !== "n");
    });
  });
}
