import { afterEach, describe, expect, it } from "vitest";
import {
  ALPHA_DEFAULT_BASE_URL,
  ALPHA_DEFAULT_CHARACTER,
  ALPHA_DEFAULT_IMAGE_MODEL,
  ALPHA_DEFAULT_TONE,
  alphaCharacterFromEnv,
  alphaToneFromEnv,
  resolveAlphaConfig,
} from "./alpha.js";

const KEYS = [
  "ALPHA_API_KEY",
  "ALPHA_TTS_CHARACTER",
  "ALPHA_TTS_SPEAKER",
  "ALPHA_TTS_TONE",
  "ALPHA_IMAGE_MODEL",
] as const;

describe("Alpha configuration", () => {
  const original = new Map<string, string | undefined>();
  for (const key of KEYS) original.set(key, process.env[key]);

  const clear = () => {
    for (const key of KEYS) delete process.env[key];
  };

  afterEach(() => {
    for (const key of KEYS) {
      const value = original.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("exposes the documented safe defaults", () => {
    clear();
    const config = resolveAlphaConfig();

    expect(ALPHA_DEFAULT_CHARACTER).toBe("arman");
    expect(ALPHA_DEFAULT_TONE).toBe("با لحنی آرام، ملایم و دلنشین، مانند گوینده‌ی کتاب صوتی");
    expect(ALPHA_DEFAULT_IMAGE_MODEL).toBe("flux-dev");
    expect(config.character).toBe("arman");
    expect(config.tone).toBe("با لحنی آرام، ملایم و دلنشین، مانند گوینده‌ی کتاب صوتی");
    expect(config.imageModel).toBe("flux-dev");
    expect(config.baseUrl).toBe(ALPHA_DEFAULT_BASE_URL);
    expect(config.toneFromEnv).toBe(false);
  });

  it("reads character and tone from the environment", () => {
    clear();
    process.env["ALPHA_TTS_CHARACTER"] = "mahtab";
    process.env["ALPHA_TTS_TONE"] = "با لحنی مرموز و نجواگونه";

    const config = resolveAlphaConfig();

    expect(config.character).toBe("mahtab");
    expect(config.tone).toBe("با لحنی مرموز و نجواگونه");
    expect(config.toneFromEnv).toBe(true);
    expect(alphaCharacterFromEnv()).toBe("mahtab");
    expect(alphaToneFromEnv()).toBe("با لحنی مرموز و نجواگونه");
  });

  it("falls back to the legacy ALPHA_TTS_SPEAKER alias", () => {
    clear();
    process.env["ALPHA_TTS_SPEAKER"] = "navid";
    expect(resolveAlphaConfig().character).toBe("navid");
  });

  it("prefers ALPHA_TTS_CHARACTER over the alias, and explicit overrides over env", () => {
    clear();
    process.env["ALPHA_TTS_CHARACTER"] = "navid";
    process.env["ALPHA_TTS_SPEAKER"] = "mahtab";

    expect(resolveAlphaConfig().character).toBe("navid");
    expect(resolveAlphaConfig({ character: "arman" }).character).toBe("arman");
  });

  it("ignores a blank tone so the default still applies", () => {
    clear();
    process.env["ALPHA_TTS_TONE"] = "   ";

    expect(alphaToneFromEnv()).toBeUndefined();
    const config = resolveAlphaConfig();
    expect(config.tone).toBe(ALPHA_DEFAULT_TONE);
    expect(config.toneFromEnv).toBe(false);
  });

  it("reads the image model from ALPHA_IMAGE_MODEL, and overrides win", () => {
    clear();
    process.env["ALPHA_IMAGE_MODEL"] = "z-image";
    expect(resolveAlphaConfig().imageModel).toBe("z-image");
    expect(resolveAlphaConfig({ imageModel: "flux-dev" }).imageModel).toBe("flux-dev");
  });

  it("reads the API key, with explicit overrides taking precedence", () => {
    clear();
    process.env["ALPHA_API_KEY"] = "env-key";
    expect(resolveAlphaConfig().apiKey).toBe("env-key");
    expect(resolveAlphaConfig({ apiKey: "arg-key" }).apiKey).toBe("arg-key");
  });
});
