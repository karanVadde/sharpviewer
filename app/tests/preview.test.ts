import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { createApp, FRAME_MAX, parsePreviewState } from "../src/app.ts";
import { DEVICES, findDevice, neighbours, viewportFor } from "../src/devices.ts";

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

const unescapeHtml = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&middot;/g, "·")
    .replace(/&times;/g, "×");

async function page(query: string) {
  const response = await fetch(`${baseUrl}/${query}`);
  const html = await response.text();
  const attr = (re: RegExp) => unescapeHtml(re.exec(html)?.[1] ?? "");
  return {
    status: response.status,
    html,
    bodyClass: attr(/<body class="([^"]*)"/),
    activeTab: /<nav class="mode-switch"[^>]*>[\s\S]*?<a class="active" href="[^"]*"[^>]*>([^<]*)</.exec(html)?.[1] ?? "",
    desktopHref: attr(/<a class="(?:active)?" href="([^"]*)"[^>]*>Desktop</),
    mobileHref: attr(/<a class="(?:active)?" href="([^"]*)"[^>]*>Mobile</),
    prevHref: attr(/href="([^"]*)" rel="prev"/),
    nextHref: attr(/href="([^"]*)" rel="next"/),
    orientationHref: attr(/class="orientation" href="([^"]*)"/),
    caption: unescapeHtml(/<span class="device-caption">([\s\S]*?)<\/span>/.exec(html)?.[1]?.replace(/<[^>]+>/g, "") ?? ""),
    iframeSrc: attr(/<iframe[^>]*src="([^"]*)"/),
    iframeSize: /<iframe[^>]*width="(\d+)" height="(\d+)"/.exec(html)?.slice(1, 3).map(Number) ?? [],
    frameBox: /device-frame-box" style="width:(\d+)px;height:(\d+)px"/.exec(html)?.slice(1, 3).map(Number) ?? [],
    chips: [...html.matchAll(/class="chip( active)?" href="([^"]*)"[^>]*>([^<]*)</g)].map((m) => ({ active: !!m[1], href: unescapeHtml(m[2]!), name: m[3]! })),
    imgSrc: attr(/<img src="([^"]*)"/),
    error: unescapeHtml(/<p class="error" role="alert">([^<]*)<\/p>/.exec(html)?.[1] ?? ""),
    hasForm: /<form id="settings" method="get" action="\/"/.test(html),
    hasHeader: /<div class="top">/.test(html),
    hasBanner: /<nav class="mode-switch"/.test(html),
    hidden: (name: string) => unescapeHtml(new RegExp(`<input type="hidden" name="${name}" value="([^"]*)">`).exec(html)?.[1] ?? ""),
    resetHref: attr(/href="([^"]*)">Reset</),
  };
}

describe("device list", () => {
  test("10 devices: 5 iOS + 5 Android, unique slugs, sane sizes", () => {
    assert.equal(DEVICES.length, 10);
    assert.equal(DEVICES.filter((d) => d.platform === "iOS").length, 5);
    assert.equal(DEVICES.filter((d) => d.platform === "Android").length, 5);
    assert.equal(new Set(DEVICES.map((d) => d.slug)).size, 10);
    for (const d of DEVICES) {
      assert.match(d.slug, /^[a-z0-9-]+$/);
      assert.ok(d.width >= 320 && d.width < d.height && d.height <= 1200 && d.dpr >= 2, d.name);
    }
  });

  test("neighbours wrap around both ends", () => {
    assert.equal(neighbours(DEVICES[0]!).prev, DEVICES[9]);
    assert.equal(neighbours(DEVICES[9]!).next, DEVICES[0]);
    assert.equal(neighbours(DEVICES[3]!).next, DEVICES[4]);
  });

  test("landscape swaps width and height", () => {
    const d = findDevice("pixel-7")!;
    assert.deepEqual(viewportFor(d, "portrait"), { width: 412, height: 839 });
    assert.deepEqual(viewportFor(d, "landscape"), { width: 839, height: 412 });
  });

  test("parsePreviewState defaults and validation", () => {
    const s = parsePreviewState(new URLSearchParams(""));
    assert.deepEqual([s.view, s.device.slug, s.orientation, s.embed], ["desktop", "iphone-se", "portrait", false]);
    assert.throws(() => parsePreviewState(new URLSearchParams("view=tv")), /view must be one of desktop, mobile/);
    assert.throws(() => parsePreviewState(new URLSearchParams("device=nope")), /Unknown device "nope"/);
    assert.throws(() => parsePreviewState(new URLSearchParams("orientation=upside")), /orientation must be one of portrait, landscape/);
    assert.throws(() => parsePreviewState(new URLSearchParams("embed=1")), /embed must be "image" or "scene"/);
    assert.equal(parsePreviewState(new URLSearchParams("embed=image")).embed, "image");
    assert.equal(parsePreviewState(new URLSearchParams("embed=scene")).embed, "scene");
    assert.deepEqual([s.scene, s.tile, s.row, s.theme], ["grid", 150, 64, "light"]);
  });
});

