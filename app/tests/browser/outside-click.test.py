"""
Optional browser test (not part of `npm test`): proves that a double-click
beside the image selects it and the browser paints its highlight colour over
the picture, and that `user-select: none` on the <img> prevents it.

Requires: python3, pillow, playwright (+ a Chromium build).
Run from the project root:  python3 tests/browser/outside-click.test.py

The checks adapt to whether the fix is present in the served page, so the
script passes in both states while documenting the behaviour of each.
"""
import io, os, subprocess, sys, time, urllib.request
from PIL import Image
from playwright.sync_api import sync_playwright

PROJECT = "/workspace/sharp-viewer"
PORT = 3456
URL = f"http://127.0.0.1:{PORT}/"
results = []

def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))

def mean_rgb(png_bytes, box):
    im = Image.open(io.BytesIO(png_bytes)).convert("RGB").crop(box)
    px = list(im.getdata())
    n = len(px)
    return tuple(round(sum(p[i] for p in px) / n, 1) for i in range(3))

def dist(a, b):
    return round(sum((x - y) ** 2 for x, y in zip(a, b)) ** 0.5, 1)

# --- start the server from the project's existing files (no writes) ---------
server = subprocess.Popen(["node", "src/server.ts"], cwd=PROJECT,
                          env={**os.environ, "PORT": str(PORT)},
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
for _ in range(50):
    try:
        urllib.request.urlopen(URL, timeout=1); break
    except Exception:
        time.sleep(0.1)

try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1200, "height": 900})
        page.goto(URL)
        page.wait_for_load_state("networkidle")

        img = page.locator(".preview img")
        box = img.bounding_box()
        crop = (int(box["x"]), int(box["y"]), int(box["x"] + box["width"]), int(box["y"] + box["height"]))
        sel_colour = page.evaluate("getComputedStyle(document.body).getPropertyValue('color')")

        print("\n1. Baseline")
        base = page.screenshot()
        base_rgb = mean_rgb(base, crop)
        check("img has no CSS filter", page.evaluate("getComputedStyle(document.querySelector('img')).filter") == "none")
        check("page has no script besides the toast dismisser", page.evaluate("[...document.scripts].every(s => s.textContent.includes('toast'))"))
        check("no selection initially", page.evaluate("getSelection().toString()") == "" and
              not page.evaluate("getSelection().rangeCount && getSelection().getRangeAt(0).intersectsNode(document.querySelector('img'))"))
        print(f"     baseline mean RGB over image: {base_rgb}")

        # Point clearly outside the image: RIGHT margin, vertically mid-image (reproduces)
        outside = {"x": box["x"] + box["width"] + 12, "y": box["y"] + box["height"] / 2}
        check("click target is outside the image box", outside["x"] > box["x"] + box["width"])

        print("\n2. Single click outside the image")
        page.mouse.click(outside["x"], outside["y"])
        single = page.screenshot()
        d = dist(mean_rgb(single, crop), base_rgb)
        check("single click: image unchanged", d < 1.0, f"colour shift {d}")

        print("\n3. Double click outside the image")
        page.mouse.dblclick(outside["x"], outside["y"])
        page.wait_for_timeout(100)
        dbl = page.screenshot()
        dbl_rgb = mean_rgb(dbl, crop)
        d = dist(dbl_rgb, base_rgb)
        changed = d >= 1.0
        fixed = page.evaluate("getComputedStyle(document.querySelector('img')).userSelect") == "none"
        if fixed:
            check("double click: image unchanged (user-select:none fix present)", not changed, f"shift {d}")
        else:
            check("double click: image LOOKS different (fix absent)", changed, f"mean RGB {dbl_rgb}, shift {d}")
        check("…but img still has NO CSS filter", page.evaluate("getComputedStyle(document.querySelector('img')).filter") == "none")
        check("…and the served image bytes are unchanged",
              page.evaluate("fetch('/image').then(r=>r.arrayBuffer()).then(b=>b.byteLength)") ==
              len(urllib.request.urlopen(URL + "image").read()))
        in_sel = page.evaluate("""() => { const s = getSelection();
            return s.rangeCount > 0 && s.getRangeAt(0).intersectsNode(document.querySelector('img')); }""")
        if fixed:
            # With user-select:none the DOM Range may still span the node; it is simply not painted.
            print(f"     (info) selection range intersects <img>: {in_sel}; not painted because user-select:none")
        else:
            check("…the browser SELECTION now contains the <img>", in_sel,
                  f"selection type={page.evaluate('getSelection().type')}")
        with open("/tmp/after-dblclick.png", "wb") as f: f.write(dbl)

        print("\n4. Clear the selection (click once elsewhere / Escape)")
        page.evaluate("getSelection().removeAllRanges()")
        page.wait_for_timeout(100)
        cleared = page.screenshot()
        d = dist(mean_rgb(cleared, crop), base_rgb)
        check("image returns to baseline once selection cleared", d < 1.0, f"shift {d}")

        print("\n5. Show the tint is the browser's highlight colour (green ::selection injected in-browser only)")
        page.add_style_tag(content="::selection { background: rgb(0, 200, 0); }")
        page.mouse.dblclick(outside["x"], outside["y"])
        page.wait_for_timeout(100)
        green = mean_rgb(page.screenshot(), crop)
        g_shift = green[1] - base_rgb[1]; r_shift = green[0] - base_rgb[0]; b_shift = green[2] - base_rgb[2]
        if fixed:
            check("with a green highlight colour the image is still NOT tinted (fix present)",
                  abs(g_shift) < 1 and abs(r_shift) < 1 and abs(b_shift) < 1, f"mean RGB {green}")
        else:
            check("with a green highlight colour the image is tinted GREEN",
                  g_shift > 0 and g_shift > r_shift and g_shift > b_shift,
                  f"mean RGB {green} (ΔR {r_shift:+.1f}, ΔG {g_shift:+.1f}, ΔB {b_shift:+.1f})")
        with open("/tmp/after-dblclick-green.png", "wb") as f: f.write(page.screenshot())

        print("\n6. Candidate fix verified in-browser only: user-select:none on img")
        page.evaluate("getSelection().removeAllRanges()")
        page.add_style_tag(content="img { user-select: none; -webkit-user-select: none; }")
        page.mouse.dblclick(outside["x"], outside["y"])
        page.wait_for_timeout(100)
        d = dist(mean_rgb(page.screenshot(), crop), base_rgb)
        check("with user-select:none, double click no longer tints the image", d < 1.0, f"shift {d}")

        browser.close()
finally:
    server.terminate()

print("\nSummary: %d/%d checks passed" % (sum(ok for _, ok, _ in results), len(results)))
sys.exit(0 if all(ok for _, ok, _ in results) else 1)
