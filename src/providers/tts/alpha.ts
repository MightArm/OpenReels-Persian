import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TTSDeliveryOptions, TTSProvider, TTSResult } from "../../schema/providers.js";

/** Alpha serves every model through one asynchronous route. */
const ALPHA_DEFAULT_BASE_URL = "https://api.appalpha.ir/v1";
const ALPHA_TTS_MODEL = "alpha-tts";
/** Hard cap enforced by Alpha; longer text is rejected with `text_too_long`. */
export const ALPHA_MAX_INPUT_CHARS = 2500;
/** Alpha voice used when neither the constructor nor ALPHA_TTS_SPEAKER overrides it. */
export const ALPHA_DEFAULT_SPEAKER = "arman";
const POLL_INTERVAL_MS = 3_000;
/**
 * Client-side ceiling for one job's polling. Alpha documents no bound: jobs
 * cannot be cancelled and run to completion once queued, and the poll response
 * reports real progress percent while processing. 300s abandoned healthy Farsi
 * narrations in production, so this is deliberately generous.
 */
const POLL_TIMEOUT_MS = 600_000;

export interface AlphaTTSOptions {
  /** Fixed delivery instruction for every request. Wins over per-call metadata. */
  tone?: string;
  baseUrl?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

interface AlphaJob {
  id: string;
  status: "processing" | "ready" | "failed";
  poll_url?: string;
  output?: { url: string; type?: string } | null;
  cost_toman?: number;
  chars?: number;
  /** Documented progress report, present on poll responses while processing. */
  progress?: { percent?: number | null } | null;
}

interface AlphaError {
  message: string;
  code?: string;
  chars?: number;
  max_chars?: number;
}

type AlphaJobResponse = AlphaJob & { error?: AlphaError };

/** Minimal structural shape of the fetch responses we consume. */
interface HttpLikeResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * Alpha TTS provider — https://api.appalpha.ir/docs#tts
 *
 * Alpha is asynchronous and returns plain MP3 with no word timestamps, so the
 * provider follows the API's submit → poll → download contract and then hands the
 * audio to the shared alignment decorator instead of inventing timings:
 *
 *   text ─► chunk at 2500 chars ──► POST /v1/generations ──► poll GET /generations/{id}
 *                                                                        │
 *                                                              ready → download MP3
 *                                                                        │
 *                                              ffmpeg MP3 → 16kHz mono WAV
 *                                                                        │
 *                                       { audio: wav, words: [] } ──► AlignedTTSProvider
 *                                                                     (SegmentAligner)
 *
 * Returning WAV with an empty `words` array is deliberate: AlignedTTSProvider
 * derives the WordTimestamp[] from the LLM-authored subtitle segments plus the
 * measured audio duration (no speech-recognition model), then restores the
 * pipeline's MP3 contract. ElevenLabs-style timestamps are never emulated.
 */
export class AlphaTTS implements TTSProvider {
  private apiKey: string;
  private speaker: string;
  private tone?: string;
  private baseUrl: string;
  private pollIntervalMs: number;
  private pollTimeoutMs: number;

  constructor(speaker?: string, apiKey?: string, opts: AlphaTTSOptions = {}) {
    const key = apiKey ?? process.env["ALPHA_API_KEY"];
    if (!key) throw new Error("ALPHA_API_KEY environment variable is required");
    this.apiKey = key;
    this.speaker = speaker ?? process.env["ALPHA_TTS_SPEAKER"] ?? ALPHA_DEFAULT_SPEAKER;
    this.tone = opts.tone ?? process.env["ALPHA_TTS_TONE"] ?? undefined;
    this.baseUrl = opts.baseUrl ?? ALPHA_DEFAULT_BASE_URL;
    this.pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? POLL_TIMEOUT_MS;
  }

  async generate(text: string, delivery?: TTSDeliveryOptions): Promise<TTSResult> {
    if (text.trim().length === 0) {
      throw new Error("Alpha TTS: cannot synthesize an empty script");
    }

    // Alpha treats `tone` as delivery instructions, never as narration text.
    const tone = this.resolveTone(delivery);
    const chunks = chunkScript(text, ALPHA_MAX_INPUT_CHARS);

    // Same speaker + tone on every chunk keeps delivery consistent across the script
    // (the strategy Alpha's docs recommend for text above the per-request cap).
    const parts: Buffer[] = [];
    for (const chunk of chunks) {
      parts.push(await this.synthesize(chunk, tone));
    }

    const audio = await mp3PartsToWav(parts);
    return { audio, words: [] };
  }