describe("banner", () => {
  test("desktop (default): mode switch with Desktop active, image + form shown, no frame", async () => {
    const p = await page("");
    assert.ok(p.hasBanner);
    assert.equal(p.bodyClass, "desktop");
    assert.equal(p.activeTab, "Desktop");
    assert.equal(p.imgSrc, "/image");
    assert.ok(p.hasForm);
    assert.equal(p.iframeSrc, "");
    assert.doesNotMatch(p.html, /<div class="device-controls">/);
  });

  test("mobile: Mobile active, device controls + image-only frame, form stays on the page", async () => {
    const p = await page("?view=mobile");
    assert.equal(p.bodyClass, "mobile");
    assert.equal(p.activeTab, "Mobile");
    assert.match(p.html, /<div class="device-controls">/);
    assert.equal(p.iframeSrc, "/?embed=image");
    assert.equal(p.imgSrc, "", "no direct <img> outside the frame");
    assert.ok(p.hasForm, "preview controls stay on the outer page");
    assert.ok(p.hasHeader);
    assert.equal(p.chips.length, 10);
    assert.deepEqual(
      p.chips.filter((c) => c.active).map((c) => c.name),
      ["iPhone SE"],
    );
  });

  test("mobile: the form carries the preview state so Apply re-renders the frame on the same device", async () => {
    const p = await page("?wm=1&view=mobile&device=pixel-7&orientation=landscape");
    assert.deepEqual([p.hidden("view"), p.hidden("device"), p.hidden("orientation")], ["mobile", "pixel-7", "landscape"]);
    assert.equal(p.resetHref, "/?view=mobile&device=pixel-7&orientation=landscape");
    // Simulate the form submit: the browser sends every field, including the hidden ones.
    const submitted = await page(
      "?wm=1&wmWidth=300&wmHeight=&wmMargin=16&wmOpacity=100&traverseX=0&traverseY=0&appliedTraverseX=0&appliedTraverseY=0&view=mobile&device=pixel-7&orientation=landscape&width=&height=&rotate=0",
    );
    assert.equal(submitted.activeTab, "Mobile");
    assert.deepEqual(submitted.iframeSize, [839, 412]);
    assert.equal(submitted.iframeSrc, "/?rotate=0&wm=1&wmWidth=300&wmMargin=16&wmOpacity=100&traverseX=0&traverseY=0&embed=image");
  });

  test("desktop: no hidden preview fields, Reset goes to /", async () => {
    const p = await page("?wm=1");
    assert.equal(p.hidden("view"), "");
    assert.equal(p.resetHref, "/");
  });

  test("mobile: toasts and error banner appear on the outer page; the frame shows the kept image", async () => {
    const t = await page("?wm=1&traverseX=-800&appliedTraverseX=-100&view=mobile");
    assert.match(t.html, /<div class="toast"><span>traverseX -800 is out of bounds[^<]*Keeping -100\./);
    assert.equal(t.iframeSrc, "/?wm=1&traverseX=-100&embed=image");
    const e = await page("?wm=1&wmWidth=5000&view=mobile&device=pixel-7");
    assert.match(e.error, /wmWidth must be an integer/);
    assert.equal(e.activeTab, "Mobile", "stays in Mobile view");
    assert.equal(e.iframeSrc, "/?embed=image", "frame falls back to the plain image");
  });

  test("tabs keep the image settings and the chosen device/orientation", async () => {
    const p = await page("?wm=1&traverseX=-100&view=mobile&device=pixel-7&orientation=landscape");
    assert.equal(p.desktopHref, "/?wm=1&traverseX=-100&device=pixel-7&orientation=landscape");
    assert.equal(p.mobileHref, "/?wm=1&traverseX=-100&view=mobile&device=pixel-7&orientation=landscape");
    const back = await page(p.desktopHref.slice(1));
    assert.equal(back.activeTab, "Desktop");
    assert.equal(back.imgSrc, "/image?wm=1&traverseX=-100");
    assert.equal(back.mobileHref, "/?wm=1&traverseX=-100&view=mobile&device=pixel-7&orientation=landscape");
  });

  test("invalid view/device/orientation -> error banner, desktop view, image still loads", async () => {
    for (const [q, re] of [
      ["?view=tv", /view must be one of desktop, mobile/],
      ["?view=mobile&device=nope", /Unknown device "nope"/],
      ["?view=mobile&orientation=upside", /orientation must be one of/],
    ] as Array<[string, RegExp]>) {
      const p = await page(q);
      assert.match(p.error, re, q);
      assert.equal(p.activeTab, "Desktop");
      assert.equal(p.imgSrc, "/image");
      assert.equal((await fetch(`${baseUrl}${p.imgSrc}`)).status, 200);
    }
  });
});

