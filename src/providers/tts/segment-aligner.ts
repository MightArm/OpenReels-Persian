import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import wavefile from "wavefile";
import type { WordTimestamp } from "../../schema/providers.js";

/**
 * Deterministic word timings from LLM-authored subtitle segments + the measured
 * audio duration. Replaces Whisper forced alignment for TTS providers that
 * return audio without word timestamps (currently Alpha TTS) — no
 * speech-recognition or alignment model is involved:
 *
 *   script + LLM subtitle segments ──► tokenize (whitespace, language-agnostic)
 *                                                 │
 *   audio buffer ──► measure duration (WAV header → ffprobe → word-rate estimate)
 *                                                 │
 *   proportional distribution (character weights, pause beats at chunk and
 *   sentence boundaries)
 *                                                 │
 *                                          WordTimestamp[]
 *
 * The LLM decides WHERE subtitle chunks break (punctuation, sentence
 * boundaries) — never WHEN. Timestamps are derived deterministically from the
 * measured audio duration, so English and Persian scripts are handled
 * identically.
 */

/**
 * Fallback speaking rate (words/second) used only when the audio duration
 * cannot be measured from the buffer. ~150 words/minute.
 */
const FALLBACK_WORDS_PER_SECOND = 2.5;

/** Max characters per chunk in deterministic fallback chunking. */
const FALLBACK_MAX_CHUNK_CHARS = 42;

/** Minimum tokens a fallback chunk keeps before a sentence break is honored. */
const FALLBACK_MIN_SENTENCE_TOKENS = 2;

/** Pause beat (in character-weight units) inserted at chunk boundaries. */
const PAUSE_BASE_WEIGHT = 1;
/** Bigger beat when the chunk boundary is also a sentence end. */
const PAUSE_SENTENCE_WEIGHT = 2;

/** Tokens ending in sentence-final punctuation (Latin, Persian/Arabic, Indic). */
const SENTENCE_END = /[.!?…۔؟।]$/;

export class SegmentAligner {
  /**
   * Derive word-level timestamps for `text` from the measured duration of
   * `audio`. When `segments` (LLM-authored subtitle chunks) reconstruct the
   * script exactly, chunk boundaries come from them; otherwise deterministic
   * sentence-boundary chunking is used. Distribution is proportional to
   * character weight, with pause beats at chunk boundaries.
   *
   *   text + segments ──► tokens ──► proportional distribution ──► WordTimestamp[]
   *                          ▲                           ▲
   *                          │                           │
   *                     LLM chunks          measured audio duration
   */
  async align(audio: Buffer, text: string, segments?: string[]): Promise<WordTimestamp[]> {
    const tokens = tokenize(text);
    if (tokens.length === 0) return [];

    const duration = await this.measureDuration(audio, tokens.length);
    const groups = segmentGroupSizes(segments, text, tokens.length) ?? fallbackGroupSizes(tokens);
    return distribute(tokens, groups, duration);
  }

  /** Measure audio duration: WAV header → ffprobe → deterministic estimate. */
  private async measureDuration(audio: Buffer, tokenCount: number): Promise<number> {
    if (isWav(audio)) {
      const wavDuration = wavDurationSeconds(audio);
      if (wavDuration !== null && wavDuration > 0) return wavDuration;
    }

    const probed = await probeDurationSeconds(audio);
    if (probed !== null && probed > 0) return probed;

    return tokenCount / FALLBACK_WORDS_PER_SECOND;
  }
}

/** Whitespace tokenization — works for English and Persian alike. */
function tokenize(text: string): string[] {
  return text.split(/\s+/).filter((t) => t.length > 0);
}

/** Collapse whitespace so script/segment comparison ignores formatting drift. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isWav(buf: Buffer): boolean {
  return buf.length >= 4 && buf.toString("ascii", 0, 4) === "RIFF";
}

/** Parse the duration of a PCM WAV buffer straight from its samples + fmt. */
function wavDurationSeconds(buf: Buffer): number | null {
  try {
    const wav = new wavefile.WaveFile(buf);
    const fmt = wav.fmt as { sampleRate?: number };
    const sampleRate = fmt.sampleRate ?? 0;
    if (!sampleRate || sampleRate <= 0) return null;

    wav.toBitDepth("32f");
    let samples = wav.getSamples() as Float64Array | Float64Array[];
    if (Array.isArray(samples)) {
      const mono = samples[0];
      if (!mono) return null;
      samples = mono;
    }

    return samples.length / sampleRate;
  } catch {
    return null;
  }
}

