import {
  ALPHA_DEFAULT_IMAGE_HEIGHT,
  ALPHA_DEFAULT_IMAGE_WIDTH,
  resolveAlphaConfig,
} from "../../config/alpha.js";
import type {
  DiagnosableImageProvider,
  ImageProviderDiagnosticEvent,
} from "../../schema/providers.js";
import { assertImageBuffer } from "./image-bytes.js";

const POLL_INTERVAL_MS = 3_000;
/**
 * Client-side ceiling for one image job's polling.
 *
 * Alpha documents up to 15 minutes for image/audio jobs, auto-fails a job at its
 * `expires_at` without charging, and cannot cancel a queued job. Capping below
 * Alpha's own limit abandons live, already-queued jobs, so this matches it.
 */
const POLL_TIMEOUT_MS = 900_000;
/** Attempts for the output download; Alpha's file endpoint also serves 502s. */
const DOWNLOAD_ATTEMPTS = 4;
/**
 * Attempts for the submit POST. This is the only call in the provider that
 * creates the job, so a single transient socket/DNS/gateway failure used to
 * lose the scene outright (and left no trace of a request on Alpha's side).
 */
const SUBMIT_ATTEMPTS = 3;
/** Delay between submit attempts. */
const SUBMIT_RETRY_DELAY_MS = 2_000;
/** Per-request socket timeout for submit/poll/download. */
const REQUEST_TIMEOUT_MS = 60_000;

export interface AlphaImageOptions {
  baseUrl?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  /** Override the submit retry delay (tests use a tiny value). */
  submitRetryDelayMs?: number;
  /** Override the per-request socket timeout. */
  requestTimeoutMs?: number;
  /** Sink for secret-free lifecycle diagnostics (wired up by the pipeline). */
  onDiagnostic?: (event: ImageProviderDiagnosticEvent) => void;
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
  /** Present on real fetch responses; used to record the served content type. */
  headers?: { get(name: string): string | null } | null;
}

