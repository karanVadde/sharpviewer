"""
Optional browser test (not part of `npm test`): real device emulation.

1. Renders the viewer under Playwright's device descriptors (true CSS viewport,
   device pixel ratio, mobile user agent, touch) for the 10 devices of the
   in-page Mobile preview, portrait and landscape, and saves a screenshot
   gallery to /tmp/device-gallery/ (+ a contact sheet).
2. Checks the in-page preview's device sizes match Playwright's descriptors.
3. Drives the banner in a desktop browser: Mobile tab, Next x10 wraps around,
   orientation toggle, frame iframe loads and shows the watermarked image.

Requires: python3, pillow, playwright (+ Chromium).  Run from the project root:
    python3 tests/browser/devices.test.py
"""
import json, os, subprocess, sys, time, urllib.request
from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright

PROJECT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT = 3480
URL = f"http://127.0.0.1:{PORT}/"
QUERY = "?wm=1&wmWidth=300&traverseX=-100&traverseY=-50"
OUT = "/tmp/device-gallery"
# slug in src/devices.ts -> Playwright descriptor name
PROFILES = [
    ("iphone-se", "iPhone SE"), ("iphone-13", "iPhone 13"), ("iphone-14-pro-max", "iPhone 14 Pro Max"),
    ("ipad-mini", "iPad Mini"), ("ipad-pro-11", "iPad Pro 11"),
    ("galaxy-s9-plus", "Galaxy S9+"), ("galaxy-s24", "Galaxy S24"), ("pixel-5", "Pixel 5"),
    ("pixel-7", "Pixel 7"), ("galaxy-tab-s4", "Galaxy Tab S4"),
]
results = []

def check(name, ok, detail=""):
    results.append(ok)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" - {detail}" if detail else ""))

def apply(page):
    """Click Apply and wait for the in-place update (spec 4l): busy flag set on click, cleared after the swap."""
    page.click("button.primary")
    page.wait_for_function("() => !document.querySelector('main').getAttribute('aria-busy')")
    page.wait_for_timeout(60)

