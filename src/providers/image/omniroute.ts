import OpenAI from "openai";
import type { ImageProvider } from "../../schema/providers.js";

const DEFAULT_BASE_URL = "http://localhost:20128/v1";
// OmniRoute exposes every image-capable upstream through /v1/images/generations.
// Stable Diffusion via AI Horde is available on the free tier, so it is the default.
const DEFAULT_MODEL = "aihorde/stable_diffusion";

export class OmniRouteImage implements ImageProvider {
  private client: OpenAI;
  private model: string;

  constructor(model?: string, apiKey?: string, baseURL?: string) {
    const key = apiKey ?? process.env["OMNIROUTE_API_KEY"];
    if (!key) throw new Error("OMNIROUTE_API_KEY environment variable is required");
    this.client = new OpenAI({
      apiKey: key,
      baseURL: baseURL ?? process.env["OMNIROUTE_BASE_URL"] ?? DEFAULT_BASE_URL,
    });
    this.model = model ?? process.env["OMNIROUTE_IMAGE_MODEL"] ?? DEFAULT_MODEL;
  }

  async generate(prompt: string, style?: string): Promise<Buffer> {
    const fullPrompt = style
      ? `${prompt}. Style: ${style}. Vertical portrait orientation, 2:3 aspect ratio. No text, no watermarks.`
      : `${prompt}. Vertical portrait orientation, 2:3 aspect ratio. No text, no watermarks.`;

    const response = await this.client.images.generate({
      model: this.model,
      prompt: fullPrompt,
      n: 1,
      size: "1024x1536",
      response_format: "b64_json",
    });

    const image = response.data?.[0];
    const b64 = image?.b64_json;
    if (b64) {
      return Buffer.from(b64, "base64");
    }

    // Some upstreams ignore response_format and return a URL instead.
    const url = image?.url;
    if (url) {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`OmniRoute image download failed: HTTP ${res.status}`);
      }
      return Buffer.from(await res.arrayBuffer());
    }

    throw new Error("OmniRoute returned no image data");
  }
}