/** ffprobe a non-WAV buffer (temp file) for its duration; null when unavailable. */
async function probeDurationSeconds(audio: Buffer): Promise<number | null> {
  let tmp: string | null = null;
  try {
    tmp = await mkdtemp(join(tmpdir(), "segment-align-"));
    const probePath = join(tmp, "audio");
    await writeFile(probePath, audio);
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        "ffprobe",
        ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", probePath],
        { timeout: 15_000 },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
    });
    const duration = Number.parseFloat(stdout.trim());
    return Number.isFinite(duration) ? duration : null;
  } catch {
    return null;
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Token count per LLM subtitle segment, or null when segments are missing or
 * don't reconstruct the script exactly (LLM paraphrased or dropped words).
 */
function segmentGroupSizes(
  segments: string[] | undefined,
  text: string,
  tokenCount: number,
): number[] | null {
  if (!segments || segments.length === 0) return null;
  if (normalize(segments.join(" ")) !== normalize(text)) return null;

  const sizes = segments.map((s) => tokenize(s).length).filter((n) => n > 0);
  const total = sizes.reduce((sum, n) => sum + n, 0);
  return total === tokenCount ? sizes : null;
}

/**
 * Deterministic chunking without LLM segments: greedy whitespace token groups
 * that end at sentence-final punctuation (once the chunk has the minimum token
 * count) or flush before a chunk would exceed the character cap.
 */
function fallbackGroupSizes(tokens: string[]): number[] {
  const sizes: number[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length > 0) {
      sizes.push(current.length);
      current = [];
    }
  };

  for (const token of tokens) {
    // Cap: never let a chunk overflow the character budget.
    if (current.length > 0 && [...current, token].join(" ").length > FALLBACK_MAX_CHUNK_CHARS) {
      flush();
    }

    current.push(token);

    // Sentence boundary: the chunk ends on the sentence-final token.
    if (SENTENCE_END.test(token) && current.length >= FALLBACK_MIN_SENTENCE_TOKENS) {
      flush();
    }
  }
  flush();

  return sizes;
}

/**
 * Pause beat after each chunk boundary: larger when the chunk ends a sentence,
 * so LLM chunk boundaries shape the caption rhythm.
 */
function computePauseBeats(tokens: string[], groups: number[]): number[] {
  const pauseAfter = tokens.map(() => 0);

  let idx = 0;
  for (const size of groups) {
    const end = Math.min(idx + size, tokens.length);
    if (end <= idx) continue;
    if (end < tokens.length) {
      pauseAfter[end - 1] = SENTENCE_END.test(tokens[end - 1] ?? "")
        ? PAUSE_SENTENCE_WEIGHT
        : PAUSE_BASE_WEIGHT;
    }
    idx = end;
  }

  return pauseAfter;
}

/**
 * Proportional timestamp distribution. Every token gets a share of the audio
 * duration based on its character weight; each chunk boundary inserts a pause
 * beat (larger at sentence ends). Timestamps are contiguous: the first word
 * starts at 0 and the last word ends exactly at the measured audio duration.
 */
function distribute(tokens: string[], groups: number[], duration: number): WordTimestamp[] {
  const weights = tokens.map((t) => Math.max(1, t.length));
  const pauseAfter = computePauseBeats(tokens, groups);

  const totalWeight =
    weights.reduce((sum, w) => sum + w, 0) + pauseAfter.reduce((sum, w) => sum + w, 0);

  const words: WordTimestamp[] = [];
  let cursor = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    const share = ((weights[i] ?? 0) / totalWeight) * duration;
    const end = i === tokens.length - 1 ? duration : cursor + share;
    words.push({ word: token, start: cursor, end });
    cursor = end + ((pauseAfter[i] ?? 0) / totalWeight) * duration;
  }

  return words;
}
