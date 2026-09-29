import { describe, expect, it } from "vitest";
import { assertImageBuffer, detectImageFormat } from "../providers/image/image-bytes.js";
import {
  buildVisualAssetRecord,
  createVisualTrace,
  summarizeVisualAssets,
  type VisualAssetDiagnostic,
  VisualAssetError,
} from "./visual-diagnostics.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x00, 0x00, 0x00, 0x00]), // chunk size
  Buffer.from("WEBP"),
  Buffer.from("VP8 "), // first chunk fourcc
]);

describe("image container validation", () => {
  it("detects the containers Alpha and stock providers can return", () => {
    expect(detectImageFormat(PNG)).toBe("png");
    expect(detectImageFormat(JPEG)).toBe("jpeg");
    expect(detectImageFormat(WEBP)).toBe("webp");
  });

  it("returns null for payloads that are not images", () => {
    expect(detectImageFormat(Buffer.alloc(0))).toBeNull();
    expect(detectImageFormat(Buffer.from("<html>"))).toBeNull();
    expect(detectImageFormat(Buffer.from('{"error":"nope"}'))).toBeNull();
  });

  it("describes an empty payload precisely", () => {
    expect(() => assertImageBuffer(Buffer.alloc(0), "Alpha image output for job x")).toThrow(
      /Alpha image output for job x: the payload is empty \(0 bytes\)/,
    );
  });

  it("names an HTML gateway page instead of writing it as a PNG", () => {
    expect(() =>
      assertImageBuffer(Buffer.from("<!DOCTYPE html><html>Bad Gateway</html>"), "ctx"),
    ).toThrow(/is an HTML page/);
  });

  it("names a JSON error body", () => {
    expect(() => assertImageBuffer(Buffer.from('{"error":{"code":"e"}}'), "ctx")).toThrow(
      /is JSON, not an image/,
    );
  });

  it("rejects a truncated payload whose signature is incomplete", () => {
    // First two bytes of a PNG signature only.
    expect(() => assertImageBuffer(Buffer.from([0x89, 0x50]), "ctx")).toThrow(
      /not a known image container/,
    );
  });
});

describe("createVisualTrace", () => {
  it("records elapsed offsets and optional details", () => {
    const trace = createVisualTrace();
    trace.push("provider_invocation_started", "provider=alpha");
    trace.push("asset_written");

    const first = trace.events[0];
    const second = trace.events[1];
    expect(first?.stage).toBe("provider_invocation_started");
    expect(first?.detail).toBe("provider=alpha");
    expect(second?.detail).toBeUndefined();
    expect(second?.atMs).toBeGreaterThanOrEqual(first?.atMs ?? 0);
    expect(trace.elapsedMs()).toBeGreaterThanOrEqual(0);
  });
});

