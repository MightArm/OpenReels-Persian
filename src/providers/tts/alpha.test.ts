import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALPHA_DEFAULT_SPEAKER, ALPHA_MAX_INPUT_CHARS, AlphaTTS, chunkScript } from "./alpha.js";

// Mock ffmpeg: pretend conversions succeed by writing plausible output files.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (
      _cmd: string,
      args: string[],
      _opts: object,
      cb: (err: unknown, stdout: string, stderr: string) => void,
    ) => {
      const outputPath = args[args.length - 1];
      if (outputPath) {
        const fs = require("node:fs");
        fs.writeFileSync(
          outputPath,
          outputPath.endsWith(".wav")
            ? Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(64)])
            : Buffer.from("fake-mp3"),
        );
      }
      cb(null, "", "");
    },
  ),
}));

const BASE = "https://api.appalpha.ir/v1";
const MP3_AUDIO = Buffer.from("fake-alpha-mp3");

interface FetchCall {
  url: string;
  init?: RequestInit;
}

interface StubHandle {
  calls: FetchCall[];
  posts: Record<string, unknown>[];
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  };
}

function audioResponse(data: Buffer) {
  const bytes = new Uint8Array(data);
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(""),
    arrayBuffer: () => Promise.resolve(bytes.buffer),
  };
}

/** Route-aware stub for happy paths: submit, poll, download. */
function stubAlphaApi(opts: { audio?: Buffer } = {}): StubHandle {
  const calls: FetchCall[] = [];
  const posts: Record<string, unknown>[] = [];
  let jobCounter = 0;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });

      if (url.endsWith("/generations")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        posts.push(body);
        jobCounter += 1;
        return jsonResponse({
          id: `job-${jobCounter}`,
          status: "processing",
          poll_url: `${BASE}/generations/job-${jobCounter}`,
          chars: String(body["text"]).length,
        });
      }
      if (url.includes("/generations/")) {
        const id = url.split("/").pop() ?? "unknown";
        return jsonResponse({
          id,
          status: "ready",
          output: { url: `https://cdn.appalpha.ir/${id}.mp3`, type: "audio" },
        });
      }
      return audioResponse(opts.audio ?? MP3_AUDIO);
    }),
  );

  return { calls, posts };
}

type Handler = (url: string, init?: RequestInit) => unknown;

/** Scripted stub: each fetch consumes the next handler in order. */
function stubFetchSequence(handlers: Handler[]) {
  const calls: FetchCall[] = [];
  let index = 0;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const handler = handlers[index++];
      if (!handler) throw new Error(`Unexpected extra fetch call: ${url}`);
      return handler(url, init);
    }),
  );

  return { calls };
}

