import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { BaseLLM } from "./base.js";

/**
 * OmniRoute — free self-hostable AI gateway (https://github.com/diegosouzapw/OmniRoute).
 * One OpenAI-compatible endpoint in front of 352+ providers with quota-aware
 * auto-fallback. Default local endpoint: http://localhost:20128/v1
 * (`npx omniroute@latest` or `docker run -p 20128:20128 diegosouzapw/omniroute`).
 * Create an API key in the dashboard at http://localhost:20128.
 *
 * The default model is OmniRoute's own `auto/best-reasoning` routing alias:
 * provider-specific IDs (e.g. `anthropic/claude-sonnet-4`) only exist if *you*
 * configured that upstream account, whereas `auto/*` aliases are always present
 * and route to the best currently-available model with quota-aware fallback.
 */
export class OmniRouteLLM extends BaseLLM {
  readonly id = "omniroute" as const;
  private provider: ReturnType<typeof createOpenAICompatible>;
  private model: string;

  constructor(
    model: string = "auto/best-reasoning",
    apiKey?: string,
    baseURL: string = process.env["OMNIROUTE_BASE_URL"] ?? "http://localhost:20128/v1",
    searchTools?: Record<string, unknown>,
  ) {
    super(searchTools);
    this.model = model;
    this.provider = createOpenAICompatible({
      name: "omniroute",
      baseURL,
      // OmniRoute speaks the OpenAI API; without this flag the adapter drops
      // response_format json_schema and weak gateway models return unparseable text.
      supportsStructuredOutputs: true,
      ...(apiKey ? { apiKey } : {}),
    });
  }

  protected createLanguageModel(): LanguageModel {
    return this.provider(this.model);
  }

  protected createSearchTools() {
    // OmniRoute has no native search tools; Tavily injection or parametric fallback handles this
    return {};
  }
}
