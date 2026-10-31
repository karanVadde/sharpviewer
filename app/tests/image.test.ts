import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";
import { createApp, MAX_DIMENSION } from "../src/app.ts";

// Known dimensions of public/sample.png.
const ORIGINAL_WIDTH = 960;
const ORIGINAL_HEIGHT = 640;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Read width/height from the PNG IHDR chunk, which always directly follows the
 * 8-byte signature: 4 bytes length, 4 bytes "IHDR", then width and height as
 * big-endian uint32. No image library required.
 */
function pngDimensions(png: Buffer): { width: number; height: number } {
  assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE), "response is not a PNG");
  assert.equal(png.toString("ascii", 12, 16), "IHDR", "first chunk is not IHDR");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

// sharp is only used here: decoding PNG pixel data so rotation *content* can be
// verified (a 180° rotation has identical dimensions to the original).
async function decodePixels(png: Buffer) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const pixelAt = (x: number, y: number): string => {
    const offset = (y * info.width + x) * info.channels;
    return data.subarray(offset, offset + info.channels).join(",");
  };
  return { width: info.width, height: info.height, pixelAt };
}

let baseUrl: string;
const server = createApp();

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // Node's runner can run `after` before `before` finishes when a --test-name-pattern matches
  // nothing in this file; unref so an unclosed server can never keep the process alive.
  server.unref();
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  // With a non-matching --test-name-pattern this may run before the server is listening.
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

async function fetchImage(query = ""): Promise<{ status: number; type: string | null; body: Buffer }> {
  const response = await fetch(`${baseUrl}/image${query}`);
  return {
    status: response.status,
    type: response.headers.get("content-type"),
    body: Buffer.from(await response.arrayBuffer()),
  };
}

describe("GET /image – default", () => {
  test("serves the original image as PNG at its native size", async () => {
    const { status, type, body } = await fetchImage();
    assert.equal(status, 200);
    assert.equal(type, "image/png");
    assert.deepEqual(pngDimensions(body), { width: ORIGINAL_WIDTH, height: ORIGINAL_HEIGHT });
  });
});

describe("GET /image – sizes", () => {
  const widthCases = [1, 120, 480, 960, 1920];
  for (const width of widthCases) {
    test(`width=${width} keeps aspect ratio`, async () => {
      const { status, body } = await fetchImage(`?width=${width}`);
      assert.equal(status, 200);
      const dims = pngDimensions(body);
      assert.equal(dims.width, width);
      assert.equal(dims.height, Math.max(1, Math.round((width * ORIGINAL_HEIGHT) / ORIGINAL_WIDTH)));
    });
  }

  const heightCases = [1, 80, 320, 640, 1280];
  for (const height of heightCases) {
    test(`height=${height} keeps aspect ratio`, async () => {
      const { status, body } = await fetchImage(`?height=${height}`);
      assert.equal(status, 200);
      const dims = pngDimensions(body);
      assert.equal(dims.height, height);
      assert.equal(dims.width, Math.max(1, Math.round((height * ORIGINAL_WIDTH) / ORIGINAL_HEIGHT)));
    });
  }

  test("width and height together give the exact size requested", async () => {
    const { status, body } = await fetchImage("?width=300&height=300");
    assert.equal(status, 200);
    assert.deepEqual(pngDimensions(body), { width: 300, height: 300 });
  });

  test(`width=${MAX_DIMENSION} (upper bound) is accepted`, async () => {
    const { status, body } = await fetchImage(`?width=${MAX_DIMENSION}`);
    assert.equal(status, 200);
    assert.equal(pngDimensions(body).width, MAX_DIMENSION);
  });

  for (const bad of ["0", "-1", "1.5", "abc", String(MAX_DIMENSION + 1)]) {
    test(`width=${bad} is rejected with 400`, async () => {
      const { status, type } = await fetchImage(`?width=${bad}`);
      assert.equal(status, 400);
      assert.match(type ?? "", /^text\/plain/);
    });
  }
});

