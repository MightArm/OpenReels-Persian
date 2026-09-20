import { beforeEach, describe, expect, it, vi } from "vitest";
import wavefile from "wavefile";
import type { WordTimestamp } from "../../schema/providers.js";
import { SegmentAligner } from "./segment-aligner.js";

// Mock ffprobe so the duration-probe path is deterministic (no ffmpeg needed).
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

/** Build a real PCM WAV buffer whose duration comes from its header. */
function makeWav(durationSeconds: number, sampleRate = 16000): Buffer {
  const samples = new Array(Math.round(durationSeconds * sampleRate)).fill(0);
  const wav = new wavefile.WaveFile();
  wav.fromScratch(1, sampleRate, "16", samples);
  return Buffer.from(wav.toBuffer());
}

/** Non-WAV buffer — forces the ffprobe path. */
const MP3_AUDIO = Buffer.concat([Buffer.from([0xff, 0xfb]), Buffer.alloc(64)]);

/** Index into `words`, failing the test loudly if the word is missing. */
function at(words: WordTimestamp[], i: number): WordTimestamp {
  const w = words[i];
  if (!w) throw new Error(`no word at index ${i}`);
  return w;
}

/** Find a word by text, failing the test loudly if it is missing. */
function findWord(words: WordTimestamp[], word: string): WordTimestamp {
  const w = words.find((x) => x.word === word);
  if (!w) throw new Error(`word not found: ${word}`);
  return w;
}

const EN_TEXT = "Six warnings. One ship. And nobody stopped it.";
const EN_SEGMENTS = ["Six warnings.", "One ship.", "And nobody stopped it."];

const FA_TEXT = "شش هشدار وجود داشت. یک کشتی. و هیچکس آن را متوقف نکرد.";
const FA_SEGMENTS = ["شش هشدار وجود داشت.", "یک کشتی.", "و هیچکس آن را متوقف نکرد."];

