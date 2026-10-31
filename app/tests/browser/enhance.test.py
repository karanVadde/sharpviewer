"""
Optional browser test (not part of `npm test`): the Enhance card as a user sees it -
Sharpen / Grayscale checkboxes, the Rounded corners slider (0-100) with its live
value, the resolved radius after Apply, the clip warning toast, and the Mobile frame.

Requires: python3, pillow, playwright (+ Chromium).  Run from the project root:
    python3 tests/browser/enhance.test.py
"""
import io, os, subprocess, sys, time, urllib.request
from PIL import Image
from playwright.sync_api import sync_playwright

PROJECT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT = 3497
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
        img = lambda: Image.open(io.BytesIO(page.request.get(URL.rstrip("/") + page.get_attribute(".preview img", "src")).body())).convert("RGBA")

        print("\n1. The Enhance card")
        page.goto(URL + "?image=photo&wm=1&wmWidth=20%"); page.wait_for_load_state("networkidle")
        cards = page.evaluate("() => [...document.querySelectorAll('.controls .card h2')].map(h => h.textContent.trim())")
        check("Enhance card sits between Watermark and Watermark position", cards == ["Image", "Watermark", "Enhance", "Watermark position", "Output", "Export", "Android", "Collage"], str(cards))
        check("context shows defaults", page.locator("section[aria-labelledby=h-enh] .context").inner_text() == "Sharpen off · Grayscale off · Square corners")
        slider = page.locator("[form=settings][name=corners]")
        check("slider 0-100, value 0", slider.get_attribute("min") == "0" and slider.get_attribute("max") == "100" and slider.input_value() == "0")

        print("\n2. Drag the slider: live value, then Apply -> radius in px")
        slider.fill("40"); slider.dispatch_event("input")
        check("live value updates without a round trip", page.locator("section[aria-labelledby=h-enh] .slider output").inner_text() == "40")
        page.check("[form=settings][name=grayscale]"); apply(page)
        ctx = page.locator("section[aria-labelledby=h-enh] .context").inner_text()
        check("after Apply the context shows the resolved radius (40% of 600 = 240 px on 1600x1200)", "Rounded corners 40 → 240 px radius" in ctx and "Grayscale on" in ctx, ctx)
        check("URL carries only the active params", "grayscale=1" in page.url and "corners=40" in page.url and "sharpen=1" not in page.url)
        im = img()
        check("rendered image: transparent corner, opaque centre, grey pixels", im.getpixel((0, 0))[3] == 0 and im.getpixel((800, 600))[3] == 255 and len(set(im.getpixel((800, 600))[:3])) == 1)
        page.screenshot(path="/tmp/enhance-page.png", full_page=True)

        print("\n3. Clip warning")
        slider.fill("100"); page.fill("[form=settings][name=wmMargin]", "0"); apply(page)
        check("toast warns that the corners clip the watermark", page.locator(".toast").count() == 1 and "clip part of the watermark" in page.locator(".toast").inner_text())
        check("image still renders as requested (not blocked)", page.evaluate("() => document.querySelector('.preview img').naturalWidth === 1600"))
        page.fill("[form=settings][name=traverseX]", "-400"); page.fill("[form=settings][name=traverseY]", "-300"); apply(page)
        check("moving the mark inward clears the warning", page.locator(".toast").count() == 0)

        print("\n4. Mobile frame shows the enhanced image")
        page.click(".mode-switch a:has-text('Mobile')"); page.wait_for_load_state("networkidle")
        fi = page.frame_locator("iframe"); fi.locator("img").wait_for()
        src = fi.locator("img").get_attribute("src")
        check("frame image carries the enhance params", "grayscale=1" in src and "corners=100" in src, src)
        check("checkboxes and slider echo the state in Mobile view too", page.is_checked("[form=settings][name=grayscale]") and slider.input_value() == "100")
        browser.close()
finally:
    server.terminate()

print("\nSummary: %d/%d checks passed" % (sum(results), len(results)))
sys.exit(0 if all(results) else 1)