os.makedirs(OUT, exist_ok=True)
server = subprocess.Popen(["node", "src/server.ts"], cwd=PROJECT, env={**os.environ, "PORT": str(PORT)},
                          stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
for _ in range(50):
    try:
        urllib.request.urlopen(URL, timeout=1); break
    except Exception:
        time.sleep(0.1)

try:
    devices_ts = open(os.path.join(PROJECT, "src", "devices.ts")).read()
    with sync_playwright() as p:
        browser = p.chromium.launch()

        print("\n1. Real device emulation (viewport + DPR + mobile UA + touch), both orientations")
        shots = []
        for slug, name in PROFILES:
            for orientation in ("portrait", "landscape"):
                desc = dict(p.devices[name if orientation == "portrait" else f"{name} landscape"])
                ctx = browser.new_context(**desc)
                page = ctx.new_page()
                page.goto(URL + QUERY + "&embed=image"); page.wait_for_load_state("networkidle")
                vw, vh = desc["viewport"]["width"], desc["viewport"]["height"]
                loaded = page.evaluate("() => { const i = document.querySelector('img'); return i.complete && i.naturalWidth > 0; }")
                shown_w = page.evaluate("() => document.querySelector('img').getBoundingClientRect().width")
                mark_css = 300 * shown_w / 960  # watermark width as displayed, in CSS px
                path = f"{OUT}/{slug}-{orientation}.png"
                page.screenshot(path=path)  # captures at the device DPR
                im = Image.open(path)
                check(f"{name:<18} {orientation:<9} {vw}x{vh} @{desc['device_scale_factor']}x: image loaded, shot {im.width}x{im.height}, mark shown at {mark_css:.0f} CSS px",
                      loaded and abs(im.width - vw * desc["device_scale_factor"]) <= 1)
                shots.append((f"{name} {orientation} {vw}x{vh}", path, mark_css))
                ctx.close()

        print("\n2. In-page preview sizes match Playwright's descriptors")
        for slug, name in PROFILES:
            v = p.devices[name]["viewport"]; dpr = p.devices[name]["device_scale_factor"]
            check(f"{name}: src/devices.ts has {v['width']}x{v['height']} @{dpr}x",
                  f'slug: "{slug}"' in devices_ts and f"width: {v['width']}, height: {v['height']}, dpr: {dpr}" in devices_ts)

        print("\n3. Banner and cycling in a desktop browser")
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.goto(URL + QUERY); page.wait_for_load_state("networkidle")
        check("mode switch present, Desktop active", page.locator(".mode-switch a.active").inner_text() == "Desktop" and page.evaluate("document.body.className") == "desktop")
        page.click(".mode-switch a:has-text('Mobile')"); page.wait_for_load_state("networkidle")
        check("Mobile switches the mode", page.locator(".mode-switch a.active").inner_text() == "Mobile" and page.evaluate("document.body.className") == "mobile")
        names = []
        for _ in range(10):
            names.append(page.locator(".device-caption strong").inner_text())
            page.click("a[rel=next]"); page.wait_for_load_state("networkidle")
        check("Next cycles through all 10 devices and wraps", names == [n for _, n in PROFILES] and page.locator(".device-caption strong").inner_text() == "iPhone SE", " -> ".join(names))
        page.click("a.chip:has-text('Galaxy S24')"); page.wait_for_load_state("networkidle")
        check("chip jumps straight to a device", "Galaxy S24" in page.locator(".device-caption").inner_text())
        page.click("a.orientation"); page.wait_for_load_state("networkidle")
        w, h = page.evaluate("() => { const f = document.querySelector('iframe'); return [f.width, f.height]; }")
        check("orientation toggle gives a landscape frame", (w, h) == ("780", "360"), f"{w}x{h}")
        fi = page.frame_locator("iframe")
        fi.locator("img").wait_for()
        check("iframe shows the watermarked image with the current settings",
              fi.locator("img").get_attribute("src") == "/image?wm=1&wmWidth=300&traverseX=-100&traverseY=-50" and fi.locator("img").evaluate("i => i.naturalWidth > 0"))
        check("iframe contains only the image (no header/form/banner)", fi.locator("header, form, .banner").count() == 0)
        check("preview controls are on the outer page, carrying the device", page.locator(".controls").count() == 1 and page.locator("#settings input[name=device]").get_attribute("value") == "galaxy-s24")
        check("settings survive the switches (URL)", "wm=1&wmWidth=300&traverseX=-100&traverseY=-50" in page.url and "device=galaxy-s24&orientation=landscape" in page.url, page.url)
        page.fill("[form=settings][name=wmOpacity]", "100"); apply(page)
        check("Apply from the outer form re-renders the frame on the same device",
              "device=galaxy-s24&orientation=landscape" in page.url and page.get_attribute("iframe", "src").endswith("wmOpacity=100&traverseX=-100&traverseY=-50&embed=image"), page.get_attribute("iframe", "src"))
        page.screenshot(path=f"{OUT}/banner-mobile-landscape.png")
        browser.close()

    # Contact sheet: portrait column per device, scaled to a common height.
    cell_h, pad = 520, 16
    tiles = []
    for label, path, mark_css in shots:
        if "portrait" not in label: continue
        im = Image.open(path).convert("RGB"); s = cell_h / im.height
        tiles.append((label, mark_css, im.resize((int(im.width * s), cell_h))))
    per_row = 5
    rows = [tiles[i:i + per_row] for i in range(0, len(tiles), per_row)]
    sheet_w = max(sum(t[2].width for t in r) + pad * (len(r) + 1) for r in rows)
    sheet = Image.new("RGB", (sheet_w, (cell_h + 48 + pad) * len(rows) + pad), "#f6f5f1")
    d = ImageDraw.Draw(sheet); y = pad
    for r in rows:
        x = pad
        for label, mark_css, im in r:
            sheet.paste(im, (x, y + 36)); d.text((x, y), label, fill="#1f2933"); d.text((x, y + 14), f"mark shown ~{mark_css:.0f} CSS px wide", fill="#7c2d12")
            x += im.width + pad
        y += cell_h + 48 + pad
    sheet.save(f"{OUT}/contact-sheet.png")
    print(f"\nGallery: {OUT}/ (20 device shots + contact-sheet.png)")
finally:
    server.terminate()

print("\nSummary: %d/%d checks passed" % (sum(results), len(results)))
sys.exit(0 if all(results) else 1)
