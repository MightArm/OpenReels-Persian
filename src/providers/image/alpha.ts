import {
  ALPHA_DEFAULT_IMAGE_HEIGHT,
  ALPHA_DEFAULT_IMAGE_WIDTH,
  resolveAlphaConfig,
} from "../../config/alpha.js";
import type { ImageProvider } from "../../schema/providers.js";

const POLL_INTERVAL_MS = 3_000;
/**
 * Client-side ceiling for one image job's polling. Alpha documents no bound and
 * jobs cannot be cancelled once queued, so this is deliberately generous.
 */
const POLL_TIMEOUT_MS = 600_000;
/** Attempts for the output download; Alpha's file endpoint also serves 502s. */
const DOWNLOAD_ATTEMPTS = 4;

export interface AlphaImageOptions {
  baseUrl?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

interface AlphaJob {
  id: string;
  status: "processing" | "ready" | "failed";
  poll_url?: string;
  /** Ready jobs expose the generated file here (`type: "image"`). */
  output?: { url: string; type?: string } | null;
  cost_toman?: number;
  /** Documented progress report, present on poll responses while processing. */
  progress?: { percent?: number | null } | null;
}

interface AlphaError {
  message: string;
  code?: string;
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
 * Alpha image provider — https://api.appalpha.ir/docs
 *
 * Alpha's `flux-dev` model (engine FLUX.1-dev) is served through the same
 * asynchronous submit → poll → download route as its TTS model, so this provider
 * mirrors the API's contract exactly:
 *
 *   prompt ─► POST /v1/generations {model, prompt, width, height}
 *                                  │
 *                        poll GET /v1/generations/{id}
 *                                  │
 *                         ready ─► download output.url ─► PNG buffer
 *
 * Output is requested at the pipeline's portrait 9:16 aspect ratio, expressed as
 * the largest width/height pair Alpha accepts (multiples of its documented 64px
 * step, within the 256–2048 bounds).
 */
export class AlphaImage implements ImageProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private pollIntervalMs: number;
  private pollTimeoutMs: number;

  constructor(model?: string, apiKey?: string, opts: AlphaImageOptions = {}) {
    // Resolve through the shared Alpha config so the API key, base URL, and
    // model are read in exactly one place (ALPHA_IMAGE_MODEL overrides the default).
    const config = resolveAlphaConfig({ imageModel: model, apiKey, baseUrl: opts.baseUrl });
    if (!config.apiKey) throw new Error("ALPHA_API_KEY environment variable is required");
    this.apiKey = config.apiKey;
    this.model = config.imageModel;
    this.baseUrl = config.baseUrl;
    this.pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? POLL_TIMEOUT_MS;
  }

  async generate(prompt: string, style?: string): Promise<Buffer> {
    const fullPrompt = style
      ? `${prompt}. Style: ${style}. No text, no watermarks.`
      : `${prompt}. No text, no watermarks.`;

    const job = await this.submit(fullPrompt);
    const finished = await this.waitForJob(job);
    return await this.downloadOutput(finished);
  }

