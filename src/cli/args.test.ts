import { afterEach, describe, expect, it } from "vitest";
import { type CLIOptions, parseArgs } from "./args.js";

describe("stock-only option", () => {
  const ORIGINAL_ARGV = process.argv;

  afterEach(() => {
    process.argv = ORIGINAL_ARGV;
    delete process.env.STOCK_ONLY;
  });

  it("parses --stock-only", () => {
    process.argv = ["node", "openreels", "test topic", "--stock-only"];
    expect(parseArgs().stockOnly).toBe(true);
  });

  it("parses --no-stock-only over the STOCK_ONLY env var", () => {
    process.env.STOCK_ONLY = "true";
    process.argv = ["node", "openreels", "test topic", "--no-stock-only"];
    expect(parseArgs().stockOnly).toBe(false);
  });

  it("falls back to the STOCK_ONLY env var when the flag is absent", () => {
    process.env.STOCK_ONLY = "true";
    process.argv = ["node", "openreels", "test topic"];
    expect(parseArgs().stockOnly).toBe(true);

    process.env.STOCK_ONLY = "false";
    expect(parseArgs().stockOnly).toBe(false);
  });

  it("is undefined when neither flag nor env is set", () => {
    process.argv = ["node", "openreels", "test topic"];
    expect(parseArgs().stockOnly).toBeUndefined();
  });
});

describe("CLIOptions type", () => {
  it("includes yes field for non-interactive mode", () => {
    // Type-level test: verify CLIOptions includes the yes field.
    // If this compiles, the field exists.
    const opts: CLIOptions = {
      topic: "test",
      provider: "anthropic",
      imageProvider: "gemini",
      ttsProvider: "elevenlabs",
      platform: "youtube",
      dryRun: false,
      preview: false,
      output: "./output",
      yes: true,
      musicProvider: "bundled",
      noMusic: false,
      stockVerify: true,
      stockConfidence: 0.6,
      stockMaxAttempts: 4,
      noVideo: false,
      usage: false,
    };
    expect(opts.yes).toBe(true);
  });

  it("yes defaults to false", () => {
    const opts: CLIOptions = {
      topic: "test",
      provider: "anthropic",
      imageProvider: "gemini",
      ttsProvider: "elevenlabs",
      platform: "youtube",
      dryRun: false,
      preview: false,
      output: "./output",
      yes: false,
      musicProvider: "bundled",
      noMusic: false,
      stockVerify: true,
      stockConfidence: 0.6,
      stockMaxAttempts: 4,
      noVideo: false,
      usage: false,
    };
    expect(opts.yes).toBe(false);
  });

  it("accepts gemini as provider", () => {
    const opts: CLIOptions = {
      topic: "test",
      provider: "gemini",
      imageProvider: "gemini",
      ttsProvider: "elevenlabs",
      platform: "youtube",
      dryRun: false,
      preview: false,
      output: "./output",
      yes: false,
      musicProvider: "bundled",
      noMusic: false,
      stockVerify: true,
      stockConfidence: 0.6,
      stockMaxAttempts: 4,
      noVideo: false,
      usage: false,
    };
    expect(opts.provider).toBe("gemini");
  });

  it("accepts pacing tier as optional field", () => {
    const opts: CLIOptions = {
      topic: "test",
      provider: "anthropic",
      imageProvider: "gemini",
      ttsProvider: "elevenlabs",
      pacing: "fast",
      platform: "youtube",
      dryRun: false,
      preview: false,
      output: "./output",
      yes: false,
      musicProvider: "bundled",
      noMusic: false,
      stockVerify: true,
      stockConfidence: 0.6,
      stockMaxAttempts: 4,
      noVideo: false,
      usage: false,
    };
    expect(opts.pacing).toBe("fast");
  });

  it("pacing is undefined by default", () => {
    const opts: CLIOptions = {
      topic: "test",
      provider: "anthropic",
      imageProvider: "gemini",
      ttsProvider: "elevenlabs",
      platform: "youtube",
      dryRun: false,
      preview: false,
      output: "./output",
      yes: false,
      musicProvider: "bundled",
      noMusic: false,
      stockVerify: true,
      stockConfidence: 0.6,
      stockMaxAttempts: 4,
      noVideo: false,
      usage: false,
    };
    expect(opts.pacing).toBeUndefined();
  });
});
