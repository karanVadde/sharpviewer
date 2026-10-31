/**
 * A4: server-side render cache. Identical requests are served from memory (keyed on the
 * normalised options + the source / watermark file keys), so a second Apply or a Mobile-view
 * reload does not redo the pipeline. Own file: the cache is process-wide and tuned here.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

process.env.SHARP_VIEWER_CUSTOM_WATERMARK = join(mkdtempSync(join(tmpdir(), "cache-wm-")), "custom.svg");
const { createApp, pipelineStats, renderCache, renderCacheStats, restoreStockWatermark, setCustomWatermarkText } = await import("../src/app.ts");

let baseUrl: string;
const server = createApp();
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await restoreStockWatermark();
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

const get = async (path: string) => {
  const r = await fetch(baseUrl + path);
  return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()), headers: r.headers };
};

describe("render cache", () => {
  test("second identical /image request is a hit: same bytes, no pipeline run, still no-store for the browser", async () => {
    const url = "/image?image=photo&width=600&wm=1&wmWidth=20%25&corners=20";
    const first = await get(url);
    const renders = pipelineStats.stage1Renders,
      hits = renderCacheStats.hits;
    const second = await get(url);
    assert.equal(second.status, 200);
    assert.ok(first.bytes.equals(second.bytes));
    assert.equal(pipelineStats.stage1Renders, renders, "no new render");
    assert.equal(renderCacheStats.hits, hits + 1);
    assert.equal(second.headers.get("cache-control"), "no-store");
    // Same options spelled differently normalise to the same key.
    const reordered = await get("/image?wm=on&corners=20&image=photo&wmWidth=20%25&width=600");
    assert.ok(reordered.bytes.equals(first.bytes));
    assert.equal(pipelineStats.stage1Renders, renders, "reordered / re-spelled query is still a hit");
  });

  test("a changed watermark busts the cache; exports are keyed on format/quality/maxKB too", async () => {
    const url = "/image?image=thumb&wm=1&wmWidth=50%25";
    const stock = await get(url);
    await setCustomWatermarkText("CACHE");
    try {
      const custom = await get(url);
      assert.ok(!stock.bytes.equals(custom.bytes), "new mark, new pixels");
      const again = await get(url);
      assert.ok(again.bytes.equals(custom.bytes));
    } finally {
      await restoreStockWatermark();
    }
    const back = await get(url);
    assert.ok(back.bytes.equals(stock.bytes), "restoring the stock mark serves the stock render again");

    const q80 = await get("/export?image=thumb&format=jpeg&quality=80");
    const q80again = await get("/export?image=thumb&format=jpeg&quality=80");
    const q60 = await get("/export?image=thumb&format=jpeg&quality=60");
    assert.ok(q80.bytes.equals(q80again.bytes));
    assert.equal(q80again.headers.get("x-export-quality"), "80");
    assert.equal(q80again.headers.get("content-disposition"), q80.headers.get("content-disposition"));
    assert.ok(!q80.bytes.equals(q60.bytes));
  });

  test("LRU eviction by entry count and by byte budget", async () => {
    const saved = { ...renderCache };
    try {
      Object.assign(renderCache, { maxEntries: 2, maxBytes: 50 * 1024 * 1024 });
      renderCache.clear();
      await get("/image?image=thumb&width=100");
      await get("/image?image=thumb&width=101");
      await get("/image?image=thumb&width=102"); // evicts width=100
      const renders = pipelineStats.stage1Renders,
        misses = renderCacheStats.misses;
      await get("/image?image=thumb&width=102&wm=1"); // new
      assert.equal(renderCacheStats.misses, misses + 1);
      await get("/image?image=thumb&width=100"); // evicted -> miss
      assert.equal(renderCacheStats.misses, misses + 2);
      assert.equal(renderCache.size(), 2);

      Object.assign(renderCache, { maxEntries: 64, maxBytes: 1 });
      renderCache.clear();
      await get("/image?image=thumb&width=100");
      assert.equal(renderCache.size(), 0, "an entry over the byte budget is not kept");
      void renders;
    } finally {
      Object.assign(renderCache, saved);
      renderCache.clear();
    }
  });
});
