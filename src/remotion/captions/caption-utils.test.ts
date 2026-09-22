import { describe, expect, it } from "vitest";
import type { WordTimestamp } from "../../schema/providers";
import { formatBidiText, getWordChunk, isRtlParagraph, isRtlText, PDI, RLI } from "./caption-utils";

const words: WordTimestamp[] = [
  { word: "Hello", start: 1.0, end: 1.5 },
  { word: "world", start: 1.6, end: 2.0 },
  { word: "this", start: 2.5, end: 2.8 },
  { word: "is", start: 2.9, end: 3.1 },
  { word: "a", start: 3.2, end: 3.3 },
  { word: "test", start: 3.4, end: 3.8 },
];

describe("getWordChunk", () => {
  it("returns the correct chunk for mid-stream time", () => {
    const { chunk, chunkStart } = getWordChunk(words, 1.2, 3);
    expect(chunkStart).toBe(0);
    expect(chunk.length).toBe(3);
    expect(chunk[0]?.word).toBe("Hello");
  });

  it("advances to the next chunk when previous chunk is exhausted", () => {
    const { chunk, chunkStart } = getWordChunk(words, 3.5, 3);
    expect(chunkStart).toBe(3);
    expect(chunk[0]?.word).toBe("is");
  });

  it("handles the partial last chunk", () => {
    // 6 words with chunkSize 4: chunk 0 = [0..3], chunk 1 = [4..5]
    const { chunk, chunkStart } = getWordChunk(words, 3.5, 4);
    expect(chunkStart).toBe(4);
    expect(chunk.length).toBe(2);
    expect(chunk[0]?.word).toBe("a");
    expect(chunk[1]?.word).toBe("test");
  });

  it("returns the first chunk for time before any speech", () => {
    const { chunkStart } = getWordChunk(words, 0.1, 3);
    expect(chunkStart).toBe(0);
  });

  it("uses default lingerS of 0.3 when not specified", () => {
    // Last word ends at 3.8, so chunk should still be active at 3.8 + 0.29
    const { chunkStart } = getWordChunk(words, 4.09, 3);
    expect(chunkStart).toBe(3); // still on last chunk
  });

  it("respects custom lingerS parameter", () => {
    // With lingerS=0.05, chunk advances much sooner
    // Last word of chunk 0 (chunkSize=3) ends at 2.8
    // At time 2.86 (> 2.8 + 0.05), should advance to chunk 1
    const { chunkStart } = getWordChunk(words, 2.86, 3, 0.05);
    expect(chunkStart).toBe(3);
  });

  it("handles lingerS=0 (instant advance)", () => {
    // At exactly the last word's end time + epsilon, should advance
    const { chunkStart } = getWordChunk(words, 2.81, 3, 0);
    expect(chunkStart).toBe(3);
  });

  it("handles very large lingerS but advances when next chunk has started", () => {
    // lingerS=100 but words are continuous, so linger is cut short
    // At time 50, all words are past. Last chunk stays.
    const { chunkStart } = getWordChunk(words, 50, 3, 100);
    expect(chunkStart).toBe(3); // last chunk (words are all spoken, no next chunk to advance to)
  });

  it("lingers on last chunk indefinitely when no next chunk exists", () => {
    // The very last chunk has no "next chunk" to check, so linger applies fully
    const { chunkStart } = getWordChunk(words, 4.0, 3, 100);
    expect(chunkStart).toBe(3); // stays on last chunk
  });

  it("handles empty words array", () => {
    const { chunk, chunkStart } = getWordChunk([], 1.0, 3);
    expect(chunkStart).toBe(0);
    expect(chunk).toEqual([]);
  });

  it("advances to next chunk when next chunk's first word has started, even during linger", () => {
    // Regression: linger window hid the first word of the next chunk.
    // Words are continuous (no gap between chunks), lingerS=0.5.
    // At time 1.05 (chunk 1's "know" has started at 1.0), chunk 0 should
    // NOT linger. It should advance so "know" can be shown as "active".
    const continuous: WordTimestamp[] = [
      { word: "Did", start: 0.1, end: 0.3 },
      { word: "you", start: 0.3, end: 0.5 },
      { word: "know", start: 0.5, end: 0.8 },
      { word: "we", start: 0.8, end: 1.0 },
      { word: "know", start: 1.0, end: 1.3 },
      { word: "more", start: 1.3, end: 1.6 },
      { word: "about", start: 1.6, end: 1.9 },
      { word: "Mars", start: 1.9, end: 2.2 },
    ];
    // At time 1.05: chunk 0 last word "we" ended at 1.0, linger would last to 1.5.
    // But chunk 1 first word "know" started at 1.0. Should advance.
    const { chunkStart, chunk } = getWordChunk(continuous, 1.05, 4, 0.5);
    expect(chunkStart).toBe(4);
    expect(chunk[0]?.word).toBe("know");
  });

  it("still lingers when there is a gap before next chunk starts", () => {
    // When there IS a genuine gap between chunks, linger should work.
    const gapped: WordTimestamp[] = [
      { word: "Hello", start: 0.0, end: 0.3 },
      { word: "world", start: 0.3, end: 0.6 },
      // 0.9s gap here
      { word: "Next", start: 1.5, end: 1.8 },
      { word: "chunk", start: 1.8, end: 2.0 },
    ];
    // At time 0.8: chunk 0 last word "world" ended at 0.6, linger to 0.9.
    // Next chunk starts at 1.5 (not started yet). Should stay on chunk 0.
    const { chunkStart } = getWordChunk(gapped, 0.8, 2, 0.3);
    expect(chunkStart).toBe(0);
  });

  it("returns empty chunk after voiceover ends plus linger", () => {
    // After the last word ends + lingerS, captions should fade out
    // instead of showing stale text during a musical outro.
    const { chunk, chunkStart } = getWordChunk(words, 5.0, 3, 0.3);
    expect(chunk).toEqual([]);
    expect(chunkStart).toBe(words.length);
  });
});

