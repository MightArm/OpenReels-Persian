/**
 * Centralized Alpha (https://api.appalpha.ir) configuration.
 *
 * Every Alpha model is called through one asynchronous route, so the TTS and
 * image providers share a single API key, base URL, and env-parsing path instead
 * of each re-reading `process.env`.
 *
 * Precedence for every value (see docs): environment variable → configured
 * value → safe project default. When an env var is set it wins, so the user is
 * never asked to re-select it.
 */

/** Alpha serves every model through one asynchronous route. */
export const ALPHA_DEFAULT_BASE_URL = "https://api.appalpha.ir/v1";

/** TTS character (Alpha's `speaker` field) used when nothing else is configured. */
export const ALPHA_DEFAULT_CHARACTER = "arman";

/**
 * TTS delivery tone (Alpha's `tone` field) used when nothing else is configured.
 * Alpha appends this to the narration text as instructions — it is never read
 * aloud and does not count toward the character price.
 */
export const ALPHA_DEFAULT_TONE = "با لحنی آرام، ملایم و دلنشین، مانند گوینده‌ی کتاب صوتی";

/** Image model id used when nothing else is configured (Alpha's FLUX.1-dev). */
export const ALPHA_DEFAULT_IMAGE_MODEL = "flux-dev";

/**
 * Portrait 9:16 output for the pipeline's Shorts format. Alpha's `width`/`height`
 * accept 256–2048 in 64px steps, so this is the largest valid 9:16 pair
 * (1152x2048) rather than the 1080x1920 used by providers with no step limit.
 */
export const ALPHA_DEFAULT_IMAGE_WIDTH = 1152;
export const ALPHA_DEFAULT_IMAGE_HEIGHT = 2048;

/**
 * Read the Alpha TTS character from `ALPHA_TTS_CHARACTER`, falling back to the
 * legacy `ALPHA_TTS_SPEAKER` alias. Returns undefined when neither is set.
 */
export function alphaCharacterFromEnv(): string | undefined {
  return process.env["ALPHA_TTS_CHARACTER"] ?? process.env["ALPHA_TTS_SPEAKER"];
}

/**
 * Read the Alpha TTS tone from `ALPHA_TTS_TONE`. Returns undefined when unset or
 * blank so callers can keep their own fallback chain (per-call metadata, then
 * `ALPHA_DEFAULT_TONE`).
 */
export function alphaToneFromEnv(): string | undefined {
  const raw = process.env["ALPHA_TTS_TONE"];
  return raw && raw.trim().length > 0 ? raw : undefined;
}

export interface AlphaConfig {
  /** API key, if one is configured. */
  apiKey?: string;
  /** Resolved REST base URL. */
  baseUrl: string;
  /** Resolved TTS character (Alpha `speaker`). */
  character: string;
  /** Resolved TTS tone (Alpha `tone`). */
  tone: string;
  /** Whether `ALPHA_TTS_TONE` was explicitly set (so callers can prefer it). */
  toneFromEnv: boolean;
  /** Resolved image model id. */
  imageModel: string;
}

/**
 * Resolve the shared Alpha configuration once. Explicit overrides (constructor
 * arguments) sit between the environment variable and the project default.
 */
export function resolveAlphaConfig(overrides: Partial<AlphaConfig> = {}): AlphaConfig {
  const toneEnv = alphaToneFromEnv();
  return {
    apiKey: overrides.apiKey ?? process.env["ALPHA_API_KEY"],
    baseUrl: overrides.baseUrl ?? ALPHA_DEFAULT_BASE_URL,
    character: overrides.character ?? alphaCharacterFromEnv() ?? ALPHA_DEFAULT_CHARACTER,
    tone: overrides.tone ?? toneEnv ?? ALPHA_DEFAULT_TONE,
    toneFromEnv: overrides.tone !== undefined || toneEnv !== undefined,
    imageModel:
      overrides.imageModel ?? process.env["ALPHA_IMAGE_MODEL"] ?? ALPHA_DEFAULT_IMAGE_MODEL,
  };
}