describe("mobile preview: cycling", () => {
  test("Next from every device goes to the next one and wraps; Prev goes back", async () => {
    let p = await page("?view=mobile");
    const seen: string[] = [];
    for (let i = 0; i < DEVICES.length; i++) {
      seen.push(/<strong>([^<]*)<\/strong>/.exec(p.caption ? p.html : "")?.[1] ?? "");
      p = await page(p.nextHref.slice(1));
    }
    assert.deepEqual(
      seen,
      DEVICES.map((d) => d.name),
    );
    assert.match(p.caption, /iPhone SE/, "wrapped around to the first device");
    const back = await page(p.prevHref.slice(1));
    assert.match(back.caption, /Galaxy Tab S4/, "Prev from the first wraps to the last");
  });

  for (const d of DEVICES) {
    test(`${d.name}: caption, frame and iframe match the profile (portrait)`, async () => {
      const p = await page(`?view=mobile&device=${d.slug}`);
      assert.equal(p.caption, `${d.name} · ${d.width}×${d.height} · @${d.dpr}x · ${d.platform} · portrait`);
      assert.deepEqual(p.iframeSize, [d.width, d.height]);
      const scale = Math.min(1, FRAME_MAX.width / d.width, FRAME_MAX.height / d.height);
      assert.deepEqual(p.frameBox, [Math.round(d.width * scale), Math.round(d.height * scale)]);
      assert.deepEqual(
        p.chips.filter((c) => c.active).map((c) => c.name),
        [d.name],
      );
    });
  }

  test("chips link to every device, keeping settings and orientation", async () => {
    const p = await page("?wm=1&view=mobile&orientation=landscape");
    assert.deepEqual(
      p.chips.map((c) => c.name),
      DEVICES.map((d) => d.name),
    );
    for (const c of p.chips) {
      const slug = DEVICES.find((d) => d.name === c.name)!.slug;
      assert.equal(c.href, `/?wm=1&view=mobile&device=${slug}&orientation=landscape`);
    }
  });

  test("orientation toggle swaps the frame and keeps the device", async () => {
    const p = await page("?view=mobile&device=pixel-7");
    assert.equal(p.orientationHref, "/?view=mobile&device=pixel-7&orientation=landscape");
    const land = await page(p.orientationHref.slice(1));
    assert.deepEqual(land.iframeSize, [839, 412]);
    assert.equal(land.caption, "Pixel 7 · 839×412 · @2.625x · Android · landscape");
    assert.equal(land.orientationHref, "/?view=mobile&device=pixel-7&orientation=portrait");
    assert.match(land.html, /Rotate to portrait/);
  });

  test("frame never exceeds FRAME_MAX (iPad Pro 11 portrait is scaled)", async () => {
    const p = await page("?view=mobile&device=ipad-pro-11");
    assert.ok(p.frameBox[1]! <= FRAME_MAX.height && p.frameBox[0]! <= FRAME_MAX.width, String(p.frameBox));
    assert.match(p.html, /shown at \d+%/);
  });
});

describe("image-only page (inside the frame)", () => {
  test("embed=image: only the image - no banner, header, form, toasts or script", async () => {
    const p = await page("?wm=1&traverseX=-100&embed=image");
    assert.equal(p.bodyClass, "embed");
    assert.equal(p.hasBanner, false);
    assert.equal(p.hasHeader, false);
    assert.equal(p.hasForm, false);
    assert.doesNotMatch(p.html, /<script>|class="toast|class="error"|class="spec-link"/);
    assert.equal(p.imgSrc, "/image?wm=1&traverseX=-100");
    const body = p.html.slice(p.html.indexOf("<body"));
    const text = body
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    assert.equal(text, "", "no visible text besides the image");
    assert.equal((body.match(/<img /g) ?? []).length, 1);
  });

  test("embed=image keeps the page's width rules (same layout as the viewer)", async () => {
    const p = await page("?embed=image");
    assert.match(p.html, /main \{[^}]*max-width: 1040px;/);
    assert.match(p.html, /body\.embed main \{[^}]*padding: 32px 20px;/);
  });

  test("the iframe src of every device page loads and contains only the watermarked image", async () => {
    for (const d of DEVICES) {
      const p = await page(`?wm=1&wmWidth=300&view=mobile&device=${d.slug}`);
      assert.equal(p.iframeSrc, "/?wm=1&wmWidth=300&embed=image");
      const inner = await page(p.iframeSrc.slice(1));
      assert.equal(inner.status, 200);
      assert.equal(inner.bodyClass, "embed");
      assert.equal(inner.hasForm, false);
      assert.equal(inner.imgSrc, "/image?wm=1&wmWidth=300");
      assert.equal((await fetch(`${baseUrl}${inner.imgSrc}`)).status, 200);
    }
  });

  test("embed never reaches the image URL; old embed=1 is rejected with a banner", async () => {
    const p = await page("?wm=1&embed=image");
    assert.doesNotMatch(p.imgSrc, /embed/);
    const old = await page("?embed=1");
    assert.match(old.error, /embed must be "image"/);
    assert.equal(old.imgSrc, "/image");
  });
});