describe("GET /image – rotation", () => {
  let original: Awaited<ReturnType<typeof decodePixels>>;
  const samplePoints: Array<[number, number]> = [
    [0, 0],
    [10, 20],
    [123, 456],
    [500, 300],
  ];

  before(async () => {
    original = await decodePixels((await fetchImage()).body);
  });

  test("rotate=90 swaps width and height", async () => {
    const { status, body } = await fetchImage("?rotate=90");
    assert.equal(status, 200);
    assert.deepEqual(pngDimensions(body), { width: ORIGINAL_HEIGHT, height: ORIGINAL_WIDTH });
  });

  test("rotate=90 is a clockwise rotation (pixel check)", async () => {
    const rotated = await decodePixels((await fetchImage("?rotate=90")).body);
    // Clockwise 90°: new(x, y) == old(y, H - 1 - x)
    for (const [x, y] of samplePoints) {
      assert.equal(rotated.pixelAt(x, y), original.pixelAt(y, ORIGINAL_HEIGHT - 1 - x), `pixel (${x},${y})`);
    }
  });

  test("rotate=180 keeps width and height", async () => {
    const { status, body } = await fetchImage("?rotate=180");
    assert.equal(status, 200);
    assert.deepEqual(pngDimensions(body), { width: ORIGINAL_WIDTH, height: ORIGINAL_HEIGHT });
  });

  test("rotate=180 flips the image (pixel check)", async () => {
    const rotated = await decodePixels((await fetchImage("?rotate=180")).body);
    // 180°: new(x, y) == old(W - 1 - x, H - 1 - y)
    for (const [x, y] of samplePoints) {
      assert.equal(rotated.pixelAt(x, y), original.pixelAt(ORIGINAL_WIDTH - 1 - x, ORIGINAL_HEIGHT - 1 - y), `pixel (${x},${y})`);
    }
  });

  test("rotate=270 swaps width and height", async () => {
    const { body } = await fetchImage("?rotate=270");
    assert.deepEqual(pngDimensions(body), { width: ORIGINAL_HEIGHT, height: ORIGINAL_WIDTH });
  });

  test("rotate=0 is the same as no rotation", async () => {
    const plain = await fetchImage();
    const zero = await fetchImage("?rotate=0");
    assert.ok(plain.body.equals(zero.body));
  });

  test("rotation is applied before resizing (width applies to rotated image)", async () => {
    const { body } = await fetchImage("?rotate=90&width=320");
    // Rotated image is 640x960; width=320 → height 480.
    assert.deepEqual(pngDimensions(body), { width: 320, height: 480 });
  });

  for (const bad of ["45", "360", "-90", "ninety"]) {
    test(`rotate=${bad} is rejected with 400`, async () => {
      const { status } = await fetchImage(`?rotate=${bad}`);
      assert.equal(status, 400);
    });
  }
});

