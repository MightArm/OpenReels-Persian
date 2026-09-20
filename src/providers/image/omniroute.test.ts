import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock openai SDK
const mockImagesGenerate = vi.fn();
vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(() => ({
    images: { generate: mockImagesGenerate },
  })),
}));

import OpenAI from "openai";
import { OmniRouteImage } from "./omniroute.js";

const B64_PAYLOAD = Buffer.from("fake-png-bytes").toString("base64");

function b64Response(b64: string | undefined, url?: string) {
  return { data: [{ ...(b64 ? { b64_json: b64 } : {}), ...(url ? { url } : {}) }] };
}

describe("OmniRouteImage", () => {
  const origKey = process.env["OMNIROUTE_API_KEY"];
  const origBaseUrl = process.env["OMNIROUTE_BASE_URL"];
  const origImageModel = process.env["OMNIROUTE_IMAGE_MODEL"];

  beforeEach(() => {
    process.env["OMNIROUTE_API_KEY"] = "test-omniroute-key";
    delete process.env["OMNIROUTE_BASE_URL"];
    delete process.env["OMNIROUTE_IMAGE_MODEL"];
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const [name, value] of [
      ["OMNIROUTE_API_KEY", origKey],
      ["OMNIROUTE_BASE_URL", origBaseUrl],
      ["OMNIROUTE_IMAGE_MODEL", origImageModel],
    ] as const) {
      if (value !== undefined) {
        process.env[name] = value;
      } else {
        delete process.env[name];
      }
    }
  });

  describe("constructor", () => {
    it("throws when OMNIROUTE_API_KEY is not set", () => {
      delete process.env["OMNIROUTE_API_KEY"];
      expect(() => new OmniRouteImage()).toThrow(
        "OMNIROUTE_API_KEY environment variable is required",
      );
    });

    it("defaults to the local OmniRoute endpoint", () => {
      new OmniRouteImage();
      expect((OpenAI as any).mock.calls[0][0]).toMatchObject({
        apiKey: "test-omniroute-key",
        baseURL: "http://localhost:20128/v1",
      });
    });

    it("uses OMNIROUTE_BASE_URL env var when set", () => {
      process.env["OMNIROUTE_BASE_URL"] = "http://gateway.example:20128/v1";
      new OmniRouteImage();
      expect((OpenAI as any).mock.calls[0][0]).toMatchObject({
        baseURL: "http://gateway.example:20128/v1",
      });
    });

    it("prefers the explicit baseURL argument over the env var", () => {
      process.env["OMNIROUTE_BASE_URL"] = "http://env.example:20128/v1";
      new OmniRouteImage(undefined, undefined, "http://arg.example:20128/v1");
      expect((OpenAI as any).mock.calls[0][0]).toMatchObject({
        baseURL: "http://arg.example:20128/v1",
      });
    });

    it("prefers the explicit apiKey argument over the env var", () => {
      new OmniRouteImage(undefined, "explicit-key");
      expect((OpenAI as any).mock.calls[0][0]).toMatchObject({ apiKey: "explicit-key" });
    });
  });

  describe("generate", () => {
    it("decodes b64_json into a Buffer", async () => {
      mockImagesGenerate.mockResolvedValue(b64Response(B64_PAYLOAD));
      const image = new OmniRouteImage();

      const buffer = await image.generate("a lone lighthouse at dusk");

      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.toString()).toBe("fake-png-bytes");
    });

    it("calls images.generate with the default model, vertical size and b64 format", async () => {
      mockImagesGenerate.mockResolvedValue(b64Response(B64_PAYLOAD));
      const image = new OmniRouteImage();

      await image.generate("a lone lighthouse at dusk");

      expect(mockImagesGenerate).toHaveBeenCalledWith({
        model: "aihorde/stable_diffusion",
        prompt:
          "a lone lighthouse at dusk. Vertical portrait orientation, 2:3 aspect ratio. No text, no watermarks.",
        n: 1,
        size: "1024x1536",
        response_format: "b64_json",
      });
    });

    it("appends the style to the prompt when provided", async () => {
      mockImagesGenerate.mockResolvedValue(b64Response(B64_PAYLOAD));
      const image = new OmniRouteImage();

      await image.generate("a lone lighthouse", "oil painting");

      expect(mockImagesGenerate).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt:
            "a lone lighthouse. Style: oil painting. Vertical portrait orientation, 2:3 aspect ratio. No text, no watermarks.",
        }),
      );
    });

    it("uses OMNIROUTE_IMAGE_MODEL env var when set", async () => {
      process.env["OMNIROUTE_IMAGE_MODEL"] = "aihorde/Z-Image-Turbo";
      mockImagesGenerate.mockResolvedValue(b64Response(B64_PAYLOAD));
      const image = new OmniRouteImage();

      await image.generate("a lone lighthouse");

      expect(mockImagesGenerate).toHaveBeenCalledWith(
        expect.objectContaining({ model: "aihorde/Z-Image-Turbo" }),
      );
    });

    it("prefers the explicit model argument over the env var", async () => {
      process.env["OMNIROUTE_IMAGE_MODEL"] = "aihorde/Z-Image-Turbo";
      mockImagesGenerate.mockResolvedValue(b64Response(B64_PAYLOAD));
      const image = new OmniRouteImage("aihorde/SDXL 1.0");

      await image.generate("a lone lighthouse");

      expect(mockImagesGenerate).toHaveBeenCalledWith(
        expect.objectContaining({ model: "aihorde/SDXL 1.0" }),
      );
    });

    it("downloads the image when the upstream returns a url instead of b64_json", async () => {
      mockImagesGenerate.mockResolvedValue(b64Response(undefined, "http://cdn.example/img.png"));
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
      const image = new OmniRouteImage();

      const buffer = await image.generate("a lone lighthouse");

      expect(fetchMock).toHaveBeenCalledWith("http://cdn.example/img.png");
      expect(buffer.equals(Buffer.from([1, 2, 3]))).toBe(true);
      fetchMock.mockRestore();
    });

    it("throws when the url download fails", async () => {
      mockImagesGenerate.mockResolvedValue(b64Response(undefined, "http://cdn.example/img.png"));
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(null, { status: 500 }));
      const image = new OmniRouteImage();

      await expect(image.generate("a lone lighthouse")).rejects.toThrow(
        "OmniRoute image download failed: HTTP 500",
      );
      fetchMock.mockRestore();
    });

    it("throws when the response has no image data", async () => {
      mockImagesGenerate.mockResolvedValue({ data: [{}] });
      const image = new OmniRouteImage();

      await expect(image.generate("a lone lighthouse")).rejects.toThrow(
        "OmniRoute returned no image data",
      );
    });
  });
});
