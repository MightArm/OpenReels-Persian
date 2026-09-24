/**
 * Lightweight stage/sub-stage timing collector.
 *
 * Providers and resolvers run deep inside the pipeline where pipeline
 * callbacks are not threaded; this module lets any layer record a named
 * duration (mark) and the orchestrator drains all marks at the end of the
 * run into log.json under `timings`. Zero behavior change — pure observability.
 *
 * Marks are process-global and drained per pipeline run, so the worker's
 * `concurrency: 1` guarantees marks never interleave across jobs.
 */

export interface PerfMark {
  name: string;
  duration: number; // seconds
  detail?: string;
  at: string; // ISO timestamp when the mark completed
}

const marks: PerfMark[] = [];

/** Record a completed duration. */
export function perfMark(name: string, durationMs: number, detail?: string): void {
  marks.push({
    name,
    duration: Math.round(durationMs) / 1000,
    ...(detail !== undefined ? { detail } : {}),
    at: new Date().toISOString(),
  });
}

/** Time an async (or sync) operation and record it on completion. */
export async function perfTime<T>(
  name: string,
  fn: () => Promise<T>,
  detail?: () => string | undefined,
): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    perfMark(name, Date.now() - start, detail?.());
  }
}

/** Drain all recorded marks (clears the collector). */
export function drainPerfMarks(): PerfMark[] {
  const out = marks.slice();
  marks.length = 0;
  return out;
}

/** Test-only: clear without returning. */
export function resetPerfMarks(): void {
  marks.length = 0;
}