  /** Queue one image and return the accepted job (with its id + poll URL). */
  private async submit(prompt: string): Promise<AlphaJob> {
    // `width`/`height` control the aspect ratio, so the 9:16 requirement is
    // expressed as API parameters rather than prompt text.
    const body: Record<string, unknown> = {
      model: this.model,
      prompt,
      width: ALPHA_DEFAULT_IMAGE_WIDTH,
      height: ALPHA_DEFAULT_IMAGE_HEIGHT,
    };

    const response = await fetch(`${this.baseUrl}/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await parseJson<AlphaJobResponse>(response, "image generation request");
    // Alpha answers rejected requests with an error object instead of a job id,
    // even when the HTTP status alone is not descriptive.
    if (data.error) throw alphaError(data.error, "Alpha image generation rejected the request");
    if (!response.ok) throw new Error(`Alpha image API error (${response.status})`);
    if (!data.id) throw new Error("Alpha image response missing job id");

    return data;
  }

  private async waitForJob(job: AlphaJob): Promise<AlphaJob> {
    const pollUrl = job.poll_url ?? `${this.baseUrl}/generations/${job.id}`;
    const deadline = Date.now() + this.pollTimeoutMs;
    let lastProgress: number | null = null;

    for (;;) {
      const response = await fetch(pollUrl, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });

      // Alpha's gateway intermittently answers a poll with a transient error page
      // (observed: HTTP 502 served as HTML) while the job keeps processing
      // server-side. Treat that as a missed poll rather than failing a live job.
      if (isTransientStatus(response.status)) {
        if (Date.now() >= deadline) {
          throw new Error(
            `Alpha image job ${job.id} timed out after ${Math.round(this.pollTimeoutMs / 1000)}s (still processing, last poll HTTP ${response.status}, ${progressNote(lastProgress)})`,
          );
        }
        await sleep(this.pollIntervalMs);
        continue;
      }

      const data = await parseJson<AlphaJobResponse>(response, `poll for job ${job.id}`);

      if (data.error) throw alphaError(data.error, `Alpha image job ${job.id} failed`);
      if (!response.ok) {
        throw new Error(`Alpha image poll error (${response.status}) for job ${job.id}`);
      }
      if (data.status === "ready") {
        if (!data.output?.url) {
          throw new Error(`Alpha image job ${job.id} is ready but returned no output URL`);
        }
        return data;
      }
      if (data.status !== "processing") {
        throw new Error(`Alpha image job ${job.id} ended with unexpected status "${data.status}"`);
      }
      lastProgress = mergeProgress(data, lastProgress);
      if (Date.now() >= deadline) {
        throw new Error(
          `Alpha image job ${job.id} timed out after ${Math.round(this.pollTimeoutMs / 1000)}s (still processing, ${progressNote(lastProgress)})`,
        );
      }

      await sleep(this.pollIntervalMs);
    }
  }

  private async downloadOutput(job: AlphaJob): Promise<Buffer> {
    const url = job.output?.url;
    if (!url) {
      throw new Error(`Alpha image job ${job.id} has no output URL to download`);
    }

    // Alpha's gateway has been observed serving 502 on file downloads too, while
    // the job itself completed and is paid for. Retry instead of discarding it.
    let lastStatus = 0;
    for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt += 1) {
      const response = await fetch(url);

      if (response.ok) {
        const image = Buffer.from(await response.arrayBuffer());
        if (image.length === 0) {
          throw new Error(`Alpha image output for job ${job.id} is empty`);
        }
        return image;
      }

      lastStatus = response.status;
      if (!isTransientStatus(response.status)) break;
      if (attempt < DOWNLOAD_ATTEMPTS - 1) await sleep(this.pollIntervalMs);
    }

    throw new Error(`Alpha image output download failed (${lastStatus}) for job ${job.id}`);
  }
}

/** Parse a JSON body, surfacing a readable error when Alpha returns non-JSON. */
async function parseJson<T>(response: HttpLikeResponse, context: string): Promise<T> {
  const raw = await response.text();
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `Alpha image ${context} returned invalid JSON (${response.status}): ${raw.slice(0, 200)}`,
    );
  }
}

/** Turn Alpha's `{ error: { message, code } }` into a readable Error. */
function alphaError(error: AlphaError, prefix: string): Error {
  const details = [error.message];
  if (error.code) details.push(`(${error.code})`);
  return new Error(`${prefix}: ${details.join(" ")}`);
}

/** Fold Alpha's reported progress percent into the running last-seen value. */
function mergeProgress(data: AlphaJobResponse, lastProgress: number | null): number | null {
  return typeof data.progress?.percent === "number" ? data.progress.percent : lastProgress;
}

/** Human-readable progress note for timeout errors. */
function progressNote(lastProgress: number | null): string {
  return lastProgress !== null ? `last progress ${lastProgress}%` : "no progress reported";
}

/**
 * True when a response is a transient Alpha gateway failure worth retrying.
 * Alpha has been observed serving 502 HTML pages on both polls and file
 * downloads; `429` is included because a throttled request is equally
 * recoverable.
 */
function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

