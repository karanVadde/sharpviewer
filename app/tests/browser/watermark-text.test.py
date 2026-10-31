"""
Optional browser test (not part of `npm test`): a regular user changes the
watermark text from the page - type, click "Set text", see it in the image;
"Restore stock" brings the original back. Also checks the flow from Mobile view.

Uses an isolated custom-watermark file (SHARP_VIEWER_CUSTOM_WATERMARK) so the
project's files are never touched.

Requires: python3, playwright (+ Chromium).  Run from the project root:
    python3 tests/browser/watermark-text.test.py
"""
import os, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright

PROJECT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT = 3490
URL = f"http://127.0.0.1:{PORT}/"
tmp = tempfile.mkdtemp(prefix="wm-ui-")
custom = os.path.join(tmp, "watermark.custom.svg")
results = []

def check(name, ok, detail=""):
    results.append(ok)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" - {detail}" if detail else ""))

server = subprocess.Popen(["node", "src/server.ts"], cwd=PROJECT,
                          env={**os.environ, "PORT": str(PORT), "SHARP_VIEWER_CUSTOM_WATERMARK": custom},
                          stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
for _ in range(50):
    try:
        urllib.request.urlopen(URL, timeout=1); break
    except Exception:
        time.sleep(0.1)

try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 1100})
        img_bytes = lambda: page.request.get(URL.rstrip("/") + page.get_attribute("img", "src")).body()

        print("\n1. Desktop: set a custom text")
        page.goto(URL + "?wm=1&wmWidth=420&traverseX=-60&traverseY=-40"); page.wait_for_load_state("networkidle")
        check("text field pre-filled with the stock text", page.input_value("input[name=text]") == "SHARP VIEWER")
        check("no Restore button while stock is active", page.locator("button[value=restore]").count() == 0)
        stock_img = img_bytes()
        page.fill("input[name=text]", "ACME CORP 2026"); page.click("button[name=action][value=set]"); page.wait_for_load_state("networkidle")
        check("redirected back with the same settings", "wm=1&wmWidth=420&traverseX=-60&traverseY=-40" in page.url, page.url)
        check("status shows the custom mark", '"ACME CORP 2026" (custom)' in page.locator(".wm-status").inner_text())
        check("Restore button appears", page.locator("button[value=restore]").count() == 1)
        custom_img = img_bytes()
        check("image changed and loads", custom_img != stock_img and page.evaluate("() => document.querySelector('img').naturalWidth > 0"))
        check("custom file written to the isolated path, project file untouched",
              os.path.exists(custom) and not os.path.exists(os.path.join(PROJECT, "public", "watermark.custom.svg")))

        print("\n2. Invalid text keeps the page usable")
        page.fill("input[name=text]", "日本語"); page.click("button[name=action][value=set]"); page.wait_for_load_state("networkidle")
        check("error banner explains the problem", "no glyph for" in page.locator("p.error").inner_text())
        check("typed text kept in the field", page.input_value("input[name=text]") == "日本語")
        check("image still shows the (previous) custom mark", img_bytes() == custom_img and page.evaluate("() => document.querySelector('img').naturalWidth > 0"))

        print("\n3. Mobile view: the same box works under the frame")
        page.goto(URL + "?wm=1&wmWidth=420&view=mobile&device=pixel-7&orientation=landscape"); page.wait_for_load_state("networkidle")
        page.fill("input[name=text]", "MOBILE MARK"); page.click("button[name=action][value=set]"); page.wait_for_load_state("networkidle")
        check("stays in Mobile view on the same device", "view=mobile&device=pixel-7&orientation=landscape" in page.url, page.url)
        fi = page.frame_locator("iframe"); fi.locator("img").wait_for()
        frame_img = page.request.get(URL.rstrip("/") + fi.locator("img").get_attribute("src")).body()
        check("frame shows the new mark", frame_img != custom_img and frame_img != stock_img)

        print("\n4. Restore stock")
        page.click("button[value=restore]"); page.wait_for_load_state("networkidle")
        check("status back to stock", '(stock)' in page.locator(".wm-status").inner_text())
        check("custom file removed", not os.path.exists(custom))
        page.goto(URL + "?wm=1&wmWidth=420&traverseX=-60&traverseY=-40"); page.wait_for_load_state("networkidle")
        check("image is byte-identical to the original stock render", img_bytes() == stock_img)
        browser.close()
finally:
    server.terminate()
    import shutil; shutil.rmtree(tmp, ignore_errors=True)

print("\nSummary: %d/%d checks passed" % (sum(results), len(results)))
sys.exit(0 if all(results) else 1)