describe("isRtlText", () => {
  it("detects Persian text as RTL", () => {
    expect(isRtlText("\u0645\u06cc\u0631\u0633\u062f")).toBe(true);
    expect(isRtlText("\u0646\u0647\u0646\u06af \u0622\u0628\u06cc")).toBe(true);
  });

  it("skips weak characters when resolving a single token", () => {
    expect(isRtlText("\u06f7 \u0645\u062a\u0631")).toBe(true);
    expect(isRtlText("200 tons of blue whale")).toBe(false);
  });

  it("treats Persian text containing trailing Latin as RTL", () => {
    expect(isRtlText("\u0645\u06cc\u0631\u0633\u062f NASA")).toBe(true);
  });

  it("leaves English and weak-only text LTR", () => {
    expect(isRtlText("Hello beautiful world")).toBe(false);
    expect(isRtlText("")).toBe(false);
    expect(isRtlText("... 123")).toBe(false);
  });
});

// Persian samples are written as \u escapes so this file stays ASCII-safe and the
// bidi order stays explicit. The romanized meaning is noted next to each sample.
const FA_ARRIVES = "\u0645\u06cc\u0631\u0633\u062f"; // "miresad" - it arrives
const FA_BLUE_WHALE = "\u0646\u0647\u0646\u06af \u0622\u0628\u06cc"; // "nahang-e abi" - blue whale
const FA_SALAM = "\u0633\u0644\u0627\u0645"; // "salam" - hello
const FA_HELLO_WORLD = "\u0633\u0644\u0627\u0645 \u062f\u0646\u06cc\u0627!"; // "salam donya!" - hello world!
// "u goft: ..." - he said: "this is important"; really?  (colon, guillemets, semicolon, question mark)
const FA_QUOTED =
  "\u0627\u0648 \u06af\u0641\u062a: \u00ab\u0627\u06cc\u0646 \u0645\u0647\u0645 \u0627\u0633\u062a\u00bb\u061b \u0648\u0627\u0642\u0639\u0627\u064b\u061f";
// Real script_line from output/*/score.json: "less than 30% of jobs want a degree. skills are enough."
const FA_PERCENT =
  "\u06a9\u0645\u062a\u0631 \u0627\u0632 \u06f3\u06f0\u066a \u0622\u06af\u0647\u06cc\u0647\u0627 \u0645\u062f\u0631\u06a9 \u0645\u06cc\u062e\u0648\u0627\u0646. \u0645\u0647\u0627\u0631\u062a \u06a9\u0627\u0641\u06cc\u0647.";
// U+06F3 U+06F0 = Persian digits, U+066A = Arabic percent sign
const FA_LATIN_FIRST = "NASA \u0628\u0647 \u0645\u0627\u0647 \u0631\u0633\u06cc\u062f"; // "NASA be mah resid"
const FA_LATIN_MIXED = "\u0627\u06cc\u0646 \u06cc\u06a9 \u062e\u0628\u0631 \u0627\u0632 NASA \u0627\u0633\u062a";
const FA_PARENS = "\u0627\u06cc\u0646 \u062a\u0633\u062a (NASA) \u0645\u0647\u0645 \u0627\u0633\u062a.";
const FA_NUMBERS = "\u062f\u0631 \u0633\u0627\u0644 \u06f2\u06f0\u06f2\u06f4 \u0627\u0648 12 \u0645\u0627\u0647 \u0633\u0641\u0631 \u06a9\u0631\u062f"; // Persian 2024 + Latin 12
const FA_PERSIAN_DIGITS = "\u06f2\u06f0\u06f0 \u0645\u062a\u0631"; // "200 metr"

