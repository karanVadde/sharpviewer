"""
Optional browser test (not part of `npm test`): the Android card as a developer uses it -
name + dp, the density and device tables, Download ZIP (opened with Python's zipfile and
checked folder by folder), the launcher-icon mode with the safe-zone guides, and the
system-bar / cut-out guides on device frames.

Requires: python3, pillow, playwright (+ Chromium).  Run from the project root:
    python3 tests/browser/android.test.py
"""
import io, os, subprocess, sys, time, urllib.request, zipfile
from PIL import Image
from playwright.sync_api import sync_playwright

PROJECT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT = 3499
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

        print("\n1. Drawable set from the 1600x1200 photo")
        page.goto(URL + "?image=photo&wm=1&wmWidth=20%"); page.wait_for_load_state("networkidle")
        page.fill("[form=settings][name=androidName]", "hero_banner"); page.fill("[form=settings][name=dp]", "360")
        apply(page)
        ctx = page.locator("section[aria-labelledby=h-and] .context").inner_text()
        check("context line", "hero_banner · 360 dp · 360/540/720/1080/1440 px · PNG · source sufficient" in ctx, ctx)
        check("density table: 5 OK rows", page.locator("section[aria-labelledby=h-and] table.mini").nth(0).locator("td.ok").count() == 5)
        check("device table: 10 devices, all OK", page.locator("section[aria-labelledby=h-and] table.mini").nth(1).locator("tbody tr").count() == 10 and page.locator("section[aria-labelledby=h-and] table.mini").nth(1).locator("td.warn").count() == 0)
        with page.expect_download() as dl:
            page.click("section[aria-labelledby=h-and] a.button-link")
        path = dl.value.path()
        check("file name", dl.value.suggested_filename == "hero_banner-android.zip", dl.value.suggested_filename)
        z = zipfile.ZipFile(path)
        check("zip is valid (testzip)", z.testzip() is None)
        names = z.namelist()
        check("folder layout", names == [f"res/drawable-{b}/hero_banner.png" for b in ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"]] + ["README.txt"], str(names))
        sizes = [Image.open(io.BytesIO(z.read(n))).size for n in names[:5]]
        check("sizes per bucket", sizes == [(360, 270), (540, 405), (720, 540), (1080, 810), (1440, 1080)], str(sizes))
        check("README lists the files", "res/drawable-xxxhdpi/hero_banner.png: 1440x1080 px (4x)" in z.read("README.txt").decode())

        print("\n2. Upscale warnings from the 320x240 thumb")
        page.select_option("[form=settings][name=image]", "thumb"); apply(page)
        warn = page.locator("section[aria-labelledby=h-and] table.mini").nth(0).locator("td.warn").all_inner_texts()
        check("all five buckets flagged with factors", warn == ["upscaled ×1.1", "upscaled ×1.7", "upscaled ×2.3", "upscaled ×3.4", "upscaled ×4.5"], str(warn))
        check("summary says 5 of 5 upscaled", "5 of 5 buckets upscaled" in page.locator("section[aria-labelledby=h-and] .context").inner_text())
        page.screenshot(path="/tmp/android-card-page.png", full_page=True)

        print("\n3. Launcher icon mode + safe-zone guides")
        page.select_option("[form=settings][name=image]", "photo"); page.select_option("[form=settings][name=androidMode]", "icon")
        page.fill("[form=settings][name=androidName]", ""); page.fill("[form=settings][name=bg]", "#1f2933"); page.check("[form=settings][name=guides]")
        apply(page)
        check("preview shows the adaptive icon (432 px square)", page.evaluate("() => { const i = document.querySelector('.preview img'); return i.src.includes('/android/icon-preview') && i.naturalWidth === 432 && i.naturalHeight === 432; }"))
        check("safe-zone guide circles drawn over it", page.locator("svg.overlay circle").count() == 2 and "66 dp safe zone" in page.locator(".overlay-legend").inner_text())
        with page.expect_download() as dl:
            page.click("section[aria-labelledby=h-and] a.button-link")
        z = zipfile.ZipFile(dl.value.path()); names = z.namelist()
        check("icon zip: 19 entries incl. XML and Play Store icon", len(names) == 19 and "res/mipmap-anydpi-v26/ic_launcher.xml" in names and "playstore/ic_launcher-512.png" in names, str(len(names)))
        fg = Image.open(io.BytesIO(z.read("res/mipmap-xxxhdpi/ic_launcher_foreground.png"))).convert("RGBA")
        check("xxxhdpi foreground 432 px with transparent padding and image in the centre", fg.size == (432, 432) and fg.getpixel((0, 0))[3] == 0 and fg.getpixel((216, 216))[3] == 255)
        page.locator(".preview").screenshot(path="/tmp/android-icon-guides.png")

        print("\n4. Device-frame guides")
        page.goto(URL + "?wm=1&view=mobile&device=iphone-13&guides=1"); page.wait_for_load_state("networkidle")
        fi = page.frame_locator("iframe"); fi.locator("img").wait_for()
        g = page.locator(".device-frame .guides")
        check("status bar, nav bar and notch overlays are visible", g.locator(".status").is_visible() and g.locator(".nav").is_visible() and g.locator(".cutout.notch").is_visible())
        check("status bar is 24 CSS px tall, nav bar 48", g.locator(".status").bounding_box()["height"] == 24 and g.locator(".nav").bounding_box()["height"] == 48)
        page.goto(URL + "?wm=1&view=mobile&device=pixel-7&guides=1"); page.wait_for_load_state("networkidle")
        check("Pixel 7 shows a punch-hole", page.locator(".guide.cutout.punch").count() == 1)
        browser.close()
finally:
    server.terminate()

print("\nSummary: %d/%d checks passed" % (sum(results), len(results)))
sys.exit(0 if all(results) else 1)