describe("AlphaTTS", () => {
  const originalKey = process.env["ALPHA_API_KEY"];
  const originalSpeaker = process.env["ALPHA_TTS_SPEAKER"];
  const originalTone = process.env["ALPHA_TTS_TONE"];

  beforeEach(() => {
    process.env["ALPHA_API_KEY"] = "test-alpha-key";
    delete process.env["ALPHA_TTS_SPEAKER"];
    delete process.env["ALPHA_TTS_TONE"];
  });

  afterEach(() => {
    const saved: [string, string | undefined][] = [
      ["ALPHA_API_KEY", originalKey],
      ["ALPHA_TTS_SPEAKER", originalSpeaker],
      ["ALPHA_TTS_TONE", originalTone],
    ];
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("throws when ALPHA_API_KEY is not set", () => {
      delete process.env["ALPHA_API_KEY"];
      expect(() => new AlphaTTS()).toThrow("ALPHA_API_KEY environment variable is required");
    });

    it("accepts an explicit speaker and api key", () => {
      const tts = new AlphaTTS("mahtab", "explicit-key");
      expect(tts).toBeInstanceOf(AlphaTTS);
    });
  });

  describe("generate", () => {
    it("submits one job within the cap and returns WAV with no timestamps", async () => {
      const { calls, posts } = stubAlphaApi();

      const result = await new AlphaTTS().generate("Hello, world. This is a test.");

      expect(posts).toEqual([
        {
          model: "alpha-tts",
          text: "Hello, world. This is a test.",
          speaker: ALPHA_DEFAULT_SPEAKER,
        },
      ]);
      // submit → poll → download
      expect(calls.map((c) => c.url)).toEqual([
        `${BASE}/generations`,
        `${BASE}/generations/job-1`,
        "https://cdn.appalpha.ir/job-1.mp3",
      ]);
      expect(calls[0]?.init?.method).toBe("POST");
      expect(calls[0]?.init?.headers).toEqual({
        Authorization: "Bearer test-alpha-key",
        "Content-Type": "application/json",
      });
      // WAV out (the decorator derives timings from subtitle segments, then
      // restores the pipeline's MP3 contract), never fabricated timestamps.
      expect(result.audio.toString("ascii", 0, 4)).toBe("RIFF");
      expect(result.words).toEqual([]);
    });

    it("uses ALPHA_TTS_SPEAKER when configured", async () => {
      process.env["ALPHA_TTS_SPEAKER"] = "mahtab";
      const { posts } = stubAlphaApi();

      await new AlphaTTS().generate("Hello");

      expect(posts[0]?.["speaker"]).toBe("mahtab");
    });

    it("passes delivery metadata as tone, never into the narration text", async () => {
      const { posts } = stubAlphaApi();

      await new AlphaTTS().generate("Narration only.", {
        tone: "calm",
        emotion: "curious",
        pace: "slow",
      });

      expect(posts[0]?.["tone"]).toBe("calm, curious, slow");
      expect(posts[0]?.["text"]).toBe("Narration only.");
    });

    it("uses only the delivery metadata fields that are set", async () => {
      const { posts } = stubAlphaApi();

      await new AlphaTTS().generate("Hello", { emotion: "suspenseful" });

      expect(posts[0]?.["tone"]).toBe("suspenseful");
    });

    it("prefers a configured tone over per-call delivery metadata", async () => {
      process.env["ALPHA_TTS_TONE"] = "formal and newsy";
      const { posts } = stubAlphaApi();

      await new AlphaTTS().generate("Hello", { tone: "playful" });

      expect(posts[0]?.["tone"]).toBe("formal and newsy");
    });

    it("omits tone when nothing is configured or supplied", async () => {
      const { posts } = stubAlphaApi();

      await new AlphaTTS().generate("Hello");

      expect(posts[0]).not.toHaveProperty("tone");
    });

    it("chunks long scripts at sentence boundaries with consistent speaker and tone", async () => {
      const longScript = Array.from(
        { length: 14 },
        (_, i) => `Sentence ${i + 1} ${"word ".repeat(40).trim()}.`,
      ).join(" ");
      expect(longScript.length).toBeGreaterThan(ALPHA_MAX_INPUT_CHARS);

      const { posts } = stubAlphaApi();
      const result = await new AlphaTTS().generate(longScript, { tone: "formal" });

      expect(posts.length).toBeGreaterThan(1);
      for (const post of posts) {
        expect(post["model"]).toBe("alpha-tts");
        expect(post["speaker"]).toBe(ALPHA_DEFAULT_SPEAKER);
        expect(post["tone"]).toBe("formal");
        expect(String(post["text"]).length).toBeLessThanOrEqual(ALPHA_MAX_INPUT_CHARS);
      }
      // Chunks reconstruct the original narration text exactly.
      expect(posts.map((p) => p["text"]).join(" ")).toBe(longScript);
      expect(result.words).toEqual([]);
      expect(result.audio.toString("ascii", 0, 4)).toBe("RIFF");
    });

    it("rejects an empty script without calling the API", async () => {
      const { calls } = stubAlphaApi();

      await expect(new AlphaTTS().generate("   ")).rejects.toThrow(
        "Alpha TTS: cannot synthesize an empty script",
      );
      expect(calls).toHaveLength(0);
    });
  });

  describe("generate error handling", () => {
    it("surfaces text_too_long rejections with chars and max_chars", async () => {
      stubFetchSequence([
        () =>
          jsonResponse(
            {
              error: {
                message: "script too long",
                code: "text_too_long",
                chars: 3120,
                max_chars: 2500,
              },
            },
            400,
          ),
      ]);

      await expect(new AlphaTTS().generate("short")).rejects.toThrow(
        /\(text_too_long\) \[chars=3120, max_chars=2500\]/,
      );
    });

    it("surfaces authentication errors from the error payload", async () => {
      stubFetchSequence([() => jsonResponse({ error: { message: "invalid key" } }, 401)]);

      await expect(new AlphaTTS().generate("Hello")).rejects.toThrow(
        "Alpha TTS rejected the request: invalid key",
      );
    });

    it("falls back to the HTTP status when no error payload is present", async () => {
      stubFetchSequence([() => jsonResponse({}, 500)]);

      await expect(new AlphaTTS().generate("Hello")).rejects.toThrow("Alpha TTS API error (500)");
    });

    it("throws when the submit response has no job id", async () => {
      stubFetchSequence([() => jsonResponse({ status: "processing" })]);

      await expect(new AlphaTTS().generate("Hello")).rejects.toThrow(
        "Alpha TTS response missing job id",
      );
    });

    it("throws on a non-JSON response", async () => {
      stubFetchSequence([
        () => ({
          ok: false,
          status: 502,
          text: () => Promise.resolve("<html>bad gateway</html>"),
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        }),
      ]);

      await expect(new AlphaTTS().generate("Hello")).rejects.toThrow(
        "Alpha TTS generation request returned invalid JSON (502)",
      );
    });

    it("throws when the job fails while polling", async () => {
      stubFetchSequence([
        () =>
          jsonResponse({
            id: "job-9",
            status: "processing",
            poll_url: `${BASE}/generations/job-9`,
          }),
        () =>
          jsonResponse({ id: "job-9", status: "failed", error: { message: "synthesis failed" } }),
      ]);

      await expect(new AlphaTTS().generate("Hello")).rejects.toThrow(
        "Alpha TTS job job-9 failed: synthesis failed",
      );
    });

    it("throws on an unexpected job status", async () => {
      stubFetchSequence([
        () =>
          jsonResponse({
            id: "job-9",
            status: "processing",
            poll_url: `${BASE}/generations/job-9`,
          }),
        () => jsonResponse({ id: "job-9", status: "queued" }),
      ]);

      await expect(new AlphaTTS().generate("Hello")).rejects.toThrow('unexpected status "queued"');
    });

    it("throws when a ready job has no output URL", async () => {
      stubFetchSequence([
        () =>
          jsonResponse({
            id: "job-9",
            status: "processing",
            poll_url: `${BASE}/generations/job-9`,
          }),
        () => jsonResponse({ id: "job-9", status: "ready", output: null }),
      ]);

      await expect(new AlphaTTS().generate("Hello")).rejects.toThrow(
        "is ready but returned no output URL",
      );
    });

    it("times out when the job never becomes ready", async () => {
      stubFetchSequence([
        () =>
          jsonResponse({
            id: "job-9",
            status: "processing",
            poll_url: `${BASE}/generations/job-9`,
          }),
        () => jsonResponse({ id: "job-9", status: "processing" }),
      ]);

      const tts = new AlphaTTS(undefined, undefined, { pollTimeoutMs: 0, pollIntervalMs: 1 });
      await expect(tts.generate("Hello")).rejects.toThrow(/timed out after 0s/);
    });
    it("reports the last seen progress percent on timeout", async () => {
      stubFetchSequence([
        () =>
          jsonResponse({
            id: "job-10",
            status: "processing",
            poll_url: `${BASE}/generations/job-10`,
          }),
        () => jsonResponse({ id: "job-10", status: "processing", progress: { percent: 87 } }),
      ]);

      const tts = new AlphaTTS(undefined, undefined, { pollTimeoutMs: 0, pollIntervalMs: 1 });
      await expect(tts.generate("Hello")).rejects.toThrow(
        /timed out after 0s \(still processing, last progress 87%\)/,
      );
    });

    it("reports no progress when Alpha omits progress on timeout", async () => {
      stubFetchSequence([
        () =>
          jsonResponse({
            id: "job-11",
            status: "processing",
            poll_url: `${BASE}/generations/job-11`,
          }),
        () => jsonResponse({ id: "job-11", status: "processing" }),
      ]);

      const tts = new AlphaTTS(undefined, undefined, { pollTimeoutMs: 0, pollIntervalMs: 1 });
      await expect(tts.generate("Hello")).rejects.toThrow(
        /timed out after 0s \(still processing, no progress reported\)/,
      );
    });

    it("throws when the output download fails", async () => {
      stubFetchSequence([
        () =>
          jsonResponse({
            id: "job-9",
            status: "processing",
            poll_url: `${BASE}/generations/job-9`,
          }),
        () =>
          jsonResponse({ id: "job-9", status: "ready", output: { url: "https://cdn/job-9.mp3" } }),
        () => jsonResponse({ error: "forbidden" }, 403),
      ]);

      await expect(new AlphaTTS().generate("Hello")).rejects.toThrow(
        "Alpha TTS output download failed (403) for job job-9",
      );
    });

    it("throws when the downloaded audio is empty", async () => {
      stubFetchSequence([
        () =>
          jsonResponse({
            id: "job-9",
            status: "processing",
            poll_url: `${BASE}/generations/job-9`,
          }),
        () =>
          jsonResponse({ id: "job-9", status: "ready", output: { url: "https://cdn/job-9.mp3" } }),
        () => audioResponse(Buffer.alloc(0)),
      ]);

      await expect(new AlphaTTS().generate("Hello")).rejects.toThrow(
        "Alpha TTS output for job job-9 is empty",
      );
    });
  });

  describe("chunkScript", () => {
    it("keeps scripts within the cap as a single request", () => {
      expect(chunkScript("One short line.")).toEqual(["One short line."]);
    });

    it("returns no chunks for whitespace-only input", () => {
      expect(chunkScript("   \n  ")).toEqual([]);
    });

    it("splits at sentence boundaries", () => {
      expect(chunkScript("One. Two. Three.", 6)).toEqual(["One.", "Two.", "Three."]);
    });

    it("never exceeds the cap", () => {
      const script = "word ".repeat(1200).trim(); // 5999 chars, no sentence delimiters
      const chunks = chunkScript(script, ALPHA_MAX_INPUT_CHARS);

      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(ALPHA_MAX_INPUT_CHARS);
      }
      expect(chunks.join(" ")).toBe(script);
    });

    it("hard-slices a single oversized word", () => {
      const chunks = chunkScript("a".repeat(6000), ALPHA_MAX_INPUT_CHARS);

      expect(chunks).toHaveLength(3);
      expect(chunks.map((c) => c.length)).toEqual([2500, 2500, 1000]);
    });
  });
});