describe("isRtlParagraph", () => {
  it("detects pure Persian lines", () => {
    expect(isRtlParagraph(FA_ARRIVES)).toBe(true);
    expect(isRtlParagraph(FA_BLUE_WHALE)).toBe(true);
    expect(isRtlParagraph(FA_SALAM)).toBe(true);
  });

  it("detects Persian lines containing sentence punctuation", () => {
    expect(isRtlParagraph(FA_HELLO_WORLD)).toBe(true);
    expect(isRtlParagraph(FA_QUOTED)).toBe(true);
    expect(isRtlParagraph(FA_PERCENT)).toBe(true);
    expect(isRtlParagraph(FA_PARENS)).toBe(true);
  });

  it("keeps a Persian sentence RTL when it begins with a Latin word", () => {
    // The first-strong rule resolves this LTR because "NASA" leads, but a
    // rendered line must stay RTL - which is why isRtlParagraph exists.
    expect(isRtlText(FA_LATIN_FIRST)).toBe(false);
    expect(isRtlParagraph(FA_LATIN_FIRST)).toBe(true);

    // Same for a caption chunk whose first word is Latin (CaptionWrapper path).
    const chunk = ["NASA", "\u0628\u0647", "\u0645\u0627\u0647", "\u0631\u0633\u06cc\u062f"];
    expect(isRtlText(chunk.join(" "))).toBe(false);
    expect(isRtlParagraph(chunk.join(" "))).toBe(true);
  });

  it("detects mixed Persian + English lines", () => {
    expect(isRtlParagraph(FA_LATIN_MIXED)).toBe(true);
    expect(isRtlParagraph(FA_PARENS)).toBe(true);
  });

  it("detects Persian lines with numbers", () => {
    expect(isRtlParagraph(FA_NUMBERS)).toBe(true);
    expect(isRtlParagraph(FA_PERSIAN_DIGITS)).toBe(true);
  });

  it("leaves English-only and weak-only lines LTR", () => {
    expect(isRtlParagraph("Hello beautiful world")).toBe(false);
    expect(isRtlParagraph("")).toBe(false);
    expect(isRtlParagraph("... 123")).toBe(false);
  });

  it("leaves a mostly-English line with a trailing Persian word LTR", () => {
    expect(isRtlParagraph(`Hello beautiful world ${FA_SALAM}`)).toBe(false);
  });
});

describe("formatBidiText", () => {
  it("wraps pure Persian in a single RTL isolate", () => {
    expect(formatBidiText(FA_ARRIVES)).toBe(`${RLI}${FA_ARRIVES}${PDI}`);
    expect(formatBidiText(FA_BLUE_WHALE)).toBe(`${RLI}${FA_BLUE_WHALE}${PDI}`);
  });

  it("wraps Persian with punctuation and keeps the source text intact", () => {
    const wrapped = formatBidiText(FA_QUOTED);
    expect(wrapped).toBe(`${RLI}${FA_QUOTED}${PDI}`);
    // Everything between the isolate pair is the original text: nothing was
    // reordered and no marks were inserted inside the sentence.
    expect([...wrapped].slice(1, -1).join("")).toBe(FA_QUOTED);
  });

  it("wraps a Persian line that starts with a Latin word", () => {
    expect(formatBidiText(FA_LATIN_FIRST)).toBe(`${RLI}${FA_LATIN_FIRST}${PDI}`);
  });

  it("wraps mixed Persian + English + numbers", () => {
    const lines = [FA_LATIN_MIXED, FA_PARENS, FA_NUMBERS, FA_PERSIAN_DIGITS, FA_PERCENT];
    for (const line of lines) {
      expect(formatBidiText(line)).toBe(`${RLI}${line}${PDI}`);
    }
  });

  it("adds exactly one isolate pair and no other bidi controls", () => {
    const wrapped = formatBidiText(FA_LATIN_MIXED);
    expect([...wrapped].filter((c) => c === RLI)).toHaveLength(1);
    expect([...wrapped].filter((c) => c === PDI)).toHaveLength(1);
    // No RLM/LRM marks, no embeddings/overrides, no LRI/FSI: isolates only.
    expect(wrapped).not.toMatch(/[\u200e\u200f\u202a-\u202e\u2066\u2068]/);
  });

  it("returns English-only and weak-only text untouched", () => {
    expect(formatBidiText("Hello beautiful world")).toBe("Hello beautiful world");
    expect(formatBidiText("")).toBe("");
    expect(formatBidiText("... 123")).toBe("... 123");
  });
});
