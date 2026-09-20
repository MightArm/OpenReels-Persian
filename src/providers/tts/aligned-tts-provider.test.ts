import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TTSProvider, TTSResult, WordTimestamp } from "../../schema/providers.js";
import { AlignedTTSProvider, type TTSAligner } from "./aligned-tts-provider.js";

// Mock ffmpeg for WAV→MP3 transcoding
vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: object, cb: Function) => {
    // Simulate successful ffmpeg by writing a fake MP3 file
    const outputPath = _args[_args.length - 1]; // mp3 output path (always last arg)
    if (outputPath) {
      const fs = require("node:fs");
      fs.writeFileSync(outputPath, Buffer.from("fake-mp3-data"));
    }
    cb(null, "", "");
  }),
}));

function createMockProvider(result: TTSResult): TTSProvider {
  return { generate: vi.fn().mockResolvedValue(result) };
}

function createMockAligner(
  words: WordTimestamp[],
): TTSAligner & { align: ReturnType<typeof vi.fn> } {
  return { align: vi.fn().mockResolvedValue(words) };
}

// WAV header for detection
const WAV_AUDIO = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(100)]);
const MP3_AUDIO = Buffer.concat([Buffer.from([0xff, 0xfb]), Buffer.alloc(100)]);

describe("AlignedTTSProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes through when inner provider returns words", async () => {
    const words = [{ word: "Hello", start: 0, end: 0.3 }];
    const inner = createMockProvider({ audio: MP3_AUDIO, words });
    const aligner = createMockAligner([]);
    const provider = new AlignedTTSProvider(inner, aligner);

    const result = await provider.generate("Hello");

    expect(result.words).toEqual(words);
    expect(aligner.align).not.toHaveBeenCalled();
  });

  it("calls aligner when inner returns empty words", async () => {
    const alignedWords = [{ word: "Hello", start: 0, end: 0.3 }];
    const inner = createMockProvider({ audio: WAV_AUDIO, words: [] });
    const aligner = createMockAligner(alignedWords);
    const provider = new AlignedTTSProvider(inner, aligner);

    const result = await provider.generate("Hello");

    expect(aligner.align).toHaveBeenCalledWith(WAV_AUDIO, "Hello", undefined);
    expect(result.words).toEqual(alignedWords);
  });

  it("forwards LLM subtitle segments to the aligner", async () => {
    const alignedWords = [{ word: "Hello", start: 0, end: 0.3 }];
    const inner = createMockProvider({ audio: WAV_AUDIO, words: [] });
    const aligner = createMockAligner(alignedWords);
    const provider = new AlignedTTSProvider(inner, aligner);

    const result = await provider.generate("Hello", { subtitleSegments: ["Hello"] });

    expect(aligner.align).toHaveBeenCalledWith(WAV_AUDIO, "Hello", ["Hello"]);
    expect(result.words).toEqual(alignedWords);
  });

  it("hard-fails when the aligner produces no words for a non-empty script", async () => {
    const inner = createMockProvider({ audio: WAV_AUDIO, words: [] });
    const aligner = createMockAligner([]);
    const provider = new AlignedTTSProvider(inner, aligner);

    await expect(provider.generate("Hello")).rejects.toThrow("produced 0 words");
  });

  it("transcodes WAV audio to MP3", async () => {
    const words = [{ word: "Hello", start: 0, end: 0.3 }];
    const inner = createMockProvider({ audio: WAV_AUDIO, words });
    const aligner = createMockAligner([]);
    const provider = new AlignedTTSProvider(inner, aligner);

    const result = await provider.generate("Hello");

    // Audio should be transcoded (not the original WAV)
    expect(result.audio.toString("ascii", 0, 4)).not.toBe("RIFF");
  });

  it("does not transcode MP3 audio", async () => {
    const words = [{ word: "Hello", start: 0, end: 0.3 }];
    const inner = createMockProvider({ audio: MP3_AUDIO, words });
    const aligner = createMockAligner([]);
    const provider = new AlignedTTSProvider(inner, aligner);

    const result = await provider.generate("Hello");

    // Audio should pass through unchanged
    expect(result.audio).toBe(MP3_AUDIO);
  });

  it("propagates inner provider errors", async () => {
    const inner: TTSProvider = {
      generate: vi.fn().mockRejectedValue(new Error("API timeout")),
    };
    const aligner = createMockAligner([]);
    const provider = new AlignedTTSProvider(inner, aligner);

    await expect(provider.generate("Hello")).rejects.toThrow("API timeout");
  });

  it("propagates aligner errors", async () => {
    const inner = createMockProvider({ audio: WAV_AUDIO, words: [] });
    const aligner: TTSAligner = {
      align: vi.fn().mockRejectedValue(new Error("Whisper alignment failed")),
    };
    const provider = new AlignedTTSProvider(inner, aligner);

    await expect(provider.generate("Hello")).rejects.toThrow("Whisper alignment failed");
  });

  it("skips alignment for empty text", async () => {
    const inner = createMockProvider({ audio: MP3_AUDIO, words: [] });
    const aligner = createMockAligner([]);
    const provider = new AlignedTTSProvider(inner, aligner);

    const result = await provider.generate("   ");

    expect(aligner.align).not.toHaveBeenCalled();
    expect(result.words).toEqual([]);
  });
});