  /**
   * Static tone (constructor / ALPHA_TTS_TONE) wins; otherwise compose whatever
   * optional delivery metadata the pipeline supplied (tone, emotion, pace).
   */
  private resolveTone(delivery?: TTSDeliveryOptions): string | undefined {
    if (this.tone) return this.tone;

    const parts = [delivery?.tone, delivery?.emotion, delivery?.pace]
      .map((part) => part?.trim())
      .filter((part): part is string => Boolean(part && part.length > 0));

    return parts.length > 0 ? parts.join(", ") : undefined;
  }

  /** Submit one chunk, wait for it to finish, and return the downloaded MP3. */
  private async synthesize(text: string, tone: string | undefined): Promise<Buffer> {
    const job = await this.submit(text, tone);
    const finished = await this.waitForJob(job);
    return await this.downloadOutput(finished);
  }

  private async submit(text: string, tone: string | undefined): Promise<AlphaJob> {
    const body: Record<string, unknown> = { model: ALPHA_TTS_MODEL, text };
    if (this.speaker) body["speaker"] = this.speaker;
    if (tone) body["tone"] = tone;

    const response = await fetch(`${this.baseUrl}/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await parseJson<AlphaJobResponse>(response, "generation request");
    // Alpha answers rejected requests with an error object instead of a job id,
    // even when the HTTP status alone is not descriptive (`text_too_long`, etc.).
    if (data.error) throw alphaError(data.error, "Alpha TTS rejected the request");
    if (!response.ok) throw new Error(`Alpha TTS API error (${response.status})`);
    if (!data.id) throw new Error("Alpha TTS response missing job id");

    return data;
  }

  private async waitForJob(job: AlphaJob): Promise<AlphaJob> {
    const pollUrl = job.poll_url ?? `${this.baseUrl}/generations/${job.id}`;
    const deadline = Date.now() + this.pollTimeoutMs;
    // Alpha reports a real progress percent on the poll response while the
    // job is processing (documented progress bar); track it for observability.
    let lastProgress: number | null = null;

    for (;;) {
      const response = await fetch(pollUrl, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      const data = await parseJson<AlphaJobResponse>(response, `poll for job ${job.id}`);

      if (data.error) throw alphaError(data.error, `Alpha TTS job ${job.id} failed`);
      if (!response.ok) {
        throw new Error(`Alpha TTS poll error (${response.status}) for job ${job.id}`);
      }
      if (data.status === "ready") {
        if (!data.output?.url) {
          throw new Error(`Alpha TTS job ${job.id} is ready but returned no output URL`);
        }
        return data;
      }
      if (data.status !== "processing") {
        throw new Error(`Alpha TTS job ${job.id} ended with unexpected status "${data.status}"`);
      }
      lastProgress = mergeProgress(data, lastProgress);
      if (Date.now() >= deadline) {
        throw new Error(
          `Alpha TTS job ${job.id} timed out after ${Math.round(this.pollTimeoutMs / 1000)}s (still processing, ${progressNote(lastProgress)})`,
        );
      }

      await sleep(this.pollIntervalMs);
    }
  }

  private async downloadOutput(job: AlphaJob): Promise<Buffer> {
    const url = job.output?.url;
    if (!url) {
      throw new Error(`Alpha TTS job ${job.id} has no output URL to download`);
    }

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Alpha TTS output download failed (${response.status}) for job ${job.id}`);
    }

    const audio = Buffer.from(await response.arrayBuffer());
    if (audio.length === 0) {
      throw new Error(`Alpha TTS output for job ${job.id} is empty`);
    }

    return audio;
  }
}

/**
 * Split a script into chunks that respect Alpha's per-request character cap.
 * Splits on sentence boundaries first (`. ! ? ؟ …` and newlines, per the docs'
 * guidance) and falls back to word boundaries for punctuation-free text.
 */
