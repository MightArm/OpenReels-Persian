import type { WordTimestamp } from "../../schema/providers";

export type WordState = "unspoken" | "active" | "spoken";

export interface WordRenderState {
  word: WordTimestamp;
  state: WordState;
  springProgress: number;
  emphasis: boolean;
  globalIndex: number;
}

/**
 * Get a sequential fixed-size chunk of words based on current time.
 * lingerS controls how long the chunk stays visible after its last word ends,
 * BUT the linger is cut short if the next chunk's first word has already started.
 * This prevents words from being hidden during the linger window and appearing
 * only in "spoken" state (never showing as "active").
 */
export function getWordChunk(
  words: WordTimestamp[],
  currentTime: number,
  chunkSize: number,
  lingerS: number = 0.3,
): { chunk: WordTimestamp[]; chunkStart: number } {
  let chunkStart = 0;
  for (let i = 0; i < words.length; i += chunkSize) {
    const chunkEnd = Math.min(i + chunkSize, words.length);
    const lastWord = words[chunkEnd - 1];
    if (!lastWord) break;

    // Check if we should stay on this chunk:
    // 1. Current time is within the chunk's words, OR
    // 2. Current time is in the linger window AND the next chunk hasn't started speaking
    const withinWords = currentTime <= lastWord.end;
    const nextChunkFirstWord = words[chunkEnd];
    const inLingerWindow = currentTime <= lastWord.end + lingerS;
    const nextChunkStarted = nextChunkFirstWord && currentTime >= nextChunkFirstWord.start;

    if (withinWords || (inLingerWindow && !nextChunkStarted)) {
      chunkStart = i;
      break;
    }
    chunkStart = i;
  }

  // After voiceover ends + linger, return empty chunk so captions fade out
  // instead of lingering stale text during a musical outro.
  const lastWord = words[words.length - 1];
  if (lastWord && currentTime > lastWord.end + lingerS) {
    return { chunk: [], chunkStart: words.length };
  }

  return { chunk: words.slice(chunkStart, chunkStart + chunkSize), chunkStart };
}

/** Determine the display state of a word at a given time. */
export function getWordState(word: WordTimestamp, currentTime: number): WordState {
  if (currentTime < word.start) return "unspoken";
  if (currentTime < word.end) return "active";
  return "spoken";
}

/**
 * Compute WordRenderState[] for a chunk of words. Pure function, no React hooks.
 *
 * springFn receives a globalIndex and returns the spring progress (0-1) for that
 * word. The caller (CaptionWrapper) maps globalIndex -> frame-based spring
 * computation internally, keeping it seek-safe.
 */
export function computeWordStates(
  chunk: WordTimestamp[],
  chunkStart: number,
  currentTime: number,
  springFn: (globalIndex: number) => number,
  emphasisIndices?: Set<number>,
): WordRenderState[] {
  return chunk.map((word, i) => {
    const globalIndex = chunkStart + i;
    const state = getWordState(word, currentTime);
    const springProgress = state === "unspoken" ? 0 : springFn(globalIndex);
    return {
      word,
      state,
      springProgress,
      emphasis: emphasisIndices?.has(globalIndex) ?? false,
      globalIndex,
    };
  });
}

/** Persian/Arabic and Hebrew script ranges (Unicode strong RTL characters). */
const RTL_STRONG =
  /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u0800-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
/** Latin script ranges (Unicode strong LTR characters). */
const LTR_STRONG = /[A-Za-z\u00C0-\u024F\u1E00-\u1EFF]/;

/**
 * True when the text's first strong directional character is RTL script.
 * Mirrors the Unicode bidi paragraph rule (P2/P3): ASCII digits, spaces and
 * punctuation are skipped, so a Farsi chunk containing a Latin brand name still
 * resolves RTL. Pure English text resolves LTR, so its rendering is unchanged.
 */
export function isRtlText(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (RTL_STRONG.test(ch)) return true;
    if (LTR_STRONG.test(ch)) return false;
  }
  return false;
}

/**
 * UAX #9 directional isolate controls. These are used instead of bare RLM/LRM
 * marks: a single well-placed isolate pair contains the whole bidi effect of a
 * run, instead of sprinkling invisible marks between characters.
 */
export const RLI = "\u2067"; // right-to-left isolate: content and edge punctuation resolve RTL
export const PDI = "\u2069"; // pop directional isolate (closes RLI)

/**
 * Paragraph-level direction for a rendered line (a caption chunk or a text-card
 * line).
 *
 * isRtlText applies the Unicode P2/P3 first-strong rule, which is correct for a
 * single token but classifies a Farsi sentence that *begins* with a Latin word
 * ("NASA ...") as LTR. A rendered line must stay RTL in that case, so direction
 * is decided by the majority of strong directional characters instead. Ties and
 * strong-character-free text resolve LTR, so English and punctuation-only lines
 * keep rendering exactly as before.
 */
export function isRtlParagraph(text: string): boolean {
  let rtl = 0;
  let ltr = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (RTL_STRONG.test(ch)) rtl++;
    else if (LTR_STRONG.test(ch)) ltr++;
  }
  return rtl > ltr;
}

/**
 * Format a line of text for rendering. RTL lines are wrapped in a single
 * right-to-left isolate, which pins the base direction (so a leading Latin word
 * cannot flip the line), keeps trailing punctuation such as "." / "!" / "?" and
 * the Arabic question mark on the visual left, and lets embedded Latin words, digits, and mirrored
 * parentheses resolve in place per the Unicode bidirectional algorithm.
 * LTR text is returned untouched.
 */
export function formatBidiText(text: string): string {
  if (!isRtlParagraph(text)) return text;
  return `${RLI}${text}${PDI}`;
}

