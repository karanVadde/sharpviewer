"""
Optional browser test (not part of `npm test`): the In-context view (spec 4.9) as a user sees it -
switch to it, the grid tile really is the chosen size and carries the watermark, the legibility
toast appears and goes away with a bigger mark, list / feed scenes, dark theme, the feed on a phone,
and live updates keep the scene.

Requires: python3, pillow, playwright (+ Chromium).  Run from the project root:
    python3 tests/browser/context.test.py
"""
import io, os, subprocess, sys, time, urllib.request
from PIL import Image
from playwright.sync_api import sync_playwright

PROJECT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT = 3496
URL = f"http://127.0.0.1:{PORT}/"
results = []

def check(name, ok, detail=""):
    results.append(ok)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" - {detail}" if detail else ""))

def settled(page, needle):
    """Wait for a live update: the URL carries the change and the in-place swap has finished."""
    page.wait_for_function(f"() => location.search.includes('{needle}') && !document.querySelector('main').getAttribute('aria-busy')")
    page.wait_for_timeout(300)  # not networkidle: the device-frame iframe keeps the network busy for a while

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
        page = browser.new_page(viewport={"width": 1200, "height": 900})

        print("\n1. Switch to In context: grid of 9 tiles, ours in the centre at the real size, watermark inside it")
        page.goto(URL + "?image=photo&preset=ig-square&wm=1&wmWidth=20%"); page.wait_for_load_state("networkidle")
        page.click("nav.mode-switch a:has-text('In context')"); page.wait_for_load_state("domcontentloaded")
        toasts_early = page.locator(".toast").all_inner_texts()  # server-rendered; read before the 6 s auto-dismiss (tile renders can be slow)
        page.wait_for_load_state("networkidle")
        check("URL has view=context", "view=context" in page.url)
        tiles = page.locator("img.tile")
        check("9 tiles", tiles.count() == 9)
        ours = page.locator("img.tile.ours")
        box = ours.bounding_box()
        check("our tile is rendered at 150x150 CSS px", abs(box["width"] - 150) < 1 and abs(box["height"] - 150) < 1, f"{box['width']}x{box['height']}")
        check("the tile image is a real 150 px render (not CSS-scaled)", ours.evaluate("i => i.naturalWidth === 150 && i.naturalHeight === 150"))
        src = ours.get_attribute("src")
        im = Image.open(io.BytesIO(urllib.request.urlopen(f"http://127.0.0.1:{PORT}{src}").read())).convert("RGB")
        plain = Image.open(io.BytesIO(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/image?image=photo&preset=ig-square&thumb=150x150").read())).convert("RGB")
        diff = sum(1 for x in range(90, 150) for y in range(135, 150) if im.getpixel((x, y)) != plain.getpixel((x, y)))
        check("the scaled watermark is present in the tile's corner", diff > 50, f"{diff} differing px")
        check("legibility toast: unreadable at 150 px", any("unreadable" in t and "150 px tiles" in t for t in toasts_early), str(toasts_early))

        print("\n1b. Placement review: a 4:5 post loses its mark to the square crop; the fix chip moves it into the safe square")
        page.goto(URL + "?image=photo&preset=ig-portrait&wm=1&wmWidth=59%&view=context", wait_until="domcontentloaded")
        toasts = page.locator(".toast").all_inner_texts()
        page.wait_for_load_state("networkidle")
        check("crop toast names the band and the fix", any("cuts off 100% of the watermark" in t and "traverseY -135" in t for t in toasts), str(toasts))
        before = Image.open(io.BytesIO(urllib.request.urlopen(f"http://127.0.0.1:{PORT}{page.get_attribute('img.tile.ours', 'src')}").read())).convert("RGB")
        page.click("a.chip.fix"); page.wait_for_load_state("domcontentloaded")
        toasts_after = page.locator(".toast").all_inner_texts(); page.wait_for_load_state("networkidle")
        check("chip applied traverseY=-135 and the crop toast is gone", "traverseY=-135" in page.url and not any("cuts off" in t for t in toasts_after))
        after = Image.open(io.BytesIO(urllib.request.urlopen(f"http://127.0.0.1:{PORT}{page.get_attribute('img.tile.ours', 'src')}").read())).convert("RGB")
        plain = Image.open(io.BytesIO(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/image?image=photo&preset=ig-portrait&thumb=150x150").read())).convert("RGB")
        d_before = sum(1 for x in range(0, 150, 2) for y in range(100, 150, 2) if before.getpixel((x, y)) != plain.getpixel((x, y)))
        d_after = sum(1 for x in range(0, 150, 2) for y in range(100, 150, 2) if after.getpixel((x, y)) != plain.getpixel((x, y)))
        check("the tile really shows the mark after the fix (and did not before)", d_before < 20 and d_after > 150, f"before {d_before}, after {d_after} differing samples")

        print("\n2. A bigger mark removes the toast; size chips change the tiles live")
        page.goto(URL + "?image=photo&preset=ig-square&wm=1&wmWidth=20%&view=context"); page.wait_for_load_state("networkidle")
        page.fill("[form=settings][name=wmWidth]", "60%"); page.press("[form=settings][name=wmWidth]", "Tab"); settled(page, "wmWidth=60%25")
        page.click("a.chip:has-text('240')"); page.wait_for_load_state("networkidle")
        check("240 px tiles", page.locator("img.tile.ours").evaluate("i => i.naturalWidth === 240"))
        check("no legibility toast with a 60% mark on 240 px tiles", page.locator(".toast").count() == 0)

        print("\n3. List scene, dark theme")
        page.click("a.chip:has-text('List')"); page.wait_for_load_state("networkidle")
        check("5 rows, ours in the middle", page.locator("li.row").count() == 5 and page.locator("li.row").nth(2).get_attribute("class") == "row ours")
        page.click("a.chip:has-text('48')"); page.wait_for_load_state("networkidle")
        check("48 px thumbnails", page.locator("li.row.ours img").evaluate("i => i.naturalWidth === 48"))
        page.click("a.chip:has-text('Dark')"); page.wait_for_load_state("networkidle")
        check("dark scene", "dark" in page.get_attribute(".scene", "class"))
        bg = page.evaluate("() => getComputedStyle(document.querySelector('.scene')).backgroundColor")
        check("dark background really is dark", bg in ("rgb(17, 17, 17)",), bg)

        print("\n4. Feed: desktop column, then on a phone")
        page.click("a.chip:has-text('Feed')"); page.wait_for_load_state("networkidle")
        check("3 posts, ours in the middle", page.locator("article.post").count() == 3 and "ours" in page.locator("article.post").nth(1).get_attribute("class"))
        check("our post image is 470 px wide", page.locator("article.post.ours img").evaluate("i => i.naturalWidth === 470"))
        check("the feed scrolled our post into view", page.evaluate("() => { const s = document.querySelector('.scene-feed'); const o = s.querySelector('.post.ours'); const r = o.getBoundingClientRect(), sr = s.getBoundingClientRect(); return r.top >= sr.top - 5 && r.top < sr.bottom; }"))
        page.click("a.chip:has-text('On a phone')"); page.wait_for_load_state("networkidle")
        check("device frame with an iframe", page.locator("iframe").count() == 1 and "embed=scene" in page.get_attribute("iframe", "src"))
        page.click("a.chip:has-text('Pixel 7')"); page.wait_for_load_state("networkidle")
        frame = page.frame_locator("iframe")
        frame.locator("article.post.ours img").wait_for()
        check("inside the phone our post renders at the device width (412)", frame.locator("article.post.ours img").evaluate("i => i.naturalWidth === 412"))
        check("device chips present, Pixel 7 active", page.locator("a.chip.active:has-text('Pixel 7')").count() == 1)

        print("\n5. Live updates keep the scene; Desktop tab returns to the plain preview")
        page.check("[form=settings][name=grayscale]"); settled(page, "grayscale=1")
        check("still in the feed on the phone after a live change", "scene=feed" in page.url and "frame=1" in page.url and page.locator("iframe").count() == 1)
        page.click("nav.mode-switch a:has-text('Desktop')"); page.wait_for_load_state("networkidle")
        check("back to the plain preview", page.locator(".preview img").count() == 1 and page.locator(".scene").count() == 0)

        browser.close()
finally:
    server.terminate()

print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
