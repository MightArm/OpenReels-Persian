import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALPHA_DEFAULT_IMAGE_HEIGHT, ALPHA_DEFAULT_IMAGE_WIDTH } from "../../config/alpha.js";
import { AlphaImage } from "./alpha.js";

const BASE = "https://api.appalpha.ir/v1";

/** PNG signature, so fixtures pass the image-container validation. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A distinct, container-valid "image" fixture (the bytes are never decoded here). */
function png(label: string): Buffer {
  return Buffer.concat([PNG_SIGNATURE, Buffer.from(label)]);
}

const IMAGE = png("fake-alpha-png");

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

function imageResponse(data: Buffer) {
  const bytes = new Uint8Array(data);
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(""),
    arrayBuffer: () => Promise.resolve(bytes.buffer),
  };
}

/** Alpha's gateway serves transient failures as an HTML error page, not JSON. */
function htmlResponse(status: number) {
  return {
    ok: false,
    status,
    text: () => Promise.resolve("<!DOCTYPE html><html><body>Bad Gateway</body></html>"),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  };
}

/** Route-aware stub for happy paths: submit, poll, download. */
function stubAlphaApi(): StubHandle {
  const calls: FetchCall[] = [];
  const posts: Record<string, unknown>[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });

      if (url.endsWith("/generations")) {
        posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return jsonResponse({
          id: "img-1",
          status: "processing",
          poll_url: `${BASE}/generations/img-1`,
          cost_toman: 500,
        });
      }
      if (url.includes("/generations/")) {
        return jsonResponse({
          id: "img-1",
          status: "ready",
          output: { url: "https://cdn.appalpha.ir/img-1.png", type: "image" },
        });
      }
      return imageResponse(IMAGE);
    }),
  );

  return { calls, posts };
}