describe("other routes", () => {
  test("GET / serves the HTML page", async () => {
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
    assert.match(await response.text(), /<img src="\/image"/);
  });

  test("image is excluded from text selection (regression: highlight painted over image)", async () => {
    // A double/triple-click or Ctrl+A beside the image selected it, and the
    // browser painted its highlight colour over the picture. Verified in a
    // real browser by tests/browser/outside-click.test.py; this guards the CSS.
    const html = await (await fetch(`${baseUrl}/`)).text();
    const imgRule = html.match(/img\s*\{[^}]*\}/)?.[0] ?? "";
    assert.match(imgRule, /user-select:\s*none/);
    assert.match(imgRule, /-webkit-user-select:\s*none/);
  });

  test("GET / has a Spec link in the page header", async () => {
    const html = await (await fetch(`${baseUrl}/`)).text();
    assert.match(html, /<div class="top">[\s\S]*<a class="spec-link" href="\/spec"[^>]*>Spec<\/a>[\s\S]*<\/div>/);
  });

  test("GET /spec serves SPEC.md rendered as HTML with tables", async () => {
    const response = await fetch(`${baseUrl}/spec`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
    const html = await response.text();
    assert.match(html, /<title>Sharp Viewer - Spec/);
    assert.match(html, /<h1>Sharp Viewer - Spec/);
    assert.ok((html.match(/<table>/g) ?? []).length >= 10, "expected the spec tables to be rendered");
    assert.match(html, /<a href="\/">/, "has a link back to the viewer");
    assert.match(html, /<a href="\/SPEC.md">/, "has a link to the raw markdown");
  });

  test("GET / has a Guide link next to the Spec link", async () => {
    const html = await (await fetch(`${baseUrl}/`)).text();
    assert.match(
      html,
      /<div class="top">[\s\S]*<a class="spec-link" href="\/guide"[^>]*>Guide<\/a>\s*<a class="spec-link" href="\/spec"[^>]*>Spec<\/a>[\s\S]*<\/div>/,
    );
  });

  test("GET /guide serves USER_GUIDE.md rendered as HTML with tables, rules and tip boxes", async () => {
    const response = await fetch(`${baseUrl}/guide`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
    const html = await response.text();
    assert.match(html, /<title>Sharp Viewer – User Guide/);
    assert.match(html, /<h1>Sharp Viewer – User Guide/);
    assert.ok((html.match(/<table>/g) ?? []).length >= 10, "expected the guide tables to be rendered");
    assert.ok((html.match(/<hr>/g) ?? []).length >= 5, "section rules rendered");
    assert.match(html, /<blockquote><p><strong>Tip:<\/strong>/, "tip box rendered");
    assert.doesNotMatch(html, /<p>---<\/p>|<p>&gt; /, "no raw rule / quote markers leak through");
    assert.match(html, /<a href="\/">/, "has a link back to the viewer");
    assert.match(html, /<a href="\/spec">Spec<\/a>/, "links to the spec");
    assert.match(html, /<a href="\/USER_GUIDE.md">/, "has a link to the raw markdown");
  });

  test("GET /spec links to the guide", async () => {
    const html = await (await fetch(`${baseUrl}/spec`)).text();
    assert.match(html, /<a href="\/guide">User guide<\/a>/);
  });

  test("GET /USER_GUIDE.md serves the raw markdown file", async () => {
    const response = await fetch(`${baseUrl}/USER_GUIDE.md`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/markdown/);
    const body = await response.text();
    assert.match(body, /^# Sharp Viewer – User Guide/);
    assert.match(body, /^\| I want to/m);
  });

  test("HEAD /guide has the GET headers and no body", async () => {
    const response = await fetch(`${baseUrl}/guide`, { method: "HEAD" });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
    assert.ok(Number(response.headers.get("content-length")) > 1000);
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  });

  test("GET /SPEC.md serves the raw markdown file", async () => {
    const response = await fetch(`${baseUrl}/SPEC.md`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/markdown/);
    const body = await response.text();
    assert.match(body, /^# Sharp Viewer - Spec/);
    assert.match(body, /^\| Topic/m);
  });

  test("B11: a request path the URL parser rejects (e.g. `//?x`) is a 400, and the server stays up", async () => {
    for (const path of ["//?image=photo", "//", "///spec", "//evil.example/"]) {
      const r = await fetch(`${baseUrl}${path}`);
      assert.equal(r.status, 400, path);
      assert.match(await r.text(), /Bad request/);
    }
    const alive = await fetch(`${baseUrl}/image?width=10`);
    assert.equal(alive.status, 200, "the server survived");
  });

  test("unknown path returns 404", async () => {
    const response = await fetch(`${baseUrl}/missing`);
    assert.equal(response.status, 404);
  });

  test("POST returns 405 with Allow header", async () => {
    const response = await fetch(`${baseUrl}/image`, { method: "POST" });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, HEAD");
  });

  test("HEAD /image returns headers but no body", async () => {
    const response = await fetch(`${baseUrl}/image?width=100`, { method: "HEAD" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.ok(Number(response.headers.get("content-length")) > 0);
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  });
});
