import type { LanguageModel } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LLMProviderKey } from "../../schema/providers.js";
import { BaseLLM, repairJsonText } from "./base.js";

// Mock the ai module
vi.mock("ai", () => ({
  generateText: vi.fn(),
  generateObject: vi.fn(),
  stepCountIs: vi.fn((n: number) => ({ type: "step-count", count: n })),
}));

import { generateObject, generateText } from "ai";

const mockGenerateText = vi.mocked(generateText);
const mockGenerateObject = vi.mocked(generateObject);

// Concrete test subclass
class TestLLM extends BaseLLM {
  readonly id: LLMProviderKey = "anthropic";
  private mockModel = {} as LanguageModel;
  private mockTools = { test_search: {} };

  constructor(searchTools?: Record<string, unknown>) {
    super(searchTools);
  }

  protected createLanguageModel(): LanguageModel {
    return this.mockModel;
  }

  protected createSearchTools() {
    return this.mockTools;
  }
}

// Subclass with no native tools (like OpenRouter)
class NoToolsLLM extends BaseLLM {
  readonly id: LLMProviderKey = "openrouter";
  private mockModel = {} as LanguageModel;

  constructor(searchTools?: Record<string, unknown>) {
    super(searchTools);
  }

  protected createLanguageModel(): LanguageModel {
    return this.mockModel;
  }

  protected createSearchTools() {
    return {};
  }
}

const testSchema = z.object({ result: z.string() });

