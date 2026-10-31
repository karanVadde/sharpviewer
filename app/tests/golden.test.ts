/**
 * Golden fixtures: every page, image, export and ZIP in tests/golden.cases.ts must match
 * tests/fixtures/golden/. Pages: byte for byte. Images (standalone and inside ZIPs): identical
 * bytes on the platform that generated the fixtures; elsewhere within a small pixel tolerance,
 * because libvips is not bit-exact across CPU architectures (incident I-7). Fixtures that needed
 * the tolerance are listed at the end of the run so a platform split is always visible.
 * This is the "existing functionality does not break" gate. See golden.update.ts.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

process.env.SHARP_VIEWER_UPLOADS = mkdtempSync(join(tmpdir(), "golden-uploads-"));
process.env.SHARP_VIEWER_CUSTOM_WATERMARK = join(mkdtempSync(join(tmpdir(), "golden-wm-")), "none.svg");

const { createApp } = await import("../src/app.ts");
const { GOLDEN_BINARIES, GOLDEN_PAGES, GOLDEN_ZIPS } = await import("./golden.cases.ts");
const { fetchBinary, fetchPage, fetchZip, fixtureName, fixturesDir, isImageEntry, listen } = await import("./golden.lib.ts");
const { compareImages, describeComparison } = await import("./golden.compare.ts");
const { readZip } = await import("../src/zip.ts");

/** Fixtures that matched only within tolerance on this machine (platform rounding). */
const tolerated: string[] = [];

const server = createApp();
let baseUrl: string;
before(async () => {
  baseUrl = await listen(server);
});
after(() => {
  server.close();
  if (tolerated.length) {
    console.log(
      `\n[golden] ${tolerated.length} fixture(s) matched within pixel tolerance on ${process.platform}-${process.arch} (platform rounding, not a regression):\n  ${tolerated.join("\n  ")}\n`,
    );
  }
});

describe("golden: pages", () => {
  for (const [i, url] of GOLDEN_PAGES.entries()) {
    test(`${url} matches ${fixtureName("page", i, "html")}`, async () => {
      const expected = await readFile(join(fixturesDir, fixtureName("page", i, "html")), "utf8");
      const { status, html } = await fetchPage(baseUrl, url);
      assert.equal(`<!-- golden: ${url} status=${status} -->\n${html}`, expected);
    });
  }
});

describe("golden: images and exports", () => {
  for (const [i, url] of GOLDEN_BINARIES.entries()) {
    test(`${url} matches ${fixtureName("bin", i, "json")}`, async () => {
      const expected = JSON.parse(await readFile(join(fixturesDir, fixtureName("bin", i, "json")), "utf8"));
      const { bytes, ...actual } = await fetchBinary(baseUrl, url);
      // Status, type and contract headers are exact.
      assert.deepEqual(
        { url: actual.url, status: actual.status, contentType: actual.contentType, headers: actual.headers },
        { url: expected.url, status: expected.status, contentType: expected.contentType, headers: expected.headers },
      );
      if (actual.sha256 === expected.sha256 && actual.size === expected.size) return;
      const comparison = await compareImages(bytes, await readFile(join(fixturesDir, fixtureName("bin", i, "bin"))));
      const report = `${url}: ${describeComparison(comparison)} (got ${actual.size} B ${actual.sha256.slice(0, 12)}, fixture ${expected.size} B ${expected.sha256.slice(0, 12)})`;
      assert.ok(comparison.withinTolerance, report);
      tolerated.push(report);
    });
  }
});

describe("golden: android zips", () => {
  for (const [i, url] of GOLDEN_ZIPS.entries()) {
    test(`${url} matches ${fixtureName("zip", i, "json")}`, async () => {
      const expected = JSON.parse(await readFile(join(fixturesDir, fixtureName("zip", i, "json")), "utf8"));
      const { bytes, ...actual } = await fetchZip(baseUrl, url);
      assert.deepEqual(
        { url: actual.url, status: actual.status, filename: actual.filename, warnings: actual.warnings, readme: actual.readme },
        { url: expected.url, status: expected.status, filename: expected.filename, warnings: expected.warnings, readme: expected.readme },
      );
      assert.deepEqual(
        actual.entries.map((e) => e.name),
        expected.entries.map((e: { name: string }) => e.name),
        "entry names and order",
      );
      const exact = actual.entries.every((e, k) => e.sha256 === expected.entries[k].sha256 && e.size === expected.entries[k].size);
      if (exact) return;
      const fixtureEntries = readZip(await readFile(join(fixturesDir, fixtureName("zip", i, "zip"))));
      const actualEntries = readZip(bytes);
      const reports: string[] = [];
      for (const [k, e] of actual.entries.entries()) {
        if (e.sha256 === expected.entries[k].sha256) continue;
        assert.ok(isImageEntry(e.name), `${url}: non-image entry ${e.name} differs`);
        const comparison = await compareImages(actualEntries[k]!.data, fixtureEntries[k]!.data);
        assert.ok(comparison.withinTolerance, `${url} ${e.name}: ${describeComparison(comparison)}`);
        reports.push(`${e.name}: ${describeComparison(comparison)}`);
      }
      tolerated.push(`${url}: ${reports.join("; ")}`);
    });
  }
});