/** Outcome of one submit round-trip: either a queued job or a retryable error. */
type SubmitAttemptResult =
  | { kind: "accepted"; job: AlphaJob }
  | { kind: "retry"; error: Error };

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
export class AlphaImage implements DiagnosableImageProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private pollIntervalMs: number;
  private pollTimeoutMs: number;
  private submitRetryDelayMs: number;
  private requestTimeoutMs: number;
  private diagnostic?: (event: ImageProviderDiagnosticEvent) => void;

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
    this.submitRetryDelayMs = opts.submitRetryDelayMs ?? SUBMIT_RETRY_DELAY_MS;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.diagnostic = opts.onDiagnostic;
  }

  /**
   * Attach the pipeline's diagnostic sink. Wired up before `generate()` so the
   * log answers "was Alpha reached, and what did it answer?" for every scene.
   */
  setDiagnosticSink(sink: (event: ImageProviderDiagnosticEvent) => void): void {
    this.diagnostic = sink;
  }

  /** Emit one lifecycle event; never includes the API key. */
  private diag(stage: string, detail?: string): void {
    try {
      this.diagnostic?.({ stage, ...(detail ? { detail } : {}) });
    } catch {
      // Diagnostics must never break generation.
    }
  }

  async generate(prompt: string, style?: string): Promise<Buffer> {
    const fullPrompt = style
      ? `${prompt}. Style: ${style}. No text, no watermarks.`
      : `${prompt}. No text, no watermarks.`;

    this.diag(
      "provider_generate_entered",
      `model=${this.model} size=${ALPHA_DEFAULT_IMAGE_WIDTH}x${ALPHA_DEFAULT_IMAGE_HEIGHT} endpoint=${this.baseUrl}/generations`,
    );

    try {
      const job = await this.submit(fullPrompt);
      const finished = await this.waitForJob(job);
      return await this.downloadOutput(finished);
    } catch (err) {
      this.diag("provider_generate_failed", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /**
   * Queue one image and return the accepted job (with its id + poll URL).
   *
   * This POST is the only call that creates the job, so it is retried: a single
   * transient socket/DNS/gateway failure used to lose the scene outright and left
   * no request on Alpha's side at all. An explicit rejection is never retried.
   */
  private async submit(prompt: string): Promise<AlphaJob> {
    // `width`/`height` control the aspect ratio, so the 9:16 requirement is
    // expressed as API parameters rather than prompt text.
    const body: Record<string, unknown> = {
      model: this.model,
      prompt,
      width: ALPHA_DEFAULT_IMAGE_WIDTH,
      height: ALPHA_DEFAULT_IMAGE_HEIGHT,
    };
    const url = `${this.baseUrl}/generations`;

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < SUBMIT_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await sleep(this.submitRetryDelayMs * attempt);
      this.diag(
        "submit_request_started",
        `attempt=${attempt + 1}/${SUBMIT_ATTEMPTS} url=${url} model=${this.model}`,
      );

      const result = await this.submitAttempt(url, body, attempt);
      if (result.kind === "accepted") return result.job;
      lastError = result.error;
    }

    throw lastError ?? new Error("Alpha image submit failed");
  }

  /**
   * One submit round-trip.
   *
   * Returns `retry` for a transport failure or a transient status with no error
   * payload (gateway noise). Throws for anything final: Alpha's structured error
   * payload, a non-transient status, an unparseable body, or a missing job id.
   */
  private async submitAttempt(
    url: string,
    body: Record<string, unknown>,
    attempt: number,
  ): Promise<SubmitAttemptResult> {
    let response: HttpLikeResponse;
    try {
      response = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
        this.requestTimeoutMs,
      );
    } catch (err) {
      const error = new Error(
        `Alpha image submit request failed (${describeTransportError(err)}). ` +
          "Alpha received no request for this scene",
      );
      this.diag("submit_transport_failed", `attempt=${attempt + 1} ${error.message}`);
      return { kind: "retry", error };
    }

    this.diag("submit_response_received", `attempt=${attempt + 1} status=${response.status}`);

    // Read the body once. Alpha answers a rejected request with a structured
    // error object instead of a job id even when the HTTP status alone is not
    // descriptive, so that payload is decoded first and is final (retrying an
    // explicit rejection is pointless).
    const rawBody = await readBody(response);
    const errorPayload = parseErrorPayload(rawBody);
    if (errorPayload) {
      const err = alphaError(errorPayload, "Alpha image generation rejected the request");
      this.diag("submit_rejected", `status=${response.status} ${err.message}`);
      throw err;
    }

    if (!response.ok) {
      const detail = rawBody ? `: ${rawBody.slice(0, 200)}` : "";
      const err = new Error(`Alpha image API error (${response.status})${detail}`);
      if (!isTransientStatus(response.status) || attempt >= SUBMIT_ATTEMPTS - 1) {
        this.diag("submit_rejected", err.message);
        throw err;
      }
      this.diag("submit_transient_error", `status=${response.status}${detail}`);
      return { kind: "retry", error: err };
    }

    const data = parseJson<AlphaJobResponse>(rawBody, "image generation request", response.status);
    // Kept for the case where a 200 body still carries an error object.
    if (data.error) {
      const err = alphaError(data.error, "Alpha image generation rejected the request");
      this.diag("submit_rejected", `status=${response.status} ${err.message}`);
      throw err;
    }
    if (!data.id) {
      this.diag("submit_malformed", `status=${response.status} response-missing-job-id`);
      throw new Error("Alpha image response missing job id");
    }

    this.diag(
      "submit_accepted",
      `job=${data.id} status=${data.status} cost_toman=${data.cost_toman ?? "?"}`,
    );
    return { kind: "accepted", job: data };
  }

  private async waitForJob(job: AlphaJob): Promise<AlphaJob> {
    const pollUrl = job.poll_url ?? `${this.baseUrl}/generations/${job.id}`;
    const deadline = Date.now() + this.pollTimeoutMs;
    let lastProgress: number | null = null;

    for (;;) {
      const response = await fetchWithTimeout(
        pollUrl,
        { headers: { Authorization: `Bearer ${this.apiKey}` } },
        this.requestTimeoutMs,
      );

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

        const pollBody = await readBody(response);
        const data = parseJson<AlphaJobResponse>(pollBody, `poll for job ${job.id}`, response.status);

      if (data.error) throw alphaError(data.error, `Alpha image job ${job.id} failed`);
      if (!response.ok) {
        throw new Error(`Alpha image poll error (${response.status}) for job ${job.id}`);
      }
      if (data.status === "ready") {
        if (!data.output?.url) {
          throw new Error(`Alpha image job ${job.id} is ready but returned no output URL`);
        }
        this.diag(
          "poll_ready",
          `job=${job.id} elapsed=${Math.round((this.pollTimeoutMs - (deadline - Date.now())) / 1000)}s progress=${lastProgress ?? "?"}%`,
        );
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
      this.diag(
        "download_started",
        `job=${job.id} attempt=${attempt + 1}/${DOWNLOAD_ATTEMPTS} url=${url}`,
      );
      const response: HttpLikeResponse = await fetchWithTimeout(url, {}, this.requestTimeoutMs);

      if (response.ok) {
        const image = Buffer.from(await response.arrayBuffer());
        // A 200 is not proof of an image: gateways and CDNs also serve HTML/JSON
        // error bodies with a 200. Validating the container here stops an
        // undecodable file from being written as scene-N-ai.png (which would
        // render as a silent black beat).
        const format = assertImageBuffer(image, `Alpha image output for job ${job.id}`);
        this.diag(
          "download_completed",
          `job=${job.id} bytes=${image.length} format=${format} content-type=${response.headers?.get("content-type") ?? "unknown"}`,
        );
        return image;
      }

      lastStatus = response.status;
      if (!isTransientStatus(response.status)) break;
      if (attempt < DOWNLOAD_ATTEMPTS - 1) await sleep(this.pollIntervalMs);
    }

    throw new Error(`Alpha image output download failed (${lastStatus}) for job ${job.id}`);
  }
}

/** Read a response body once (whitespace-collapsed), tolerating a stream error. */
async function readBody(response: HttpLikeResponse): Promise<string> {
  try {
    return (await response.text()).trim().replace(/\s+/g, " ");
  } catch {
    return "";
  }
}

/** Extract Alpha's structured `{ error: { message, code } }` payload, when present. */
function parseErrorPayload(raw: string): AlphaError | null {
  if (!raw.includes('"error"')) return null;
  try {
    const parsed = JSON.parse(raw) as { error?: AlphaError };
    return parsed.error ?? null;
  } catch {
    return null;
  }
}

/** Parse an already-read body, surfacing a readable error when it is not JSON. */
function parseJson<T>(raw: string, context: string, status: number): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `Alpha image ${context} returned invalid JSON (${status}): ${raw.slice(0, 200)}`,
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

/**
 * `fetch` with a hard socket timeout. Without one, a stalled connection hangs a
 * scene indefinitely and is indistinguishable from slow generation.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort, log-safe description of a transport-level fetch failure. */
function describeTransportError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const code = cause?.code ?? cause?.message;
    return code ? `${err.message} (${code})` : err.message;
  }
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