describe("buildVisualAssetRecord", () => {
  const diagnostic: VisualAssetDiagnostic = {
    provider: "alpha",
    providerInvoked: true,
    trace: [],
    bytes: 1234,
    format: "png",
    assetPath: "C:/assets/scene-0-ai.png",
    fileSize: 1234,
  };

  it("marks a produced asset as ok and carries the writes metadata", () => {
    const record = buildVisualAssetRecord({
      sceneIndex: 0,
      visualType: "ai_image",
      effectiveType: "ai_image",
      path: "ai",
      provider: "alpha",
      elapsedMs: 4200,
      diagnostic,
      assetPath: diagnostic.assetPath,
    });

    expect(record.outcome).toBe("ok");
    expect(record.providerInvoked).toBe(true);
    expect(record.bytes).toBe(1234);
    expect(record.fileSize).toBe(1234);
    expect(record.elapsedMs).toBe(4200);
  });

  it("records an invoked provider that produced nothing as no_asset", () => {
    const record = buildVisualAssetRecord({
      sceneIndex: 3,
      visualType: "ai_image",
      effectiveType: "ai_image",
      path: "ai",
      provider: "alpha",
      elapsedMs: 600_000,
      diagnostic: { provider: "alpha", providerInvoked: true, trace: [] },
      assetPath: null,
    });

    expect(record.outcome).toBe("no_asset");
    expect(record.providerInvoked).toBe(true);
  });

  it("reports the Stock Only remap as provider NOT invoked", () => {
    const record = buildVisualAssetRecord({
      sceneIndex: 2,
      visualType: "ai_image",
      effectiveType: "stock_image",
      path: "stock",
      provider: "stock",
      elapsedMs: 120,
      assetPath: null,
    });

    // This is the only legitimate Category A path: the AI provider is selected by
    // config, never called, and the record must say so explicitly.
    expect(record.providerInvoked).toBe(false);
    expect(record.outcome).toBe("no_asset");
    expect(summarizeVisualAssets([record])).toContain('provider "stock" was NOT invoked');
  });

  it("captures the error message and stack", () => {
    const record = buildVisualAssetRecord({
      sceneIndex: 1,
      visualType: "ai_image",
      effectiveType: "ai_image",
      path: "ai",
      provider: "alpha",
      elapsedMs: 30,
      diagnostic,
      assetPath: null,
      error: new Error("Alpha image output download failed (502) for job img-1"),
    });

    expect(record.outcome).toBe("error");
    expect(record.error).toContain("download failed (502)");
    expect(record.stack).toBeTruthy();
  });
});

describe("summarizeVisualAssets", () => {
  it("stays silent when every scene produced a visual", () => {
    const ok = buildVisualAssetRecord({
      sceneIndex: 0,
      visualType: "stock_image",
      effectiveType: "stock_image",
      path: "stock",
      provider: "stock",
      elapsedMs: 10,
      assetPath: "C:/assets/scene-0-stock.jpg",
      stockMethod: "direct",
    });

    expect(summarizeVisualAssets([ok])).toBe("");
  });

  it("ignores text cards, which legitimately have no asset", () => {
    const textCard = buildVisualAssetRecord({
      sceneIndex: 4,
      visualType: "text_card",
      effectiveType: "text_card",
      path: "none",
      provider: "none",
      elapsedMs: 1,
      assetPath: null,
    });

    expect(summarizeVisualAssets([textCard])).toBe("");
  });

  it("names every failing scene and whether its provider ran", () => {
    const invoked = buildVisualAssetRecord({
      sceneIndex: 1,
      visualType: "ai_image",
      effectiveType: "ai_image",
      path: "ai",
      provider: "alpha",
      elapsedMs: 50,
      diagnostic: { provider: "alpha", providerInvoked: true, trace: [] },
      assetPath: null,
      error: new Error("Alpha image job img-1 timed out after 900s"),
    });
    const notInvoked = buildVisualAssetRecord({
      sceneIndex: 5,
      visualType: "ai_image",
      effectiveType: "stock_image",
      path: "stock",
      provider: "stock",
      elapsedMs: 12,
      assetPath: null,
      error: new Error("No stock candidate satisfied the request"),
    });

    const summary = summarizeVisualAssets([invoked, notInvoked]);

    expect(summary).toContain("2 of 2 scenes produced no visual asset");
    expect(summary).toContain('scene 1 (ai_image): error; provider "alpha" WAS invoked');
    expect(summary).toContain("scene 5 (ai_image -> stock_image)");
    expect(summary).toContain('provider "stock" was NOT invoked');
    expect(summary).toContain("timed out after 900s");
  });
});

describe("VisualAssetError", () => {
  it("carries the diagnostics so the failure survives the catch in the visuals step", () => {
    const error = new VisualAssetError("boom", {
      provider: "alpha",
      providerInvoked: true,
      trace: [{ stage: "submit_request_started", atMs: 1 }],
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("VisualAssetError");
    expect(error.diagnostic.providerInvoked).toBe(true);
    expect(error.diagnostic.trace).toHaveLength(1);
  });
});
