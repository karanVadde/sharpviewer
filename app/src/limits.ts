import { availableParallelism } from "node:os";

/** Process-wide size limits shared by the image pipeline, exports and Android asset sets. */

/** Upper bound for any rendered side (`width`/`height`, preset sides, Android bucket px) to keep one request from exhausting memory. */
export const MAX_DIMENSION = 4096;

// ---------------------------------------------------------------------------
// Admission control for pixel work (A1)

/** Raised when a render cannot be admitted (queue full) or did not finish in time. Maps to HTTP 503. */
export class ServiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceUnavailableError";
  }
}

/**
 * Mutable on purpose (tests and operators tune it): renders running at once, renders allowed to
 * wait, and the time a render may take before the client gets a 503. Env overrides:
 * SHARP_VIEWER_CONCURRENCY, SHARP_VIEWER_QUEUE, SHARP_VIEWER_RENDER_TIMEOUT_MS.
 */
export const renderLimits = {
  concurrency: positiveInt(process.env.SHARP_VIEWER_CONCURRENCY) ?? Math.max(1, availableParallelism()),
  queue: positiveInt(process.env.SHARP_VIEWER_QUEUE) ?? 32,
  timeoutMs: positiveInt(process.env.SHARP_VIEWER_RENDER_TIMEOUT_MS) ?? 30_000,
};

function positiveInt(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return raw !== undefined && Number.isInteger(n) && n > 0 ? n : undefined;
}

let running = 0;
const waiting: Array<() => void> = [];

/** Diagnostic / test hook. */
export const renderSlotStats = { running: () => running, waiting: () => waiting.length, refused: 0, timedOut: 0 };

/**
 * Run `job` in a render slot. Beyond `concurrency` jobs wait (FIFO) up to `queue` deep; further
 * requests are refused at once. A job over `timeoutMs` rejects the caller with a 503, but keeps
 * its slot until it really ends (sharp cannot be cancelled), so the bound stays honest.
 */
export async function withRenderSlot<T>(job: () => Promise<T>): Promise<T> {
  if (running >= renderLimits.concurrency) {
    if (waiting.length >= renderLimits.queue) {
      renderSlotStats.refused += 1;
      throw new ServiceUnavailableError("The server is busy rendering other images; try again in a moment.");
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  running += 1;
  const release = () => {
    running -= 1;
    waiting.shift()?.();
  };
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      renderSlotStats.timedOut += 1;
      reject(new ServiceUnavailableError(`Rendering timed out after ${renderLimits.timeoutMs} ms; reduce the size or try again.`));
    }, renderLimits.timeoutMs);
  });
  const work = job().finally(() => {
    clearTimeout(timer);
    release();
  });
  // Swallow the late settlement of an abandoned job (it was already reported as a timeout).
  work.catch(() => {});
  return Promise.race([work, timeout]);
}
