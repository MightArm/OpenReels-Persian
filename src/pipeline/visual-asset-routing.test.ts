import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlphaImage } from "../providers/image/alpha.js";
import { GeminiImage } from "../providers/image/gemini.js";
import { resolveVisualAsset } from "./orchestrator.js";
import { VisualAssetError } from "./visual-diagnostics.js";
import { getArchetype } from "../config/archetype-registry.js";
import type { Scene } from "../schema/director-score.js";
import type { PipelineOptions, PipelineCallbacks } from "./utils.js";
import type { VideoProvider } from "../schema/providers.js";

// Mock optimizeImagePrompt so we don't call real LLM agents
vi.mock("../agents/image-prompter.js", () => ({
  optimizeImagePrompt: vi.fn().mockImplementation((_llm, visualPrompt) =>
    Promise.resolve({
      prompt: visualPrompt,
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
  ),
}));

/** PNG signature, so fixtures pass image-container validation. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A distinct, container-valid "image" fixture (the bytes are never decoded here). */
function png(label: string): Buffer {
  return Buffer.concat([PNG_SIGNATURE, Buffer.from(label)]);
}

function dummyScene(overrides: Partial<Scene> = {}): Scene {
  return {
    visual_type: "ai_image",
    visual_prompt: "A beautiful mountain landscape",
    motion: "static",
    script_line: "A cinematic scene",
    transition: null,
    ...overrides,
  };
}

function dummyOpts(overrides: Partial<PipelineOptions> = {}): PipelineOptions {
  return {
    topic: "test",
    llm: {} as any,
    tts: {} as any,
    ttsProvider: "alpha",
    imageGen: {} as any,
    imageProvider: "alpha",
    stock: [],
    platform: "tiktok",
    dryRun: false,
    preview: false,
    outputDir: "/tmp",
    yes: true,
    ...overrides,
  };
}

const dummyCallbacks: PipelineCallbacks = {};

describe("Visual asset routing: Alpha Image provider & video boundary isolation", () => {
  let assetsDir: string;
  const archetype = getArchetype("cinematic_documentary");

  beforeEach(() => {
    assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), "openreels-routing-test-"));
  });

  afterEach(() => {
    fs.rmSync(assetsDir, { recursive: true, force: true });
  });

  it("Alpha Image follows the normal AI-image provider path identically to other providers", async () => {
    const alpha = new AlphaImage("flux", "test-alpha-key");
    const fakeImageBuffer = png("fake-alpha-image-png-bytes");
    const alphaGenerateSpy = vi.spyOn(alpha, "generate").mockResolvedValue(fakeImageBuffer);

    const scene = dummyScene({ visual_type: "ai_image" });
    const opts = dummyOpts({ imageGen: alpha, imageProvider: "alpha" });

    const result = await resolveVisualAsset(scene, 0, 1, assetsDir, opts, archetype, dummyCallbacks);

    expect(alphaGenerateSpy).toHaveBeenCalledTimes(1);
    expect(result.path).toBeTruthy();
    expect(fs.existsSync(result.path!)).toBe(true);
    expect(fs.readFileSync(result.path!)).toEqual(fakeImageBuffer);
  });

  it("ai_video scene does NOT route into Alpha Image for video generation; generates first frame via Alpha and falls back to static image when no video provider", async () => {
    const alpha = new AlphaImage("flux", "test-alpha-key");
    const fakeImageBuffer = png("fake-alpha-frame-png");
    const alphaGenerateSpy = vi.spyOn(alpha, "generate").mockResolvedValue(fakeImageBuffer);

    // Assert boundary: AlphaImage does NOT implement VideoProvider
    expect("supportedDurations" in alpha).toBe(false);
    expect((alpha as unknown as VideoProvider).supportedDurations).toBeUndefined();

    const scene = dummyScene({ visual_type: "ai_video" });
    const opts = dummyOpts({
      imageGen: alpha,
      imageProvider: "alpha",
      videoProviders: [], // No video providers available
    });

    const result = await resolveVisualAsset(scene, 1, 1, assetsDir, opts, archetype, dummyCallbacks);

    // Alpha generate was called exactly once to produce the initial frame
    expect(alphaGenerateSpy).toHaveBeenCalledTimes(1);
    // Because no videoProviders were passed, it gracefully fell back to static ai_image
    expect(result.path).toBeTruthy();
    expect(result.path!.endsWith(".png")).toBe(true);
    expect(fs.existsSync(result.path!)).toBe(true);
    expect(fs.readFileSync(result.path!)).toEqual(fakeImageBuffer);
  });

  it("ai_video scene routes video generation strictly to VideoProvider, using Alpha only for initial frame", async () => {
    const alpha = new AlphaImage("flux", "test-alpha-key");
    const fakeImageBuffer = png("fake-alpha-initial-frame");
    const alphaGenerateSpy = vi.spyOn(alpha, "generate").mockResolvedValue(fakeImageBuffer);

    const tempVideoFile = path.join(assetsDir, "mock-temp-video.mp4");
    fs.writeFileSync(tempVideoFile, "fake-mp4-video-stream");

    const mockVideoProvider: VideoProvider = {
      supportedDurations: [5],
      generate: vi.fn().mockResolvedValue({
        filePath: tempVideoFile,
        durationSeconds: 5,
      }),
    };

    const scene = dummyScene({ visual_type: "ai_video" });
    const opts = dummyOpts({
      imageGen: alpha,
      imageProvider: "alpha",
      videoProviders: [mockVideoProvider],
    });

    const result = await resolveVisualAsset(scene, 2, 1, assetsDir, opts, archetype, dummyCallbacks, 5);

    expect(alphaGenerateSpy).toHaveBeenCalledTimes(1);
    expect(mockVideoProvider.generate).toHaveBeenCalledTimes(1);
    expect(result.path).toBeTruthy();
    expect(result.path!.endsWith(".mp4")).toBe(true);
    expect(fs.existsSync(result.path!)).toBe(true);
  });

  it("stock fallback to AI image correctly invokes Alpha Image without special branching", async () => {
    const alpha = new AlphaImage("flux", "test-alpha-key");
    const fakeFallbackBuffer = png("fake-alpha-fallback-png");
    const alphaGenerateSpy = vi.spyOn(alpha, "generate").mockResolvedValue(fakeFallbackBuffer);

    const scene = dummyScene({ visual_type: "stock_video" });

    const emptyStockSearcher = {
      searchVideo: vi.fn().mockResolvedValue([]),
      searchImage: vi.fn().mockResolvedValue([]),
      download: vi.fn(),
    };

    const opts = dummyOpts({
      imageGen: alpha,
      imageProvider: "alpha",
      stock: [emptyStockSearcher as any],
    });

    const result = await resolveVisualAsset(scene, 3, 1, assetsDir, opts, archetype, dummyCallbacks);

    expect(alphaGenerateSpy).toHaveBeenCalledTimes(1);
    expect(result.path).toBeTruthy();
    expect(fs.existsSync(result.path!)).toBe(true);
    expect(fs.readFileSync(result.path!)).toEqual(fakeFallbackBuffer);
  });

  it("stockOnly mode suppresses Alpha Image invocation even when imageProvider is alpha and scenes are ai_image or ai_video", async () => {
    const alpha = new AlphaImage("flux", "test-alpha-key");
    const alphaGenerateSpy = vi.spyOn(alpha, "generate");

    const scene = dummyScene({ visual_type: "ai_image" });

    const stockAssetPath = path.join(assetsDir, "stock-downloaded.jpg");
    fs.writeFileSync(stockAssetPath, "mock-stock-bytes");

    const mockStockSearcher = {
      searchVideo: vi.fn().mockResolvedValue([]),
      searchImage: vi.fn().mockResolvedValue([
        { id: "stock-1", url: "http://example.com/img.jpg", width: 1080, height: 1920 },
      ]),
      download: vi.fn().mockResolvedValue({
        filePath: stockAssetPath,
        width: 1080,
        height: 1920,
      }),
    };

    const opts = dummyOpts({
      imageGen: alpha,
      imageProvider: "alpha",
      stockOnly: true,
      stock: [mockStockSearcher as any],
      stockVerify: false,
    });

    const result = await resolveVisualAsset(scene, 4, 1, assetsDir, opts, archetype, dummyCallbacks);

    // Alpha generate was NEVER called because stockOnly remapped to stock
    expect(alphaGenerateSpy).not.toHaveBeenCalled();
    expect(result.path).toBeTruthy();
  });

  it("existing image providers (Gemini) continue to follow the identical path", async () => {
    const gemini = new GeminiImage("gemini-2.0-flash", "test-gemini-key");
    const fakeGeminiBuffer = png("fake-gemini-png");
    const geminiGenerateSpy = vi.spyOn(gemini, "generate").mockResolvedValue(fakeGeminiBuffer);

    const scene = dummyScene({ visual_type: "ai_image" });
    const opts = dummyOpts({
      imageGen: gemini,
      imageProvider: "gemini",
    });

    const result = await resolveVisualAsset(scene, 5, 1, assetsDir, opts, archetype, dummyCallbacks);

    expect(geminiGenerateSpy).toHaveBeenCalledTimes(1);
    expect(result.path).toBeTruthy();
    expect(fs.existsSync(result.path!)).toBe(true);
    expect(fs.readFileSync(result.path!)).toEqual(fakeGeminiBuffer);
  });

  it("records that the AI provider WAS invoked when generation fails", async () => {
    const alpha = new AlphaImage("flux", "test-alpha-key");
    const alphaGenerateSpy = vi
      .spyOn(alpha, "generate")
      .mockRejectedValue(new Error("Alpha image API error (402): insufficient balance"));

    const scene = dummyScene({ visual_type: "ai_image" });
    const opts = dummyOpts({ imageGen: alpha, imageProvider: "alpha" });

    const error = await resolveVisualAsset(scene, 6, 1, assetsDir, opts, archetype, dummyCallbacks)
      .then(() => null)
      .catch((err: unknown) => err);

    // Alpha WAS called: the failure is Category B/C/D/E, never Category A.
    expect(alphaGenerateSpy).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(VisualAssetError);
    const diagnostic = (error as VisualAssetError).diagnostic;
    expect(diagnostic.provider).toBe("alpha");
    expect(diagnostic.providerInvoked).toBe(true);
    expect(diagnostic.trace.map((event) => event.stage)).toContain("provider_invocation_started");
    // No asset is written, so the record must report the failure rather than a path.
    expect(fs.existsSync(path.join(assetsDir, "scene-6-ai.png"))).toBe(false);
  });

  it("rejects non-image bytes before they can be written as scene-N-ai.png", async () => {
    const alpha = new AlphaImage("flux", "test-alpha-key");
    const html = Buffer.from("<!DOCTYPE html><html><body>Bad Gateway</body></html>");
    vi.spyOn(alpha, "generate").mockResolvedValue(html);

    const scene = dummyScene({ visual_type: "ai_image" });
    const opts = dummyOpts({ imageGen: alpha, imageProvider: "alpha" });

    const error = await resolveVisualAsset(scene, 7, 1, assetsDir, opts, archetype, dummyCallbacks)
      .then(() => null)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(VisualAssetError);
    const diagnostic = (error as VisualAssetError).diagnostic;
    expect(diagnostic.providerInvoked).toBe(true);
    expect(diagnostic.bytes).toBe(html.length);
    expect(String(error)).toMatch(/HTML page|not a known image container/);
    // Nothing at all may remain in the asset directory, not even a .part file.
    expect(fs.readdirSync(assetsDir)).toEqual([]);
  });

  it("forwards the provider's own lifecycle events into the scene trace", async () => {
    let sink: ((event: { stage: string; detail?: string }) => void) | undefined;
    const provider = {
      setDiagnosticSink: (next: (event: { stage: string; detail?: string }) => void) => {
        sink = next;
      },
      generate: async () => {
        sink?.({ stage: "submit_accepted", detail: "job=img-42" });
        sink?.({ stage: "download_completed", detail: "bytes=22 format=png" });
        return png("sink-frame");
      },
    };

    const scene = dummyScene({ visual_type: "ai_image" });
    const opts = dummyOpts({ imageGen: provider as any, imageProvider: "alpha" });

    const result = await resolveVisualAsset(scene, 8, 1, assetsDir, opts, archetype, dummyCallbacks);

    expect(result.path).toBeTruthy();
    expect(result.diagnostic?.providerInvoked).toBe(true);
    const stages = result.diagnostic?.trace.map((event) => event.stage) ?? [];
    expect(stages).toContain("submit_accepted");
    expect(stages).toContain("download_completed");
    expect(
      result.diagnostic?.trace.find((event) => event.stage === "submit_accepted")?.detail,
    ).toBe("job=img-42");
  });

});

