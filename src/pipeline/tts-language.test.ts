import { afterEach, describe, expect, it } from "vitest";
import { ttsLanguageFromEnv } from "./utils.js";

describe("ttsLanguageFromEnv", () => {
  const KEY = "TTS_LANGUAGE";

  afterEach(() => {
    delete process.env[KEY];
  });

  it("reads supported values case-insensitively", () => {
    for (const v of ["english", "ENGLISH", "english "]) {
      process.env[KEY] = v;
      expect(ttsLanguageFromEnv()).toBe("english");
    }
    for (const v of ["farsi", "Farsi", " farsi "]) {
      process.env[KEY] = v;
      expect(ttsLanguageFromEnv()).toBe("farsi");
    }
  });

  it("returns undefined when unset or unrecognized", () => {
    delete process.env[KEY];
    expect(ttsLanguageFromEnv()).toBeUndefined();
    process.env[KEY] = "german";
    expect(ttsLanguageFromEnv()).toBeUndefined();
  });
});
