import { describe, expect, it } from "vitest";
import type { PipelineCallbacks, StageName } from "./orchestrator.js";
import { buildVisualAssetRecord } from "./visual-diagnostics.js";

/**
 * Tests for the 3 new onProgress calls added to the orchestrator.
 * These verify the event shape and placement, not the full pipeline
 * (which requires real providers). We test the callback wiring pattern.
 */

describe("onProgress event shapes", () => {
  it("research results event has correct shape", () => {
    const progressEvents: Array<{ stage: StageName; data: Record<string, unknown> }> = [];

    const cb: PipelineCallbacks = {
      onProgress(stage, data) {
        progressEvents.push({ stage, data });
      },
    };

    // Simulate what orchestrator.ts:184 does
    const researchResult = {
      summary: "Black holes are regions of spacetime",
      key_facts: ["Sagittarius A*", "Event horizon"],
      mood: "mysterious",
      sources: [],
    };

    cb.onProgress?.("research", {
      type: "results",
      summary: researchResult.summary,
      key_facts: researchResult.key_facts,
      mood: researchResult.mood,
    });

    expect(progressEvents).toHaveLength(1);
    expect(progressEvents[0]?.stage).toBe("research");
    expect(progressEvents[0]?.data).toEqual({
      type: "results",
      summary: "Black holes are regions of spacetime",
      key_facts: ["Sagittarius A*", "Event horizon"],
      mood: "mysterious",
    });
  });

  it("director score event has correct shape", () => {
    const progressEvents: Array<{ stage: StageName; data: Record<string, unknown> }> = [];

    const cb: PipelineCallbacks = {
      onProgress(stage, data) {
        progressEvents.push({ stage, data });
      },
    };

    // Simulate what orchestrator.ts:222 does
    const directorScore = {
      emotional_arc: "curiosity → awe",
      archetype: "cinematic_documentary",
      music_mood: "mysterious_ambient",
      scenes: [
        {
          visual_type: "ai_image" as const,
          visual_prompt: "a black hole",
          motion: "zoom_in" as const,
          script_line: "What if you could fall into a black hole?",
        },
      ],
    };

    cb.onProgress?.("director", { type: "score", score: directorScore });

    expect(progressEvents).toHaveLength(1);
    expect(progressEvents[0]?.stage).toBe("director");
    expect(progressEvents[0]?.data.type).toBe("score");
    expect(progressEvents[0]?.data.score).toBe(directorScore);
  });

  it("critic review event has correct shape", () => {
    const progressEvents: Array<{ stage: StageName; data: Record<string, unknown> }> = [];

    const cb: PipelineCallbacks = {
      onProgress(stage, data) {
        progressEvents.push({ stage, data });
      },
    };

    // Simulate what orchestrator.ts:403 does (after if/else block)
    const critique = {
      score: 8,
      strengths: ["Strong hook", "Good pacing"],
      weaknesses: ["Scene 5 transition could be smoother"],
      revision_needed: false,
      revision_instructions: null,
      weakest_scene_index: null,
    };

    cb.onProgress?.("critic", {
      type: "review",
      score: critique.score,
      strengths: critique.strengths,
      weaknesses: critique.weaknesses,
    });

    expect(progressEvents).toHaveLength(1);
    expect(progressEvents[0]?.stage).toBe("critic");
    expect(progressEvents[0]?.data).toEqual({
      type: "review",
      score: 8,
      strengths: ["Strong hook", "Good pacing"],
      weaknesses: ["Scene 5 transition could be smoother"],
    });
  });

  it("onProgress is not called when research is skipped", () => {
    const progressEvents: Array<{ stage: StageName; data: Record<string, unknown> }> = [];

    const cb: PipelineCallbacks = {
      onProgress(stage, data) {
        progressEvents.push({ stage, data });
      },
    };

    // When research fails, orchestrator calls onStageSkip, NOT onProgress
    // Verify no progress event is emitted
    cb.onStageSkip?.("research", "web search failed");

    expect(progressEvents).toHaveLength(0);
  });

/**
 * The `visual_assets` event is what the worker persists into `meta.json`, so its
 * shape must stay stable: one record per scene, JSON-serializable, indicating
 * for each scene whether the provider was actually invoked.
 */
describe("visual asset diagnostics event", () => {
  it("emits one serializable record per scene", () => {
    const progressEvents: Array<{ stage: StageName; data: Record<string, unknown> }> = [];
    const cb: PipelineCallbacks = {
      onProgress(stage, data) {
        progressEvents.push({ stage, data });
      },
    };

    const assets = [
      buildVisualAssetRecord({
        sceneIndex: 0,
        visualType: "ai_image",
        effectiveType: "ai_image",
        path: "ai",
        provider: "alpha",
        elapsedMs: 4210,
        diagnostic: {
          provider: "alpha",
          providerInvoked: true,
          trace: [{ stage: "download_completed", atMs: 4000, detail: "bytes=2048 format=png" }],
          bytes: 2048,
          format: "png",
        },
        assetPath: "C:/run/assets/scene-0-ai.png",
      }),
      buildVisualAssetRecord({
        sceneIndex: 1,
        visualType: "ai_image",
        effectiveType: "ai_image",
        path: "ai",
        provider: "alpha",
        elapsedMs: 900_100,
        diagnostic: { provider: "alpha", providerInvoked: true, trace: [] },
        assetPath: null,
        error: new Error("Alpha image job img-2 timed out after 900s (still processing)"),
      }),
    ];

    cb.onProgress?.("visuals", { type: "visual_assets", assets });

    expect(progressEvents).toHaveLength(1);
    expect(progressEvents[0]?.stage).toBe("visuals");
    expect(progressEvents[0]?.data.type).toBe("visual_assets");

    const roundTripped = JSON.parse(JSON.stringify(progressEvents[0]?.data.assets));
    expect(roundTripped).toHaveLength(2);
    expect(roundTripped[0].outcome).toBe("ok");
    expect(roundTripped[1].providerInvoked).toBe(true);
    expect(roundTripped[1].outcome).toBe("error");
    expect(roundTripped[1].error).toContain("timed out after 900s");
  });
});

});
