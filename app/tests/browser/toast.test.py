"""
Optional browser test (not part of `npm test`): out-of-bounds traverseX/traverseY
must show a toast warning while the image still renders with the watermark
where it was (last applied position) - never a broken image.

Requires: python3, playwright (+ Chromium).  Run from the project root:
    python3 tests/browser/toast.test.py
"""
import os, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright

PROJECT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT = 3470
URL = f"http://127.0.0.1:{PORT}/"
results = []

def check(name, ok, detail=""):
    results.append(ok)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" - {detail}" if detail else ""))

def apply(page):
    """Click Apply and wait for the in-place update (spec 4l): busy flag set on click, cleared after the swap."""
    page.click("button.primary")
    page.wait_for_function("() => !document.querySelector('main').getAttribute('aria-busy')")
    page.wait_for_timeout(60)

server = subprocess.Popen(["node", "src/server.ts"], cwd=PROJECT, env={**os.environ, "PORT": str(PORT)},
                          stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
for _ in range(50):
    try:
        urllib.request.urlopen(URL, timeout=1); break
    except Exception:
        time.sleep(0.1)

try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1200, "height": 1000})

        print("\n1. Apply a valid position first, then submit out-of-bounds values through the form")
        page.goto(URL); page.wait_for_load_state("networkidle")
        page.check("[form=settings][name=wm]")
        page.fill("[form=settings][name=traverseX]", "-100"); page.fill("[form=settings][name=traverseY]", "-50")
        apply(page)
        check("valid position applied, no toast", page.locator(".toast").count() == 0 and page.get_attribute("img", "src").endswith("traverseX=-100&traverseY=-50"))
        before = page.request.get(URL.rstrip("/") + page.get_attribute("img", "src")).body()
        page.fill("[form=settings][name=traverseX]", "-800")
        page.fill("[form=settings][name=traverseY]", "30")
        apply(page)
        toasts = page.locator(".toast")
        check("two toasts are visible (one per axis)", toasts.count() == 2 and all(toasts.nth(i).is_visible() for i in range(2)))
        texts = [toasts.nth(i).inner_text() for i in range(toasts.count())]
        check("toast explains bounds and that the position is kept", any("allowed -744 to 16" in t and "Keeping -100" in t for t in texts), texts[0] if texts else "")
        box = toasts.first.bounding_box()
        check("toast sits in the top-right corner", box["x"] > 1200 * 0.6 and box["y"] < 60, f"x={box['x']:.0f} y={box['y']:.0f}")
        page.screenshot(path="/tmp/toast-page.png")

        print("\n2. The image still renders, with the watermark where it was")
        loaded = page.evaluate("() => { const i = document.querySelector('img'); return i.complete && i.naturalWidth > 0; }")
        check("<img> loaded (not a broken image)", loaded)
        check("<img src> keeps the previously applied values", page.get_attribute("img", "src").endswith("traverseX=-100&traverseY=-50"), page.get_attribute("img", "src"))
        after = page.request.get(URL.rstrip("/") + page.get_attribute("img", "src")).body()
        check("served image is byte-identical to before the bad submit", after == before and len(after) > 1000, f"{len(after)} bytes")
        check("form still shows what was typed", page.input_value("[form=settings][name=traverseX]") == "-800" and page.input_value("[form=settings][name=traverseY]") == "30")

        print("\n3. Dismissal")
        toasts.first.locator(".toast-close").click(); page.wait_for_timeout(400)
        check("clicking x removes that toast", page.locator(".toast").count() == 1)
        page.wait_for_timeout(6500)
        check("remaining toast auto-dismisses after ~6 s", page.locator(".toast").count() == 0)

        print("\n4. In-bounds values: no toast")
        page.goto(URL + "?wm=1&traverseX=-100&traverseY=-50"); page.wait_for_load_state("networkidle")
        check("no toast for valid values", page.locator(".toast").count() == 0)
        check("image loaded", page.evaluate("() => document.querySelector('img').naturalWidth > 0"))

        print("\n5. Render-impossible input keeps the banner path and still shows an image")
        page.goto(URL + "?wm=1&wmWidth=960"); page.wait_for_load_state("networkidle")
        check("error banner shown", page.locator("p.error").is_visible())
        check("banner is above the preview, not overlapping it", page.locator("p.error").bounding_box()["y"] < page.locator(".preview").bounding_box()["y"])
        check("image loaded (plain)", page.evaluate("() => document.querySelector('img').naturalWidth > 0"))
        browser.close()
finally:
    server.terminate()

print("\nSummary: %d/%d checks passed" % (sum(results), len(results)))
sys.exit(0 if all(results) else 1)
