import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALPHA_DEFAULT_IMAGE_HEIGHT, ALPHA_DEFAULT_IMAGE_WIDTH } from "../../config/alpha.js";
import { AlphaImage } from "./alpha.js";

const BASE = "https://api.appalpha.ir/v1";
const IMAGE = Buffer.from("fake-alpha-png");

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
      "Alpha image output for job img-9 is empty",
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
});