export function chunkScript(text: string, maxChars: number = ALPHA_MAX_INPUT_CHARS): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed.length > 0 ? [trimmed] : [];

  const sentences = trimmed.split(/(?<=[.!?؟…\n])\s+/u);
  const chunks: string[] = [];
  let current = "";

  const flush = (value: string) => {
    const clean = value.trim();
    if (clean.length > 0) chunks.push(clean);
  };

  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      flush(current);
      current = "";
      for (const piece of splitOversized(sentence, maxChars)) flush(piece);
      continue;
    }

    const candidate = current.length > 0 ? `${current} ${sentence}` : sentence;
    if (candidate.length > maxChars) {
      flush(current);
      current = sentence;
    } else {
      current = candidate;
    }
  }

  flush(current);
  return chunks;
}

/** Last-resort split for a single sentence that is longer than the cap. */
function splitOversized(sentence: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let current = "";

  for (const word of sentence.split(/\s+/)) {
    const candidate = current.length > 0 ? `${current} ${word}` : word;

    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    if (current.length > 0) pieces.push(current);
    current = "";

    if (word.length > maxChars) {
      // A single "word" above the cap can only be hard-sliced.
      for (let i = 0; i < word.length; i += maxChars) {
        pieces.push(word.slice(i, i + maxChars));
      }
    } else {
      current = word;
    }
  }

  if (current.length > 0) pieces.push(current);
  return pieces;
}

async function parseJson<T>(response: HttpLikeResponse, context: string): Promise<T> {
  const raw = await response.text();
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `Alpha TTS ${context} returned invalid JSON (${response.status}): ${raw.slice(0, 200)}`,
    );
  }
}

/** Turn Alpha's `{ error: { message, code, chars, max_chars } }` into a readable Error. */
function alphaError(error: AlphaError, prefix: string): Error {
  const details = [error.message];
  if (error.code) details.push(`(${error.code})`);
  if (typeof error.chars === "number" || typeof error.max_chars === "number") {
    details.push(`[chars=${error.chars ?? "?"}, max_chars=${error.max_chars ?? "?"}]`);
  }
  return new Error(`${prefix}: ${details.join(" ")}`);
}

/**
 * Fold Alpha's reported progress percent (present on poll responses while
 * processing, per the documented progress bar) into the running last-seen value.
 */
function mergeProgress(data: AlphaJobResponse, lastProgress: number | null): number | null {
  return typeof data.progress?.percent === "number" ? data.progress.percent : lastProgress;
}

/** Human-readable progress note for timeout errors (answer: was it nearly done?). */
function progressNote(lastProgress: number | null): string {
  return lastProgress !== null ? `last progress ${lastProgress}%` : "no progress reported";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { timeout: 120_000 }, (err) => {
      if (err) {
        reject(
          new Error(
            `Alpha TTS audio conversion failed: ${err.message}. Ensure ffmpeg is installed and in PATH.`,
          ),
        );
      } else {
        resolve();
      }
    });
  });
}

/**
 * Convert one or more MP3 buffers into a single 16kHz mono PCM WAV buffer.
 *
 * The WAV keeps Alpha's output decodable by any aligner and lets the
 * AlignedTTSProvider decorator restore the pipeline's MP3 contract afterward.
 * Timestamps are derived from the LLM subtitle segments + measured duration, so
 * no speech-recognition model is involved.
 */
async function mp3PartsToWav(parts: Buffer[]): Promise<Buffer> {
  const tmp = await mkdtemp(join(tmpdir(), "alpha-tts-"));
  const paths: string[] = [];

  try {
    for (const [i, part] of parts.entries()) {
      const partPath = join(tmp, `part-${i}.mp3`);
      await writeFile(partPath, part);
      paths.push(partPath);
    }

    const first = paths[0];
    if (!first) throw new Error("Alpha TTS: no audio parts to convert");

    let input = first;
    if (paths.length > 1) {
      // Concatenate chunks into one stream so timestamps stay continuous.
      const listPath = join(tmp, "concat.txt");
      await writeFile(
        listPath,
        paths.map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"),
      );
      const combined = join(tmp, "combined.mp3");
      await runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", combined]);
      input = combined;
    }

    const wavPath = join(tmp, "output.wav");
    await runFfmpeg(["-y", "-i", input, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath]);

    return await readFile(wavPath);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
