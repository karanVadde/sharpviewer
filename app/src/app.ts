/**
 * Public façade. The implementation lives in focused modules (see SPEC.md section 7):
 * params -> geometry -> watermark -> pipeline -> android-zip -> page -> docs -> router.
 * Everything that used to be exported from here is re-exported so callers (and the tests)
 * keep one stable import path.
 */

export * from "./android-zip.ts";
export { renderCache, renderCacheStats } from "./cache.ts";
export { cellRects, clampNudge, coverScaled, findLayout, LAYOUTS, nudgeRange } from "./collage.ts";
export * from "./docs.ts";
export { BadRequestError } from "./errors.ts";
export * from "./geometry.ts";
export { MAX_DIMENSION, renderLimits, renderSlotStats, ServiceUnavailableError, withRenderSlot } from "./limits.ts";
export * from "./page/render.ts";
export * from "./params.ts";
export * from "./pipeline.ts";
export * from "./router.ts";
export * from "./watermark.ts";