describe("BaseLLM", () => {
  let llm: TestLLM;

  beforeEach(() => {
    vi.clearAllMocks();
    llm = new TestLLM();
  });

  describe("generate()", () => {
    it("routes to structured output when enableWebSearch is false", async () => {
      mockGenerateObject.mockResolvedValueOnce({
        object: { result: "structured" },
        usage: { inputTokens: 100, outputTokens: 50 },
      } as any);

      const result = await llm.generate({
        systemPrompt: "test",
        userMessage: "test",
        schema: testSchema,
      });

      expect(result.data).toEqual({ result: "structured" });
      expect(mockGenerateObject).toHaveBeenCalledTimes(1);
      expect(mockGenerateText).not.toHaveBeenCalled();
    });

    it("routes to web search when enableWebSearch is true", async () => {
      // Pass 1: search
      mockGenerateText.mockResolvedValueOnce({
        text: "search results",
        usage: { inputTokens: 100, outputTokens: 50 },
      } as any);
      // Pass 2: structure
      mockGenerateObject.mockResolvedValueOnce({
        object: { result: "from search" },
        usage: { inputTokens: 200, outputTokens: 100 },
      } as any);

      const result = await llm.generate({
        systemPrompt: "test",
        userMessage: "test",
        schema: testSchema,
        enableWebSearch: true,
      });

      expect(result.data).toEqual({ result: "from search" });
      expect(mockGenerateText).toHaveBeenCalledTimes(1); // Pass 1 only
      expect(mockGenerateObject).toHaveBeenCalledTimes(1); // Pass 2 only
    });
  });

  describe("generateWithSearch()", () => {
    it("accumulates usage from both passes", async () => {
      mockGenerateText.mockResolvedValueOnce({
        text: "results",
        usage: { inputTokens: 100, outputTokens: 50 },
      } as any);
      mockGenerateObject.mockResolvedValueOnce({
        object: { result: "ok" },
        usage: { inputTokens: 200, outputTokens: 100 },
      } as any);

      const result = await llm.generate({
        systemPrompt: "sys",
        userMessage: "msg",
        schema: testSchema,
        enableWebSearch: true,
      });

      expect(result.usage.inputTokens).toBe(300);
      expect(result.usage.outputTokens).toBe(150);
    });

    it("throws when Pass 1 returns no text", async () => {
      mockGenerateText.mockResolvedValueOnce({
        text: "",
        usage: { inputTokens: 0, outputTokens: 0 },
      } as any);

      await expect(
        llm.generate({
          systemPrompt: "test",
          userMessage: "test",
          schema: testSchema,
          enableWebSearch: true,
        }),
      ).rejects.toThrow("anthropic web search returned no text content");
    });

    it("throws when Pass 2 fails after all retries", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Pass 1: success
      mockGenerateText.mockResolvedValueOnce({
        text: "some results",
        usage: { inputTokens: 100, outputTokens: 50 },
      } as any);
      // Pass 2: fails 3 times (1 initial + 2 retries)
      for (let i = 0; i < 3; i++) {
        mockGenerateObject.mockResolvedValueOnce({
          object: null,
          usage: { inputTokens: 100, outputTokens: 50 },
        } as any);
      }

      await expect(
        llm.generate({
          systemPrompt: "test",
          userMessage: "test",
          schema: testSchema,
          enableWebSearch: true,
        }),
      ).rejects.toThrow("anthropic did not return structured output from search results");

      // Pass 1 called once, Pass 2 called 3 times (1 + 2 retries)
      expect(mockGenerateText).toHaveBeenCalledTimes(1);
      expect(mockGenerateObject).toHaveBeenCalledTimes(3);
      warnSpy.mockRestore();
    });

    it("retries Pass 2 without re-running Pass 1 (saves search credits)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Pass 1: success
      mockGenerateText.mockResolvedValueOnce({
        text: "search results",
        usage: { inputTokens: 100, outputTokens: 50 },
      } as any);
      // Pass 2 attempt 1: fails
      mockGenerateObject.mockResolvedValueOnce({
        object: null,
        usage: { inputTokens: 100, outputTokens: 50 },
      } as any);
      // Pass 2 attempt 2: succeeds
      mockGenerateObject.mockResolvedValueOnce({
        object: { result: "ok" },
        usage: { inputTokens: 100, outputTokens: 50 },
      } as any);

      const result = await llm.generate({
        systemPrompt: "test",
        userMessage: "test",
        schema: testSchema,
        enableWebSearch: true,
      });

      expect(result.data).toEqual({ result: "ok" });
      // Pass 1 once + Pass 2 twice (NOT re-running Pass 1)
      expect(mockGenerateText).toHaveBeenCalledTimes(1);
      expect(mockGenerateObject).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Pass 2 (structure) failed"));
      warnSpy.mockRestore();
    });

    it("passes search tools to Pass 1", async () => {
      mockGenerateText.mockResolvedValueOnce({
        text: "results",
        usage: { inputTokens: 100, outputTokens: 50 },
      } as any);
      mockGenerateObject.mockResolvedValueOnce({
        object: { result: "ok" },
        usage: { inputTokens: 100, outputTokens: 50 },
      } as any);

      await llm.generate({
        systemPrompt: "test",
        userMessage: "test",
        schema: testSchema,
        enableWebSearch: true,
      });

      const pass1Call = mockGenerateText.mock.calls[0]![0] as any;
      expect(pass1Call.tools).toEqual({ test_search: {} });
    });
  });

  describe("generateStructured()", () => {
    it("returns structured output with usage", async () => {
      mockGenerateObject.mockResolvedValueOnce({
        object: { result: "hello" },
        usage: { inputTokens: 500, outputTokens: 200 },
      } as any);

      const result = await llm.generate({
        systemPrompt: "sys",
        userMessage: "msg",
        schema: testSchema,
      });

      expect(result.data).toEqual({ result: "hello" });
      expect(result.usage).toEqual({ inputTokens: 500, outputTokens: 200 });
    });

    it("throws when output is null after exhausting retries", async () => {
      // Persistent (not Once) so every retry attempt also returns a null object.
      mockGenerateObject.mockResolvedValue({
        object: null,
        usage: { inputTokens: 100, outputTokens: 50 },
      } as any);

      await expect(
        llm.generate({
          systemPrompt: "test",
          userMessage: "test",
          schema: testSchema,
        }),
      ).rejects.toThrow("anthropic did not return structured output");

      // Initial attempt + MAX_STRUCTURED_RETRIES (2)
      expect(mockGenerateObject).toHaveBeenCalledTimes(3);
    });

    it("retries structured output when a gateway model answers with prose", async () => {
      // First attempt fails like a flaky gateway model, second succeeds.
      mockGenerateObject
        .mockRejectedValueOnce(new Error("No object generated: could not parse the response."))
        .mockResolvedValueOnce({
          object: { result: "recovered" },
          usage: { inputTokens: 300, outputTokens: 100 },
        } as any);

      const result = await llm.generate({
        systemPrompt: "test",
        userMessage: "test",
        schema: testSchema,
      });

      expect(result.data).toEqual({ result: "recovered" });
      expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 100 });
      expect(mockGenerateObject).toHaveBeenCalledTimes(2);
    });

    it("adds a JSON-only reminder to the prompt on retries", async () => {
      mockGenerateObject
        .mockRejectedValueOnce(new Error("No object generated: could not parse the response."))
        .mockResolvedValueOnce({
          object: { result: "ok" },
          usage: { inputTokens: 10, outputTokens: 5 },
        } as any);

      await llm.generate({
        systemPrompt: "test",
        userMessage: "original message",
        schema: testSchema,
      });

      const firstPrompt = (mockGenerateObject.mock.calls[0]![0] as any).prompt;
      const retryPrompt = (mockGenerateObject.mock.calls[1]![0] as any).prompt;
      expect(firstPrompt).toBe("original message");
      expect(retryPrompt).toContain("original message");
      expect(retryPrompt).toContain("Respond with ONLY the JSON object");
    });
  });

  describe("search tool injection", () => {
    it("stores injected search tools in constructor", () => {
      const injected = { custom_search: {} };
      const injectedLlm = new TestLLM(injected);
      expect((injectedLlm as any).injectedSearchTools).toBe(injected);
    });

    it("uses injected tools over native tools when web search enabled", async () => {
      const injected = { injected_search: { type: "tavily" } };
      const injectedLlm = new TestLLM(injected);

      mockGenerateText.mockResolvedValueOnce({
        text: "search results",
        usage: { inputTokens: 100, outputTokens: 50 },
      } as any);
      mockGenerateObject.mockResolvedValueOnce({
        object: { result: "ok" },
        usage: { inputTokens: 100, outputTokens: 50 },
      } as any);

      await injectedLlm.generate({
        systemPrompt: "test",
        userMessage: "test",
        schema: testSchema,
        enableWebSearch: true,
      });

      const pass1Call = mockGenerateText.mock.calls[0]![0] as any;
      expect(pass1Call.tools).toEqual(injected);
    });

    it("uses native tools when no injection", async () => {
      mockGenerateText.mockResolvedValueOnce({
        text: "results",
        usage: { inputTokens: 100, outputTokens: 50 },
      } as any);
      mockGenerateObject.mockResolvedValueOnce({
        object: { result: "ok" },
        usage: { inputTokens: 100, outputTokens: 50 },
      } as any);

      await llm.generate({
        systemPrompt: "test",
        userMessage: "test",
        schema: testSchema,
        enableWebSearch: true,
      });

      const pass1Call = mockGenerateText.mock.calls[0]![0] as any;
      expect(pass1Call.tools).toEqual({ test_search: {} });
    });
  });

  describe("no-tools parametric path", () => {
    it("routes to single-pass structured output with parametric prompt when no tools", async () => {
      const noToolsLlm = new NoToolsLLM();

      mockGenerateObject.mockResolvedValueOnce({
        object: { result: "from training data" },
        usage: { inputTokens: 300, outputTokens: 100 },
      } as any);

      const result = await noToolsLlm.generate({
        systemPrompt: "Research this topic",
        userMessage: "test",
        schema: testSchema,
        enableWebSearch: true,
      });

      // Should be a single call (not two-pass)
      expect(mockGenerateObject).toHaveBeenCalledTimes(1);
      expect(mockGenerateText).not.toHaveBeenCalled();
      expect(result.data).toEqual({ result: "from training data" });

      // The system prompt should include parametric knowledge instruction
      const call = mockGenerateObject.mock.calls[0]![0] as any;
      expect(call.system).toContain("training knowledge");
    });

    it("routes to single-pass when injected tools are empty", async () => {
      const emptyToolsLlm = new TestLLM({});

      mockGenerateObject.mockResolvedValueOnce({
        object: { result: "parametric" },
        usage: { inputTokens: 100, outputTokens: 50 },
      } as any);

      await emptyToolsLlm.generate({
        systemPrompt: "test",
        userMessage: "test",
        schema: testSchema,
        enableWebSearch: true,
      });

      expect(mockGenerateObject).toHaveBeenCalledTimes(1);
    });
  });

  describe("tool-calling error fallback", () => {
    it("falls back to parametric when tool-calling error occurs", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Pass 1 fails with tool-calling error
      mockGenerateText.mockRejectedValueOnce(new Error("tools_not_supported by this model"));
      // Fallback structured call
      mockGenerateObject.mockResolvedValueOnce({
        object: { result: "fallback" },
        usage: { inputTokens: 200, outputTokens: 100 },
      } as any);

      const result = await llm.generate({
        systemPrompt: "test",
        userMessage: "test",
        schema: testSchema,
        enableWebSearch: true,
      });

      expect(result.data).toEqual({ result: "fallback" });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("does not support tool calling"),
      );

      warnSpy.mockRestore();
    });

    it("rethrows non-tool-calling errors", async () => {
      mockGenerateText.mockRejectedValueOnce(new Error("network timeout"));

      await expect(
        llm.generate({
          systemPrompt: "test",
          userMessage: "test",
          schema: testSchema,
          enableWebSearch: true,
        }),
      ).rejects.toThrow("network timeout");
    });
  });
});

describe("repairJsonText", () => {
  it("returns clean JSON unchanged", async () => {
    expect(await repairJsonText({ text: '{"result":"ok"}' })).toBe('{"result":"ok"}');
  });

  it("strips markdown code fences", async () => {
    const text = '```json\n{"result":"ok"}\n```';
    expect(await repairJsonText({ text })).toBe('{"result":"ok"}');
  });

  it("extracts a JSON object from surrounding prose", async () => {
    const text = 'Here is the JSON you asked for:\n{"result":"ok"}\nHope this helps!';
    expect(await repairJsonText({ text })).toBe('{"result":"ok"}');
  });

  it("removes trailing commas", async () => {
    const text = '{"result":"ok","items":[1,2,3,],}';
    expect(await repairJsonText({ text })).toBe('{"result":"ok","items":[1,2,3]}');
  });

  it("returns null when no JSON can be found", async () => {
    expect(await repairJsonText({ text: "sorry, I cannot produce structured output" })).toBeNull();
  });

  it("returns null when the extracted payload is not valid JSON", async () => {
    expect(await repairJsonText({ text: "{broken json" })).toBeNull();
  });
});