describe("SegmentAligner", () => {
  let aligner: SegmentAligner;

  beforeEach(() => {
    vi.clearAllMocks();
    aligner = new SegmentAligner();
    // Default: ffprobe reports 3.5s.
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: object,
        cb: (err: Error | null, out: string) => void,
      ) => cb(null, "3.5\n"),
    );
  });

  it("produces one timestamp per word, in script order", async () => {
    const words = await aligner.align(makeWav(6), EN_TEXT, EN_SEGMENTS);

    expect(words.map((w) => w.word)).toEqual(EN_TEXT.split(" "));
    expect(words).toHaveLength(8);
  });

  it("starts at 0 and ends exactly at the measured audio duration", async () => {
    const words = await aligner.align(makeWav(6), EN_TEXT, EN_SEGMENTS);

    expect(at(words, 0).start).toBe(0);
    expect(at(words, words.length - 1).end).toBeCloseTo(6, 5);
  });

  it("keeps timestamps monotonically increasing and contiguous", async () => {
    const words = await aligner.align(makeWav(6), EN_TEXT, EN_SEGMENTS);

    for (let i = 0; i < words.length; i++) {
      expect(at(words, i).end).toBeGreaterThanOrEqual(at(words, i).start);
      if (i > 0) expect(at(words, i).start).toBeGreaterThanOrEqual(at(words, i - 1).end);
    }
  });

  it("weights timing by text length (longer segments get more time)", async () => {
    const words = await aligner.align(makeWav(6), EN_TEXT, EN_SEGMENTS);
    const durationOf = (from: number, to: number) => at(words, to).end - at(words, from).start;

    const firstSegment = durationOf(0, 1); // "Six warnings."
    const lastSegment = durationOf(4, 7); // "And nobody stopped it."

    expect(lastSegment).toBeGreaterThan(firstSegment);
  });

  it("places LLM segment boundaries at the start of the chunk's first word", async () => {
    const words = await aligner.align(makeWav(6), EN_TEXT, EN_SEGMENTS);

    // Word index 2 opens the second chunk, word index 4 opens the third.
    expect(at(words, 2).word).toBe("One");
    expect(at(words, 4).word).toBe("And");
    // A pause beat separates chunks: the gap from the previous word's end.
    expect(at(words, 2).start).toBeGreaterThan(at(words, 1).end);
    expect(at(words, 4).start).toBeGreaterThan(at(words, 3).end);
  });

  it("uses LLM segment boundaries when they reconstruct the script", async () => {
    const segmented = await aligner.align(makeWav(5), "Alpha beta gamma delta epsilon.", [
      "Alpha beta gamma",
      "delta epsilon.",
    ]);
    const unsegmented = await aligner.align(makeWav(5), "Alpha beta gamma delta epsilon.");

    const startOf = (words: WordTimestamp[], word: string) => findWord(words, word).start;
    const endOf = (words: WordTimestamp[], word: string) => findWord(words, word).end;

    // A mid-sentence chunk boundary inserts a real pause between the chunks...
    expect(startOf(segmented, "delta")).toBeGreaterThan(endOf(segmented, "gamma"));
    // ...while sentence-only fallback chunking keeps that sentence contiguous.
    expect(startOf(unsegmented, "delta")).toBeCloseTo(endOf(unsegmented, "gamma"), 5);
    // Boundary placement therefore changes the timeline.
    expect(startOf(segmented, "delta")).toBeGreaterThan(startOf(unsegmented, "delta"));
  });

  it("falls back to deterministic sentence chunking when segments are absent", async () => {
    const withSegments = await aligner.align(makeWav(6), EN_TEXT, EN_SEGMENTS);
    const withFallback = await aligner.align(makeWav(6), EN_TEXT);

    // Same script, same boundaries here: sentence ends are the natural chunks.
    expect(withFallback.map((w) => w.word)).toEqual(withSegments.map((w) => w.word));
    expect(at(withFallback, withFallback.length - 1).end).toBeCloseTo(6, 5);
  });

  it("ignores segments that do not match the script (LLM paraphrase)", async () => {
    const mismatched = await aligner.align(makeWav(6), EN_TEXT, [
      "Six warnings.",
      "And nobody stopped it.",
    ]);
    const fallback = await aligner.align(makeWav(6), EN_TEXT);

    expect(mismatched).toEqual(fallback);
  });

  it("handles Persian scripts with the same language-agnostic logic", async () => {
    const words = await aligner.align(makeWav(6), FA_TEXT, FA_SEGMENTS);

    expect(words.map((w) => w.word)).toEqual(FA_TEXT.split(" "));
    expect(at(words, 0).start).toBe(0);
    expect(at(words, words.length - 1).end).toBeCloseTo(6, 5);
    // Chunk boundaries still create pauses before "یک" and "و".
    expect(findWord(words, "یک").start).toBeGreaterThan(findWord(words, "داشت.").end);
    expect(findWord(words, "و").start).toBeGreaterThan(findWord(words, "کشتی.").end);
  });

  it("handles Persian scripts without LLM segments", async () => {
    const words = await aligner.align(makeWav(4), FA_TEXT);

    expect(words).toHaveLength(12);
    expect(at(words, words.length - 1).end).toBeCloseTo(4, 5);
  });

  it("probes non-WAV audio via ffprobe", async () => {
    const words = await aligner.align(MP3_AUDIO, "Hello world from ffprobe.");

    expect(execFileMock).toHaveBeenCalled();
    expect(at(words, words.length - 1).end).toBeCloseTo(3.5, 5);
  });

  it("estimates a duration when the audio cannot be measured", async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: (err: Error) => void) =>
        cb(new Error("ffprobe not found")),
    );

    // 4 words at the 2.5 words/second fallback rate = 1.6s.
    const words = await aligner.align(MP3_AUDIO, "One two three four");

    expect(at(words, words.length - 1).end).toBeCloseTo(1.6, 5);
  });

  it("returns an empty array for empty or whitespace-only text", async () => {
    expect(await aligner.align(makeWav(6), "")).toEqual([]);
    expect(await aligner.align(makeWav(6), "   ")).toEqual([]);
  });
});
