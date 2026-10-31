/**
 * Server-side LRU for rendered outputs (A4). Keyed by the caller on the normalised options plus
 * the file keys of the source and the watermark, so a changed upload or mark is a different key;
 * stale entries simply age out. Bounded by entry count and total bytes. The HTTP responses keep
 * `Cache-Control: no-store`: this cache is the server's, not the browser's.
 */

export interface CacheEntry {
  bytes: Buffer;
  /** Small extra values that belong to the output (export quality, warning, filename). */
  meta?: Record<string, string | number | undefined>;
}

const entries = new Map<string, CacheEntry>();
let totalBytes = 0;

/** Mutable on purpose (tests and operators tune it). Env overrides: SHARP_VIEWER_CACHE_ENTRIES, SHARP_VIEWER_CACHE_MB. */
export const renderCache = {
  maxEntries: positiveInt(process.env.SHARP_VIEWER_CACHE_ENTRIES) ?? 64,
  maxBytes: (positiveInt(process.env.SHARP_VIEWER_CACHE_MB) ?? 256) * 1024 * 1024,
  size: () => entries.size,
  bytes: () => totalBytes,
  clear: () => {
    entries.clear();
    totalBytes = 0;
  },
};

export const renderCacheStats = { hits: 0, misses: 0 };

function positiveInt(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return raw !== undefined && Number.isInteger(n) && n > 0 ? n : undefined;
}

function evictUntilFits(incoming: number): void {
  while (entries.size > 0 && (entries.size >= renderCache.maxEntries || totalBytes + incoming > renderCache.maxBytes)) {
    const oldest = entries.keys().next().value as string;
    totalBytes -= entries.get(oldest)!.bytes.length;
    entries.delete(oldest);
  }
}

/** Get-or-compute. Concurrent identical misses each compute (simple; renders are already gated). */
export async function cached(key: string, compute: () => Promise<CacheEntry>): Promise<CacheEntry> {
  const hit = entries.get(key);
  if (hit) {
    // Refresh recency.
    entries.delete(key);
    entries.set(key, hit);
    renderCacheStats.hits += 1;
    return hit;
  }
  renderCacheStats.misses += 1;
  const entry = await compute();
  if (entry.bytes.length <= renderCache.maxBytes) {
    evictUntilFits(entry.bytes.length);
    entries.set(key, entry);
    totalBytes += entry.bytes.length;
  }
  return entry;
}
