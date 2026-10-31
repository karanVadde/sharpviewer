/**
 * A1: admission control for pixel work. The render semaphore bounds concurrent renders, the queue
 * is bounded (503 + Retry-After beyond it) and every render has a timeout (503). The page itself
 * (no pixels) is never gated. Own file: the limits are process-wide and tuned here.
 */

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { createApp, renderLimits, ServiceUnavailableError, withRenderSlot } from "../src/app.ts";

let baseUrl: string;
const server = createApp();
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

const defaults = { ...renderLimits };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withRenderSlot (unit)", () => {
  test("runs at most `concurrency` jobs at once, queues up to `queue`, rejects the rest immediately", async () => {
    Object.assign(renderLimits, { concurrency: 2, queue: 1, timeoutMs: 5000 });
    try {
      let running = 0,
        peak = 0;
      const job = async () => {
        running++;
        peak = Math.max(peak, running);
        await sleep(40);
        running--;
        return "ok";
      };
      const results = await Promise.allSettled([withRenderSlot(job), withRenderSlot(job), withRenderSlot(job), withRenderSlot(job)]);
      assert.equal(peak, 2, "concurrency bound");
      assert.deepEqual(
        results.map((r) => r.status),
        ["fulfilled", "fulfilled", "fulfilled", "rejected"],
      );
      const rejected = results[3] as PromiseRejectedResult;
      assert.ok(rejected.reason instanceof ServiceUnavailableError);
      assert.match(rejected.reason.message, /busy/i);
      // Slots are released: a new job runs.
      assert.equal(await withRenderSlot(job), "ok");
    } finally {
      Object.assign(renderLimits, defaults);
    }
  });

  test("a job over the timeout rejects with ServiceUnavailableError; the slot is released when the job ends", async () => {
    Object.assign(renderLimits, { concurrency: 1, queue: 0, timeoutMs: 20 });
    try {
      let finished = false;
      const slow = withRenderSlot(async () => {
        await sleep(80);
        finished = true;
      });
      await assert.rejects(slow, (e: unknown) => e instanceof ServiceUnavailableError && /timed out/.test(e.message));
      assert.equal(finished, false, "rejected before the job ended");
      // The slot is still held by the running job: the next request is refused, not queued forever.
      await assert.rejects(
        withRenderSlot(async () => 1),
        /busy/i,
      );
      await sleep(100);
      assert.equal(finished, true);
      assert.equal(await withRenderSlot(async () => 2), 2, "slot released after the job ended");
    } finally {
      Object.assign(renderLimits, defaults);
    }
  });

  test("defaults: concurrency >= 1, queue >= 1, timeout 30 s", () => {
    assert.ok(defaults.concurrency >= 1);
    assert.ok(defaults.queue >= 1);
    assert.equal(defaults.timeoutMs, 30_000);
  });
});

describe("HTTP: 503 when saturated, page never gated", () => {
  test("/image beyond the queue -> 503 + Retry-After, others 200; the page still answers 200", async () => {
    Object.assign(renderLimits, { concurrency: 1, queue: 1, timeoutMs: 30_000 });
    try {
      const heavy = "/image?image=panorama&width=4096&height=1024&wm=1&wmWidth=20%25&corners=10";
      const [a, b, c, page] = await Promise.all([
        fetch(baseUrl + heavy),
        fetch(`${baseUrl + heavy}&sharpen=1`),
        fetch(`${baseUrl + heavy}&grayscale=1`),
        fetch(`${baseUrl}/?image=panorama&width=4096`),
      ]);
      const statuses = [a.status, b.status, c.status].sort();
      assert.deepEqual(statuses, [200, 200, 503], statuses.join(","));
      const refused = [a, b, c].find((r) => r.status === 503)!;
      assert.equal(refused.headers.get("retry-after"), "1");
      assert.match(await refused.text(), /busy/i);
      assert.equal(page.status, 200, "the page (no pixel work) is not gated");
      await Promise.all([a, b, c].filter((r) => r.status === 200).map((r) => r.arrayBuffer()));
    } finally {
      Object.assign(renderLimits, defaults);
    }
  });

  test("/export and /android.zip time out -> 503", async () => {
    Object.assign(renderLimits, { concurrency: 4, queue: 8, timeoutMs: 1 });
    try {
      const exp = await fetch(`${baseUrl}/export?image=panorama&width=4096&height=1024&format=webp&wm=1&wmWidth=20%25`);
      assert.equal(exp.status, 503);
      assert.match(await exp.text(), /timed out/);
      const zip = await fetch(`${baseUrl}/android.zip?image=photo&dp=360`);
      assert.equal(zip.status, 503);
    } finally {
      Object.assign(renderLimits, defaults);
      await sleep(1500); // let the abandoned renders finish before the server closes
    }
  });
});
