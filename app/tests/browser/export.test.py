"""
Optional browser test (not part of `npm test`): the Export card as a user sees it -
choose a platform preset (preview follows), format/quality/max size, click Download,
and check the file that arrives (name, type, size, dimensions).

Requires: python3, pillow, playwright (+ Chromium).  Run from the project root:
    python3 tests/browser/export.test.py
"""
import io, os, subprocess, sys, time, urllib.request
from PIL import Image
from playwright.sync_api import sync_playwright

PROJECT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT = 3498
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
        page = browser.new_page(viewport={"width": 1200, "height": 1000}, accept_downloads=True)

        print("\n1. Export card and a preset that drives the preview")
        page.goto(URL + "?image=photo&wm=1&wmWidth=20%"); page.wait_for_load_state("networkidle")
        cards = page.evaluate("() => [...document.querySelectorAll('.controls .card h2')].map(h => h.textContent.trim())")
        check("Export card present", "Export" in cards, str(cards))
        page.select_option("[form=settings][name=preset]", "ig-square"); page.select_option("[form=settings][name=format]", "jpeg")
        page.fill("[form=settings][name=quality]", "75"); page.fill("[form=settings][name=maxKB]", "90")
        apply(page)
        check("preview now shows the preset size (1080x1080)", page.evaluate("() => { const i = document.querySelector('.preview img'); return i.naturalWidth === 1080 && i.naturalHeight === 1080; }"))
        ctx = page.locator("section[aria-labelledby=h-exp] .context").inner_text()
        check("context line", "ig-square · 1080×1080 · cover · JPEG q75 · ≤ 90 KB" in ctx, ctx)
        check("Download link carries everything", "preset=ig-square" in page.get_attribute("a.button-link", "href") and "maxKB=90" in page.get_attribute("a.button-link", "href"))

        print("\n2. Download")
        with page.expect_download() as dl_info:
            page.click("a.button-link")
        dl = dl_info.value
        path = dl.path(); data = open(path, "rb").read()
        check("file name", dl.suggested_filename == "photo-ig-square-1080x1080-wm.jpg", dl.suggested_filename)
        check("JPEG under the 90 KB target", data[:2] == b"\xff\xd8" and len(data) <= 90 * 1024, f"{len(data)} bytes")
        im = Image.open(io.BytesIO(data))
        check("1080x1080", im.size == (1080, 1080), str(im.size))
        check("watermark present (light pixels in the bottom-right)", any(sum(im.convert("RGB").getpixel((x, 1060))) > 600 for x in range(760, 1060, 4)))

        print("\n3. Contain + background + PNG with corners keeps transparency")
        page.select_option("[form=settings][name=preset]", "ig-story"); page.select_option("[form=settings][name=fit]", "contain")
        page.fill("[form=settings][name=bg]", "#222222"); page.select_option("[form=settings][name=format]", "png"); page.fill("[form=settings][name=maxKB]", "")
        page.fill("[form=settings][name=corners]", "30")
        apply(page)
        with page.expect_download() as dl_info:
            page.click("a.button-link")
        data = open(dl_info.value.path(), "rb").read(); im = Image.open(io.BytesIO(data)).convert("RGBA")
        check("story size, PNG, transparent corner, padded band", im.size == (1080, 1920) and im.getpixel((0, 0))[3] == 0 and im.getpixel((540, 100))[:3] == (34, 34, 34), f"{im.size} corner={im.getpixel((0,0))} pad={im.getpixel((540,100))}")

        print("\n4. Invalid combination is caught on the page")
        page.fill("[form=settings][name=maxKB]", "100"); apply(page)
        check("banner explains PNG + maxKB", "maxKB applies to JPEG and WebP only" in page.locator("p.error").inner_text())
        check("Download disabled, preview still shown", page.get_attribute("a.button-link", "aria-disabled") == "true" and page.evaluate("() => document.querySelector('.preview img').naturalWidth > 0"))
        browser.close()
finally:
    server.terminate()

print("\nSummary: %d/%d checks passed" % (sum(results), len(results)))
sys.exit(0 if all(results) else 1)
