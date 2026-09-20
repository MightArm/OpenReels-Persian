import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: vi.fn(() => {
    const provider = vi.fn((model: string) => ({ model, type: "omniroute-model" }));
    return provider;
  }),
}));

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { OmniRouteLLM } from "./omniroute.js";

describe("OmniRouteLLM", () => {
  const ORIG_BASE_URL = process.env["OMNIROUTE_BASE_URL"];

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env["OMNIROUTE_BASE_URL"];
  });

  afterAll(() => {
    if (ORIG_BASE_URL !== undefined) process.env["OMNIROUTE_BASE_URL"] = ORIG_BASE_URL;
  });

  it("has id 'omniroute'", () => {
    const llm = new OmniRouteLLM();
    expect(llm.id).toBe("omniroute");
  });

  it("defaults to the local OmniRoute endpoint and default model", () => {
    new OmniRouteLLM();
    expect(createOpenAICompatible).toHaveBeenCalledWith({
      name: "omniroute",
      baseURL: "http://localhost:20128/v1",
      supportsStructuredOutputs: true,
    });
  });

  it("uses OMNIROUTE_BASE_URL env var as default base URL", () => {
    process.env["OMNIROUTE_BASE_URL"] = "http://gateway.example:20128/v1";
    new OmniRouteLLM();
    expect(createOpenAICompatible).toHaveBeenCalledWith({
      name: "omniroute",
      baseURL: "http://gateway.example:20128/v1",
      supportsStructuredOutputs: true,
    });
  });

  it("passes apiKey to createOpenAICompatible", () => {
    new OmniRouteLLM("cc/claude-opus-4-6", "test-key");
    expect(createOpenAICompatible).toHaveBeenCalledWith({
      name: "omniroute",
      baseURL: "http://localhost:20128/v1",
      supportsStructuredOutputs: true,
      apiKey: "test-key",
    });
  });

  it("omits apiKey when not provided", () => {
    new OmniRouteLLM("some-model");
    expect(createOpenAICompatible).toHaveBeenCalledWith({
      name: "omniroute",
      baseURL: "http://localhost:20128/v1",
      supportsStructuredOutputs: true,
    });
  });

  it("defaults to the auto/best-reasoning routing alias", () => {
    const llm = new OmniRouteLLM();
    const model = (llm as any).createLanguageModel();
    expect(model).toEqual({ model: "auto/best-reasoning", type: "omniroute-model" });
  });

  it("creates a language model for the requested model ID", () => {
    const llm = new OmniRouteLLM("cc/claude-opus-4-6", "test-key");
    const model = (llm as any).createLanguageModel();
    expect(model).toEqual({ model: "cc/claude-opus-4-6", type: "omniroute-model" });
  });

  it("createSearchTools returns empty object (no native search)", () => {
    const llm = new OmniRouteLLM();
    const tools = (llm as any).createSearchTools();
    expect(tools).toEqual({});
  });

  it("stores injected search tools", () => {
    const injected = { tavily: {} };
    const llm = new OmniRouteLLM("model", undefined, undefined, injected);
    expect((llm as any).injectedSearchTools).toBe(injected);
  });
});
