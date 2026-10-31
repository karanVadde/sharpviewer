/**
 * A11: security headers (CSP with a per-request nonce for the one inline script), the upload
 * quota with oldest-first eviction, and the non-loopback host warning.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";

const dir = mkdtempSync(join(tmpdir(), "security-uploads-"));
process.env.SHARP_VIEWER_UPLOADS = dir;
const app = await import("../src/app.ts");
const images = await import("../src/images.ts");
const { hostWarning, isLoopback } = await import("../src/host.ts");

let baseUrl: string;
let server: Server;
before(async () => {
  server = app.createApp();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  rmSync(dir, { recursive: true, force: true });
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

describe("security headers", () => {
  test("HTML pages carry a CSP whose script nonce matches the inline script; no other script is allowed", async () => {
    const r = await fetch(`${baseUrl}/?wm=1`);
    const csp = r.headers.get("content-security-policy") ?? "";
    const html = await r.text();
    const nonce = /script-src 'nonce-([A-Za-z0-9+/=_-]+)'/.exec(csp)?.[1];
    assert.ok(nonce, csp);
    assert.match(html, new RegExp(`<script nonce="${nonce}">`));
    assert.doesNotMatch(csp, /unsafe-inline'[^;]*;[^;]*script|script-src[^;]*unsafe-inline/, "scripts: nonce only");
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /base-uri 'none'/);
    assert.match(csp, /form-action 'self'/);
    assert.match(csp, /frame-ancestors 'self'/, "the device frame iframes the page itself");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("referrer-policy"), "no-referrer");
    const again = await fetch(`${baseUrl}/`);
    const nonce2 = /nonce-([^']+)'/.exec(again.headers.get("content-security-policy") ?? "")?.[1];
    assert.notEqual(nonce, nonce2, "a fresh nonce per response");
  });

  test("the image-only page and the docs get the same policy; images and downloads get nosniff", async () => {
    for (const path of ["/?embed=image", "/guide", "/spec"]) {
      const r = await fetch(baseUrl + path);
      assert.match(r.headers.get("content-security-policy") ?? "", /default-src 'self'/, path);
    }
    for (const path of ["/image", "/export?format=jpeg", "/android/icon-preview", "/SPEC.md"]) {
      const r = await fetch(baseUrl + path);
      assert.equal(r.headers.get("x-content-type-options"), "nosniff", path);
      await r.arrayBuffer();
    }
  });
});

describe("upload quota", () => {
  const make = (w: number) =>
    sharp({ create: { width: w, height: 64, channels: 3, background: "#808080", noise: { type: "gaussian", mean: 128, sigma: 40 } } })
      .png()
      .toBuffer();
  async function upload(name: string, bytes: Buffer) {
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(bytes)], { type: "image/png" }), name);
    const r = await fetch(`${baseUrl}/upload`, { method: "POST", body: fd, redirect: "manual" });
    return { status: r.status, id: new URL(r.headers.get("location") ?? "/", baseUrl).searchParams.get("image"), html: await r.text() };
  }

  test("oldest uploads are evicted to stay under the quota; a single file over the quota is refused", async () => {
    const saved = images.uploadLimits.quotaBytes;
    try {
      const a = await make(200),
        b = await make(210),
        c = await make(220);
      images.uploadLimits.quotaBytes = a.length + b.length + Math.floor(c.length / 2);
      const ra = await upload("a.png", a);
      await new Promise((r) => setTimeout(r, 5));
      const rb = await upload("b.png", b);
      await new Promise((r) => setTimeout(r, 5));
      const rc = await upload("c.png", c);
      assert.deepEqual([ra.status, rb.status, rc.status], [303, 303, 303]);
      const ids = (await images.listUploads()).map((u) => u.id);
      assert.ok(!ids.includes(ra.id!), "oldest (a) evicted");
      assert.ok(ids.includes(rb.id!) && ids.includes(rc.id!));
      assert.ok(
        readdirSync(dir).every((f) => !f.startsWith(ra.id!)),
        "both files of the evicted upload are gone",
      );
      images.uploadLimits.quotaBytes = 100;
      const huge = await upload("huge.png", c);
      assert.equal(huge.status, 400);
      assert.match(huge.html, /quota/);
    } finally {
      images.uploadLimits.quotaBytes = saved;
    }
  });
});

describe("host binding", () => {
  test("loopback detection and the warning text", () => {
    for (const h of ["127.0.0.1", "::1", "localhost", "127.5.5.5", "[::1]"]) assert.equal(isLoopback(h), true, h);
    for (const h of ["0.0.0.0", "::", "192.168.1.5", "example.com", ""]) assert.equal(isLoopback(h), false, h);
    assert.equal(hostWarning("127.0.0.1"), null);
    assert.match(hostWarning("0.0.0.0") ?? "", /WARNING.*0\.0\.0\.0[\s\S]*no authentication[\s\S]*shared uploads/i);
  });
});