/** Scripted stub: each fetch consumes the next handler in order. */
function stubFetchSequence(handlers: Array<(url: string, init?: RequestInit) => unknown>) {
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

describe("AlphaImage", () => {
  const originalKey = process.env["ALPHA_API_KEY"];
  const originalModel = process.env["ALPHA_IMAGE_MODEL"];

  beforeEach(() => {
    process.env["ALPHA_API_KEY"] = "test-alpha-key";
    delete process.env["ALPHA_IMAGE_MODEL"];
  });

  afterEach(() => {
    for (const [name, value] of [
      ["ALPHA_API_KEY", originalKey],
      ["ALPHA_IMAGE_MODEL", originalModel],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("throws when ALPHA_API_KEY is not set", () => {
    delete process.env["ALPHA_API_KEY"];
    expect(() => new AlphaImage()).toThrow("ALPHA_API_KEY environment variable is required");
  });

  it("submits flux-dev at portrait 9:16, polls, and returns the downloaded image", async () => {
    const { calls, posts } = stubAlphaApi();

    const image = await new AlphaImage().generate("a lone lighthouse at dusk");

    expect(posts).toEqual([
      {
        model: "flux-dev",
        prompt: "a lone lighthouse at dusk. No text, no watermarks.",
        width: ALPHA_DEFAULT_IMAGE_WIDTH,
        height: ALPHA_DEFAULT_IMAGE_HEIGHT,
      },
    ]);
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/generations`,
      `${BASE}/generations/img-1`,
      "https://cdn.appalpha.ir/img-1.png",
    ]);
    expect(calls[0]?.init?.headers).toEqual({
      Authorization: "Bearer test-alpha-key",
      "Content-Type": "application/json",
    });
    expect(image.equals(IMAGE)).toBe(true);
  });

  it("appends the style to the prompt when provided", async () => {
    const { posts } = stubAlphaApi();

    await new AlphaImage().generate("a lone lighthouse", "oil painting");

    expect(posts[0]?.["prompt"]).toBe(
      "a lone lighthouse. Style: oil painting. No text, no watermarks.",
    );
  });

  it("uses ALPHA_IMAGE_MODEL when configured", async () => {
    process.env["ALPHA_IMAGE_MODEL"] = "z-image";
    const { posts } = stubAlphaApi();

    await new AlphaImage().generate("a lone lighthouse");

    expect(posts[0]?.["model"]).toBe("z-image");
  });

  it("surfaces Alpha's error payload on rejection", async () => {
    stubFetchSequence([
      () =>
        jsonResponse(
          { error: { message: "اعتبار کافی نیست", code: "insufficient_balance" } },
          402,
        ),
    ]);

    await expect(new AlphaImage().generate("x")).rejects.toThrow(
      "Alpha image generation rejected the request: اعتبار کافی نیست (insufficient_balance)",
    );
  });

  it("throws when a ready job has no output URL", async () => {
    stubFetchSequence([
      () =>
        jsonResponse({
          id: "img-9",
          status: "processing",
          poll_url: `${BASE}/generations/img-9`,
        }),
      () => jsonResponse({ id: "img-9", status: "ready", output: null }),
    ]);

    await expect(new AlphaImage().generate("x")).rejects.toThrow(
      "is ready but returned no output URL",
    );
  });

  it("throws when the downloaded image is empty", async () => {
    stubFetchSequence([
      () =>
        jsonResponse({
          id: "img-9",
          status: "processing",
          poll_url: `${BASE}/generations/img-9`,
        }),
      () =>
        jsonResponse({ id: "img-9", status: "ready", output: { url: "https://cdn/img-9.png" } }),
      () => imageResponse(Buffer.alloc(0)),
    ]);

    await expect(new AlphaImage().generate("x")).rejects.toThrow(
      /is empty \(0 bytes\)/,
    );
  });

  it("rejects a 200 that is HTML instead of an image (gateway error page)", async () => {
    stubFetchSequence([
      () =>
        jsonResponse({
          id: "img-12",
          status: "processing",
          poll_url: `${BASE}/generations/img-12`,
        }),
      () =>
        jsonResponse({ id: "img-12", status: "ready", output: { url: "https://cdn/img-12.png" } }),
      () => ({
        ok: true,
        status: 200,
        headers: { get: () => "text/html" },
        text: () => Promise.resolve("<!DOCTYPE html><html><body>Bad Gateway</body></html>"),
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode("<!DOCTYPE html>").buffer),
      }),
    ]);

    await expect(new AlphaImage().generate("x")).rejects.toThrow(
      /is not a known image container|is an HTML page/,
    );
  });

  it("times out when the job never becomes ready", async () => {
    stubFetchSequence([
      () =>
        jsonResponse({
          id: "img-9",
          status: "processing",
          poll_url: `${BASE}/generations/img-9`,
        }),
      () => jsonResponse({ id: "img-9", status: "processing", progress: { percent: 42 } }),
    ]);

    const provider = new AlphaImage(undefined, undefined, { pollTimeoutMs: 0, pollIntervalMs: 1 });
    await expect(provider.generate("x")).rejects.toThrow(
      /timed out after 0s \(still processing, last progress 42%\)/,
    );
  });

  it("retries a transient gateway error while polling instead of failing a live job", async () => {
    const { calls } = stubFetchSequence([
      () =>
        jsonResponse({
          id: "img-7",
          status: "processing",
          poll_url: `${BASE}/generations/img-7`,
        }),
      () => htmlResponse(502),
      () => htmlResponse(503),
      () =>
        jsonResponse({ id: "img-7", status: "ready", output: { url: "https://cdn/img-7.png" } }),
      () => imageResponse(IMAGE),
    ]);

    const provider = new AlphaImage(undefined, undefined, { pollIntervalMs: 1 });
    const image = await provider.generate("a lone lighthouse at dusk");

    expect(image.equals(IMAGE)).toBe(true);
    // submit + two failed polls + successful poll + download
    expect(calls.filter((c) => c.url.includes("/generations/img-7"))).toHaveLength(3);
  });

  it("times out with the last poll status when every poll fails transiently", async () => {
    stubFetchSequence([
      () =>
        jsonResponse({
          id: "img-8",
          status: "processing",
          poll_url: `${BASE}/generations/img-8`,
        }),
      () => htmlResponse(502),
    ]);

    const provider = new AlphaImage(undefined, undefined, { pollTimeoutMs: 0, pollIntervalMs: 1 });
    await expect(provider.generate("x")).rejects.toThrow(
      /timed out after 0s \(still processing, last poll HTTP 502, no progress reported\)/,
    );
  });

  it("retries a transient gateway error while downloading the finished image", async () => {
    stubFetchSequence([
      () =>
        jsonResponse({
          id: "img-10",
          status: "processing",
          poll_url: `${BASE}/generations/img-10`,
        }),
      () =>
        jsonResponse({ id: "img-10", status: "ready", output: { url: "https://cdn/img-10.png" } }),
      () => htmlResponse(502),
      () => htmlResponse(502),
      () => imageResponse(IMAGE),
    ]);

    const provider = new AlphaImage(undefined, undefined, { pollIntervalMs: 1 });
    const image = await provider.generate("x");

    expect(image.equals(IMAGE)).toBe(true);
  });

  it("fails with the last status when every download attempt is transient", async () => {
    stubFetchSequence([
      () =>
        jsonResponse({
          id: "img-11",
          status: "processing",
          poll_url: `${BASE}/generations/img-11`,
        }),
      () =>
        jsonResponse({ id: "img-11", status: "ready", output: { url: "https://cdn/img-11.png" } }),
      () => htmlResponse(502),
      () => htmlResponse(502),
      () => htmlResponse(502),
      () => htmlResponse(502),
    ]);

    const provider = new AlphaImage(undefined, undefined, { pollIntervalMs: 1 });
    await expect(provider.generate("x")).rejects.toThrow(
      "Alpha image output download failed (502) for job img-11",
    );
  });

  /**
   * The submit POST is the only call that creates the job. Before retries were
   * added, one transient socket failure lost the scene permanently and left no
   * request on Alpha's side — the exact signature of "Alpha was never called".
   */
  it("retries the submit POST after a transport failure instead of losing the scene", async () => {
    const { calls } = stubFetchSequence([
      () => {
        throw new Error("fetch failed because of ECONNRESET");
      },
      () =>
        jsonResponse({
          id: "img-20",
          status: "processing",
          poll_url: `${BASE}/generations/img-20`,
        }),
      () =>
        jsonResponse({ id: "img-20", status: "ready", output: { url: "https://cdn/img-20.png" } }),
      () => imageResponse(IMAGE),
    ]);

    const provider = new AlphaImage(undefined, undefined, {
      pollIntervalMs: 1,
      submitRetryDelayMs: 1,
    });
    const image = await provider.generate("a lone lighthouse at dusk");

    expect(image.equals(IMAGE)).toBe(true);
    expect(calls.filter((c) => c.url === `${BASE}/generations`)).toHaveLength(2);
  });

  it("retries the submit POST when the gateway answers 503", async () => {
    const { calls } = stubFetchSequence([
      () => htmlResponse(503),
      () =>
        jsonResponse({
          id: "img-21",
          status: "processing",
          poll_url: `${BASE}/generations/img-21`,
        }),
      () =>
        jsonResponse({ id: "img-21", status: "ready", output: { url: "https://cdn/img-21.png" } }),
      () => imageResponse(IMAGE),
    ]);

    const provider = new AlphaImage(undefined, undefined, {
      pollIntervalMs: 1,
      submitRetryDelayMs: 1,
    });

    expect((await provider.generate("x")).equals(IMAGE)).toBe(true);
    expect(calls.filter((c) => c.url === `${BASE}/generations`)).toHaveLength(2);
  });

  it("does not retry a rejected submit and reports Alpha's error code", async () => {
    const { calls } = stubFetchSequence([
      () =>
        jsonResponse(
          { error: { message: "insufficient balance", code: "insufficient_balance" } },
          402,
        ),
    ]);

    const provider = new AlphaImage(undefined, undefined, {
      pollIntervalMs: 1,
      submitRetryDelayMs: 1,
    });

    await expect(provider.generate("x")).rejects.toThrow(
      "Alpha image generation rejected the request: insufficient balance (insufficient_balance)",
    );
    // A rejection is not a transient failure: exactly one POST, no blind retries.
    expect(calls.filter((c) => c.url === `${BASE}/generations`)).toHaveLength(1);
  });

  it("streams secret-free lifecycle diagnostics for the whole job", async () => {
    stubAlphaApi();

    const events: { stage: string; detail?: string }[] = [];
    const provider = new AlphaImage(undefined, undefined, {
      pollIntervalMs: 1,
      onDiagnostic: (event) => events.push(event),
    });
    await provider.generate("a lone lighthouse at dusk");

    const stages = events.map((e) => e.stage);
    expect(stages).toContain("provider_generate_entered");
    expect(stages).toContain("submit_request_started");
    expect(stages).toContain("submit_response_received");
    expect(stages).toContain("submit_accepted");
    expect(stages).toContain("poll_ready");
    expect(stages).toContain("download_started");
    expect(stages).toContain("download_completed");
    expect(events.find((e) => e.stage === "submit_accepted")?.detail).toContain("job=img-1");
    expect(events.find((e) => e.stage === "download_completed")?.detail).toMatch(
      /bytes=\d+ format=png/,
    );
    // The API key must never appear in diagnostics.
    expect(events.some((e) => e.detail?.includes("test-alpha-key"))).toBe(false);
  });

  it("keeps the diagnostic sink attached after generate() so the next scene is still traced", async () => {
    stubAlphaApi();

    const events: string[] = [];
    const provider = new AlphaImage(undefined, undefined, { pollIntervalMs: 1 });
    provider.setDiagnosticSink((event) => events.push(event.stage));
    await provider.generate("first");
    await provider.generate("second");

    expect(events.filter((s) => s === "submit_request_started")).toHaveLength(2);
  });
});

