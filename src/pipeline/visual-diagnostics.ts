/**
 * Per-scene visual-asset diagnostics.
 *
 * The pipeline converts any per-scene visual failure into `null` and keeps
 * rendering, which is why a failed AI image shows up only as a black beat.
 * Historically nothing about the attempt was persisted, so "was the provider
 * even called?" could not be answered after the fact.
 *
 * These records are written to `log.json` (`visualAssets`) and, for web jobs,
 * to `meta.json`, so the next failure is conclusive: scene id, authored vs
 * effective visual type, selected provider, whether the provider was actually
 * invoked, the provider-side trace, the resolved file and its size, the error,
 * the stack, and the elapsed time.
 */

/** One step of a visual asset's lifecycle. `detail` must never contain secrets. */
export interface VisualTraceEvent {
  stage: string;
  atMs: number;
  detail?: string;
}

/** Diagnostics for one provider invocation (AI image generation). */
export interface VisualAssetDiagnostic {
  /** Image provider key that was selected for this scene (`alpha`, `gemini`, …). */
  provider: string;
  /**
   * True once execution entered the provider's `generate()`. This is the field
   * that answers "was Alpha actually called?" for a failed scene.
   */
  providerInvoked: boolean;
  trace: VisualTraceEvent[];
  /** Bytes returned by the provider, when it returned. */
  bytes?: number | null;
  /** Detected container of the returned bytes (`png`, `jpeg`, …). */
  format?: string | null;
  /** Absolute path of the asset written for this scene, when one was written. */
  assetPath?: string | null;
  /** Size on disk after writing the asset. */
  fileSize?: number | null;
}

export type VisualAssetOutcome = "ok" | "no_asset" | "error";

/** Durable, per-scene record of how a visual asset resolved. */
export interface VisualAssetRecord {
  sceneIndex: number;
  /** `visual_type` as authored by the Creative Director. */
  visualType: string;
  /** Visual type after Stock Only remapping (equals `visualType` when off). */
  effectiveType: string;
  /** `ai` for AI image generation, `stock` for stock search, `none` for text cards. */
  path: "ai" | "stock" | "none";
  /** Selected provider for this scene (`alpha`, `gemini`, `pexels`+`pixabay`, …). */
  provider: string;
  /** Whether the selected provider was actually invoked. */
  providerInvoked: boolean;
  /** Stock resolution method when this was a stock scene. */
  stockMethod?: string;
  outcome: VisualAssetOutcome;
  assetPath?: string | null;
  bytes?: number | null;
  fileSize?: number | null;
  error?: string;
  stack?: string;
  elapsedMs: number;
  trace: VisualTraceEvent[];
}

/**
 * Error wrapper that carries the visual diagnostics with it, so a failure that
 * propagates out of `resolveVisualAsset()` still reaches the visuals step with
 * the evidence of whether the provider was invoked.
 */
export class VisualAssetError extends Error {
  readonly diagnostic: VisualAssetDiagnostic;

  constructor(message: string, diagnostic: VisualAssetDiagnostic) {
    super(message);
    this.name = "VisualAssetError";
    this.diagnostic = diagnostic;
  }
}

export interface VisualTrace {
  events: VisualTraceEvent[];
  push(stage: string, detail?: string): void;
  elapsedMs(): number;
}

/**
 * Create a trace whose `atMs` values are elapsed milliseconds since creation,
 * so the log is readable without cross-referencing wall-clock timestamps.
 */
export function createVisualTrace(): VisualTrace {
  const startedAt = Date.now();
  const events: VisualTraceEvent[] = [];
  return {
    events,
    push(stage, detail) {
      events.push({ stage, atMs: Date.now() - startedAt, ...(detail ? { detail } : {}) });
    },
    elapsedMs() {
      return Date.now() - startedAt;
    },
  };
}

export interface BuildVisualAssetRecordInput {
  sceneIndex: number;
  visualType: string;
  effectiveType: string;
  path: "ai" | "stock" | "none";
  provider: string;
  elapsedMs: number;
  diagnostic?: VisualAssetDiagnostic;
  /** Asset path resolved for this scene (null when nothing was produced). */
  assetPath?: string | null;
  stockMethod?: string;
  error?: unknown;
}

/**
 * Assemble the durable record for one scene from whatever the dispatch managed
 * to produce (an asset, a diagnostic, or an error).
 */
export function buildVisualAssetRecord(input: BuildVisualAssetRecordInput): VisualAssetRecord {
  const diagnostic = input.diagnostic;
  const assetPath = input.assetPath ?? diagnostic?.assetPath ?? null;

  const record: VisualAssetRecord = {
    sceneIndex: input.sceneIndex,
    visualType: input.visualType,
    effectiveType: input.effectiveType,
    path: input.path,
    provider: input.provider,
    providerInvoked: resolveProviderInvoked(input, diagnostic),
    outcome: resolveOutcome(input.error, assetPath),
    assetPath,
    elapsedMs: input.elapsedMs,
    trace: diagnostic?.trace ?? [],
  };

  if (input.stockMethod) record.stockMethod = input.stockMethod;
  if (diagnostic?.bytes != null) record.bytes = diagnostic.bytes;
  if (diagnostic?.fileSize != null) record.fileSize = diagnostic.fileSize;
  if (input.error) Object.assign(record, describeFailure(input.error));

  return record;
}

/**
 * Whether the provider was actually reached.
 *
 * A missing diagnostic means execution never produced one, so the only way to
 * answer "was it invoked?" is the fallback below: the stock resolver's AI
 * fallback calls the image provider itself, which counts as invoked.
 */
function resolveProviderInvoked(
  input: BuildVisualAssetRecordInput,
  diagnostic: VisualAssetDiagnostic | undefined,
): boolean {
  if (diagnostic) return diagnostic.providerInvoked;
  return input.path === "stock" && input.stockMethod === "ai_fallback";
}

function resolveOutcome(error: unknown, assetPath: string | null): VisualAssetOutcome {
  if (error) return "error";
  return assetPath ? "ok" : "no_asset";
}

/** Message (+ stack when available) of whatever rejected the scene. */
function describeFailure(error: unknown): { error: string; stack?: string } {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  return stack ? { error: message, stack } : { error: message };
}

/**
 * One-line-per-problem summary of a run's visual assets. Returns an empty
 * string when every scene resolved, so callers can log unconditionally.
 */
export function summarizeVisualAssets(records: VisualAssetRecord[]): string {
  const failures = records.filter((r) => r.outcome !== "ok" && r.path !== "none");
  if (failures.length === 0) return "";

  const lines = [
    `[visuals] ${failures.length} of ${records.length} scenes produced no visual asset:`,
  ];
  for (const r of failures) {
    const invoked = r.providerInvoked
      ? `provider "${r.provider}" WAS invoked`
      : `provider "${r.provider}" was NOT invoked`;
    const remap = r.effectiveType !== r.visualType ? ` -> ${r.effectiveType}` : "";
    lines.push(
      `  scene ${r.sceneIndex} (${r.visualType}${remap}): ${r.outcome}; ${invoked}; ` +
        `${r.error ?? "no error reported"} [${Math.round(r.elapsedMs)}ms]`,
    );
  }
  return lines.join("\n");
}
