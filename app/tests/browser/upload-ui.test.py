"""
Optional browser test (not part of `npm test`): the redesigned UI end to end as a
regular user - pick a stock image, upload a photo through the file input, see it
selected with its name and size, use % width, remove it; check the layout has no
overflow at desktop and phone widths.

Uses an isolated uploads directory (SHARP_VIEWER_UPLOADS). Requires: python3,
pillow, playwright (+ Chromium).  Run from the project root:
    python3 tests/browser/upload-ui.test.py
"""
import os, shutil, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright

PROJECT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT = 3495
URL = f"http://127.0.0.1:{PORT}/"
tmp = tempfile.mkdtemp(prefix="uploads-ui-")
results = []

def check(name, ok, detail=""):
    results.append(ok)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" - {detail}" if detail else ""))

def apply(page):
    """Click Apply and wait for the in-place update (spec 4l): busy flag set on click, cleared after the swap."""
    page.click("button.primary")
    page.wait_for_function("() => !document.querySelector('main').getAttribute('aria-busy')")
    page.wait_for_timeout(60)

server = subprocess.Popen(["node", "src/server.ts"], cwd=PROJECT,
                          env={**os.environ, "PORT": str(PORT), "SHARP_VIEWER_UPLOADS": tmp},
                          stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
for _ in range(50):
    try:
        urllib.request.urlopen(URL, timeout=1); break
    except Exception:
        time.sleep(0.1)

try:
    # A phone-style photo with an EXIF rotation, made with sharp.
    photo = os.path.join(tmp, "IMG_0042.jpg")
    subprocess.run(["node", "-e", f'require("sharp")({{create:{{width:1200,height:800,channels:3,background:"#e11d48"}}}}).jpeg().withMetadata({{orientation:6}}).toFile("{photo}")'], cwd=PROJECT, check=True)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1200, "height": 1000})
        no_overflow = lambda: page.evaluate("() => document.documentElement.scrollWidth <= document.documentElement.clientWidth")

        print("\n1. Layout")
        page.goto(URL); page.wait_for_load_state("networkidle")
        check("no horizontal overflow at 1200 px", no_overflow())
        check("header: title, Desktop/Mobile/In context switch, Guide + Spec", page.locator(".brand").count() == 1 and page.locator(".mode-switch a").count() == 3 and page.locator(".spec-link").count() == 2)
        check("control sections: Image, Watermark, Enhance, Watermark position, Output, Export, Android, Collage",
              page.evaluate("() => [...document.querySelectorAll('.controls .card h2')].map(h => h.textContent.trim())") == ["Image", "Watermark", "Enhance", "Watermark position", "Output", "Export", "Android", "Collage"])
        check("one Apply (primary) button", page.locator("button.primary").count() == 1)
        page.screenshot(path="/tmp/ui-final-desktop.png", full_page=True)

        print("\n2. Pick a stock image with % width")
        page.select_option("[form=settings][name=image]", "panorama"); page.check("[form=settings][name=wm]"); page.fill("[form=settings][name=wmWidth]", "15%"); apply(page)
        check("image context shows the stock image", "panorama.png · 4000×1000 · PNG · stock" in page.locator("section[aria-labelledby=h-image] .context").inner_text())
        check("watermark context shows the resolved mark size (15% of 4000 = 600)", "600×54 px" in page.locator(".wm-status").inner_text())
        check("image loaded", page.evaluate("() => document.querySelector('.preview img').naturalWidth === 4000"))

        print("\n3. Upload through the file input")
        page.set_input_files("input[type=file]", photo); page.click("form[action='/upload'] button[type=submit]"); page.wait_for_load_state("networkidle")
        check("redirected with the upload selected and settings kept", "image=u-" in page.url and "wm=1" in page.url and "wmWidth=15%25" in page.url, page.url)
        ctx = page.locator("section[aria-labelledby=h-image] .context").inner_text()
        check("context shows the file name, upright size and 'uploaded'", "IMG_0042.jpg · 800×1200 · JPEG · uploaded" in ctx, ctx)
        check("picker lists it under 'Your uploads' and it is selected", page.locator("[form=settings][name=image] optgroup[label='Your uploads'] option[selected]").count() == 1)
        check("image loaded upright (800x1200)", page.evaluate("() => { const i = document.querySelector('.preview img'); return i.naturalWidth === 800 && i.naturalHeight === 1200; }"))
        check("Remove button appears", page.locator("button.danger").count() == 1)
        page.screenshot(path="/tmp/ui-final-upload.png", full_page=True)

        print("\n4. Mobile view with the upload, then remove it")
        page.click(".mode-switch a:has-text('Mobile')"); page.wait_for_load_state("networkidle")
        fi = page.frame_locator("iframe"); fi.locator("img").wait_for()
        check("frame shows the upload", "image=u-" in fi.locator("img").get_attribute("src"))
        page.click("button.danger"); page.wait_for_load_state("networkidle")
        check("after removal the sample is selected and we are still in Mobile view", "image=u-" not in page.url and "view=mobile" in page.url and "sample.png" in page.locator("section[aria-labelledby=h-image] .context").inner_text(), page.url)
        check("uploads directory is empty again", not [f for f in os.listdir(tmp) if f.startswith("u-")])

        print("\n5. Rejected upload keeps the page usable")
        bad = os.path.join(tmp, "notes.txt"); open(bad, "w").write("hello")
        page.set_input_files("input[type=file]", bad); page.click("form[action='/upload'] button[type=submit]"); page.wait_for_load_state("networkidle")
        check("error banner", "not an image" in page.locator("p.error").inner_text())
        check("image still shown", page.evaluate("() => document.querySelector('.preview img, iframe') !== null"))

        print("\n6. Phone width")
        page.set_viewport_size({"width": 390, "height": 800}); page.goto(URL + "?wm=1"); page.wait_for_load_state("networkidle")
        check("no horizontal overflow at 390 px", no_overflow())
        check("controls stack in one column", page.evaluate("() => { const c = [...document.querySelectorAll('.controls .card')]; return c.every(e => e.getBoundingClientRect().width > 300); }"))
        browser.close()
finally:
    server.terminate()
    shutil.rmtree(tmp, ignore_errors=True)

print("\nSummary: %d/%d checks passed" % (sum(results), len(results)))
sys.exit(0 if all(results) else 1)
