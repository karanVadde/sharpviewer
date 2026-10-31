/**
 * Regenerate tests/fixtures/golden/ from the current code. Run deliberately:
 *   node tests/golden.update.ts
 * Uses an empty uploads dir and the stock watermark so the output is reproducible.
 */
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SHARP_VIEWER_UPLOADS = mkdtempSync(join(tmpdir(), "golden-uploads-"));
process.env.SHARP_VIEWER_CUSTOM_WATERMARK = join(mkdtempSync(join(tmpdir(), "golden-wm-")), "none.svg");

const { createApp } = await import("../src/app.ts");
const { GOLDEN_BINARIES, GOLDEN_PAGES, GOLDEN_ZIPS } = await import("./golden.cases.ts");
const { fetchBinary, fetchPage, fetchZip, fixtureName, fixturesDir, listen } = await import("./golden.lib.ts");

const server = createApp();
const baseUrl = await listen(server);
await rm(fixturesDir, { recursive: true, force: true });
await mkdir(fixturesDir, { recursive: true });

for (const [i, url] of GOLDEN_PAGES.entries()) {
  const { status, html } = await fetchPage(baseUrl, url);
  await writeFile(join(fixturesDir, fixtureName("page", i, "html")), `<!-- golden: ${url} status=${status} -->\n${html}`);
}
for (const [i, url] of GOLDEN_BINARIES.entries()) {
  const { bytes, ...record } = await fetchBinary(baseUrl, url);
  await writeFile(join(fixturesDir, fixtureName("bin", i, "json")), `${JSON.stringify(record, null, 2)}\n`);
  await writeFile(join(fixturesDir, fixtureName("bin", i, "bin")), bytes); // the pixels, for the tolerant compare
}
for (const [i, url] of GOLDEN_ZIPS.entries()) {
  const { bytes, ...record } = await fetchZip(baseUrl, url);
  await writeFile(join(fixturesDir, fixtureName("zip", i, "json")), `${JSON.stringify(record, null, 2)}\n`);
  await writeFile(join(fixturesDir, fixtureName("zip", i, "zip")), bytes);
}
server.close();
console.log(`generated on ${process.platform}-${process.arch}, libvips ${(await import("sharp")).default.versions.vips}`);
console.log(`golden fixtures written: ${GOLDEN_PAGES.length} pages, ${GOLDEN_BINARIES.length} binaries, ${GOLDEN_ZIPS.length} zips -> ${fixturesDir}`);
