"""
Optional browser test (not part of `npm test`): the Collage card as a user sees it -
pick a template, choose a picture per cell, set the gutter, Apply; the preview is the
collage; guides draw numbered cells; Download gives the collage; Mobile view shows it
inside the phone frame; a bad gutter shows the banner and keeps the page usable.

Requires: python3, pillow, playwright (+ Chromium).  Run from the project root:
    python3 tests/browser/collage.test.py
"""
import io, os, subprocess, sys, time, urllib.request
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

        print("\n1. Collage card: pick a template, fill cells, Apply")
        page.goto(URL + "?image=photo"); page.wait_for_load_state("networkidle")
        cards = page.evaluate("() => [...document.querySelectorAll('.controls .card h2')].map(h => h.textContent.trim())")
        check("Collage card present, after Android", cards[-2:] == ["Android", "Collage"], str(cards))
        check("cell 1 defaults to the selected image", page.eval_on_selector("select[name=cells]", "s => s.value") == "photo")
        page.select_option("[form=settings][name=layout]", "grid-2x2")
        page.select_option("[form=settings][name=preset]", "ig-square")
        cells = page.locator("select[name=cells]")
        cells.nth(1).select_option("fhd"); cells.nth(2).select_option("portrait"); cells.nth(3).select_option("")
        page.fill("[form=settings][name=gutter]", "3%")
        page.fill("[form=settings][name=bg]", "#202020")
        apply(page)
        ctx = page.locator("section[aria-labelledby=h-col] .context").inner_text()
        check("context line", "grid-2x2 · 1080×1080 · 4 cells (3 filled) · gutter 32 px · cover" in ctx, ctx)
        import re as _re
        check("URL carries the collage (one cells= per picker, interleaved with its fit)", "layout=grid-2x2" in page.url and _re.findall(r"cells=([a-z0-9-]*)", page.url) == ["photo", "fhd", "portrait", ""], page.url)
        check("preview is the 1080x1080 collage", page.evaluate("() => { const i = document.querySelector('.preview img'); return i.complete && i.naturalWidth === 1080 && i.naturalHeight === 1080; }"))
        src = page.get_attribute(".preview img", "src")
        data = urllib.request.urlopen(f"http://127.0.0.1:{PORT}{src}").read()
        im = Image.open(io.BytesIO(data)).convert("RGB")
        check("empty cell 4 shows the background (#202020)", im.getpixel((810, 810)) == (0x20, 0x20, 0x20), str(im.getpixel((810, 810))))
        check("gutter shows the background", im.getpixel((540, 270)) == (0x20, 0x20, 0x20), str(im.getpixel((540, 270))))
        check("cell 1 has picture content (beach sky is blue-ish)", im.getpixel((270, 100))[2] > 150, str(im.getpixel((270, 100))))
        check("pickers echo the choice", [page.eval_on_selector_all("select[name=cells]", "s => s.map(x => x.value)")] == [["photo", "fhd", "portrait", ""]])

        print("\n2. Guides: numbered cell outlines over the preview")
        page.check("[form=settings][name=guides]"); apply(page)
        check("4 dashed cell rectangles", page.locator("rect.cell-guide").count() == 4)
        check("labels 1..4", page.eval_on_selector_all("text.cell-guide-label", "t => t.map(x => x.textContent).join('')") == "1234")
        check("legend text", "template's cells" in page.locator(".overlay-legend").inner_text())

        print("\n3. Download the collage")
        page.select_option("[form=settings][name=format]", "jpeg"); apply(page)
        with page.expect_download() as dl_info:
            page.click("section[aria-labelledby=h-exp] a.button-link")
        dl = dl_info.value
        check("file name names the layout", dl.suggested_filename == "collage-grid-2x2-ig-square-1080x1080.jpg", dl.suggested_filename)
        im2 = Image.open(dl.path())
        check("1080x1080 JPEG", im2.size == (1080, 1080) and im2.format == "JPEG", f"{im2.size} {im2.format}")

        print("\n4. Mobile view shows the collage in the phone frame")
        page.click("nav.mode-switch a:has-text('Mobile')"); page.wait_for_load_state("networkidle")
        frame_src = page.get_attribute("iframe", "src")
        check("frame src carries the collage", "layout=grid-2x2" in frame_src and "embed=image" in frame_src, frame_src)
        frame = page.frame_locator("iframe")
        check("collage visible inside the frame", frame.locator("img").evaluate("i => i.complete && i.naturalWidth === 1080"))
        check("template still selected in the form", page.eval_on_selector("select[name=layout]", "s => s.value") == "grid-2x2")

        print("\n5. Bad gutter: banner, fallback image, form keeps the typed value")
        page.click("nav.mode-switch a:has-text('Desktop')"); page.wait_for_load_state("networkidle")
        page.fill("[form=settings][name=gutter]", "99%"); apply(page)
        banner = page.locator("p.error").first.inner_text()
        check("banner explains", "gutter must be" in banner, banner)
        check("image still loads (fallback)", page.evaluate("() => { const i = document.querySelector('.preview img'); return i.complete && i.naturalWidth > 0; }"))
        check("typed gutter kept in the field", page.input_value("[form=settings][name=gutter]") == "99%")
        check("template still selected", page.eval_on_selector("select[name=layout]", "s => s.value") == "grid-2x2")

        print("\n6. Back to single image: None")
        page.fill("[form=settings][name=gutter]", "2%"); page.select_option("[form=settings][name=layout]", "none")
        apply(page)
        check("layout=none in the URL (every form field is submitted), no collage in the image src", "layout=none" in page.url and "layout=" not in page.get_attribute(".preview img", "src"), page.get_attribute(".preview img", "src"))
        check("context back to single image", "Single image" in page.locator("section[aria-labelledby=h-col] .context").inner_text())

        print("\n7. Phase 2: template gallery, shaped pickers with per-cell fit, watermark toast")
        page.goto(URL + "?image=photo&preset=yt-thumb"); page.wait_for_load_state("networkidle")
        check("gallery has None + 11 template chips with sketches", page.locator("a.tchip").count() == 12 and page.locator("svg.tsketch").count() == 12)
        page.click("a.tchip:has-text('Hero left + 2 stacked')"); page.wait_for_load_state("networkidle")
        check("clicking a chip selects the template and keeps the preset", page.eval_on_selector("select[name=layout]", "s => s.value") == "hero-3" and "preset=yt-thumb" in page.url)
        check("active chip marked", page.locator("a.tchip.active").inner_text().strip() == "Hero left + 2 stacked")
        boxes = page.eval_on_selector_all(".cell-box", "b => b.map(x => [Math.round(parseFloat(x.style.left)), Math.round(parseFloat(x.style.width))])")
        check("cell boxes follow the template shape (hero: 0/67 wide, 67/33, 67/33)", boxes == [[0, 67], [67, 33], [67, 33]], str(boxes))
        grid_box = page.locator(".cell-grid").bounding_box()
        check("cell grid has the canvas aspect (16:9)", abs(grid_box["width"] / grid_box["height"] - 16 / 9) < 0.05, f"{grid_box['width']:.0f}x{grid_box['height']:.0f}")
        page.locator("select[name=cells]").nth(1).select_option("portrait")
        page.locator("select[name=cells]").nth(2).select_option("fhd")
        page.locator("select[name=cellFit]").nth(1).select_option("contain")
        page.check("[form=settings][name=wm]"); page.fill("[form=settings][name=wmWidth]", "30%")
        apply(page)
        ctx = page.locator("section[aria-labelledby=h-col] .context").inner_text()
        check("context says mixed fits", "mixed" in ctx, ctx)
        check("image src carries the per-cell list", "cellFit=cover%2Ccontain%2Ccover" in page.get_attribute(".preview img", "src"), page.get_attribute(".preview img", "src"))
        src = page.get_attribute(".preview img", "src")
        im = Image.open(io.BytesIO(urllib.request.urlopen(f"http://127.0.0.1:{PORT}{src}").read())).convert("RGB")
        check("cell 2 (contain, tall photo in a wide cell) has white bars at its sides", im.getpixel((870, 100)) == (255, 255, 255), str(im.getpixel((870, 100))))
        toasts = page.locator(".toast").all_inner_texts()
        check("watermark-overlap toast names the cell it covers", any("overlaps cell 3" in t for t in toasts), str(toasts))
        check("margin field is blank by default (automatic) with the effective value as placeholder", page.input_value("[form=settings][name=wmMargin]") == "" and page.get_attribute("[form=settings][name=wmMargin]", "placeholder") == "auto: 16")
        page.fill("[form=settings][name=gutter]", "40"); page.fill("[form=settings][name=wmWidth]", "200")
        apply(page)
        check("with a 40 px gutter the automatic margin puts the mark in the band: no overlap toast, placeholder shows 11", page.locator(".toast").count() == 0 and page.get_attribute("[form=settings][name=wmMargin]", "placeholder") == "auto: 11", page.get_attribute("[form=settings][name=wmMargin]", "placeholder"))

        print("\n8. Phase 3: per-cell nudge")
        page.goto(URL + "?layout=split-v&cells=panorama,panorama&preset=ig-square"); page.wait_for_load_state("networkidle")
        before_src = page.get_attribute(".preview img", "src")
        page.locator(".cell-box input[name=cellX]").nth(0).fill("-900")
        apply(page)
        check("nudge field echoed and forwarded", page.input_value(".cell-box input[name=cellX] >> nth=0") == "-900" and "cellX=-900%2C0" in page.get_attribute(".preview img", "src"), page.get_attribute(".preview img", "src"))
        im_a = Image.open(io.BytesIO(urllib.request.urlopen(f"http://127.0.0.1:{PORT}{before_src}").read())).convert("RGB")
        im_b = Image.open(io.BytesIO(urllib.request.urlopen(f"http://127.0.0.1:{PORT}{page.get_attribute('.preview img', 'src')}").read())).convert("RGB")
        check("top cell changed, bottom cell unchanged", im_a.crop((0, 0, 1080, 500)).tobytes() != im_b.crop((0, 0, 1080, 500)).tobytes() and im_a.crop((0, 580, 1080, 1080)).tobytes() == im_b.crop((0, 580, 1080, 1080)).tobytes())
        page.locator(".cell-box input[name=cellX]").nth(1).fill("4000")
        apply(page)
        toasts = page.locator(".toast").all_inner_texts()
        check("out-of-range nudge: toast with the clamped value, field shows it", any("Cell 2 nudge X 4000 is out of range" in t for t in toasts) and page.input_value(".cell-box input[name=cellX] >> nth=1") == "0", str(toasts))

        print("\n9. Watermark green tone")
        page.goto(URL + "?image=fhd&wm=1&wmWidth=30%&wmOpacity=100"); page.wait_for_load_state("networkidle")
        check("tone controls present: checkbox off, slider, gradient", page.locator("input[name=wmToneOn]").is_checked() is False and page.locator("input[name=wmTone]").count() == 1 and page.locator(".tone-scale").count() == 1)
        base_src = page.get_attribute(".preview img", "src")
        check("unchecked: tone not in the image URL", "wmTone" not in base_src, base_src)
        page.check("input[name=wmToneOn]")
        page.evaluate("() => { const s = document.querySelector('input[type=range][name=wmTone]'); s.value = 10; s.dispatchEvent(new Event('input', { bubbles: true })); }")
        check("slider live value updates without a round trip", page.locator(".slider output").nth(0).inner_text() == "10")
        apply(page)
        check("checked: tone forwarded and in the context line", "wmTone=10" in page.get_attribute(".preview img", "src") and "Green tone 10" in page.locator(".wm-status").inner_text())
        im_l = Image.open(io.BytesIO(urllib.request.urlopen(f"http://127.0.0.1:{PORT}{page.get_attribute('.preview img', 'src')}").read())).convert("RGB")
        page.evaluate("() => { document.querySelector('input[type=range][name=wmTone]').value = 95; }")
        apply(page)
        im_d = Image.open(io.BytesIO(urllib.request.urlopen(f"http://127.0.0.1:{PORT}{page.get_attribute('.preview img', 'src')}").read())).convert("RGB")
        # sample the mark area (bottom-right 30% wide): the light tone is brighter than the dark tone
        def mark_brightness(im):
            px = [im.getpixel((x, y)) for x in range(1340, 1900, 7) for y in range(1030, 1064, 3)]
            return sum(sum(p) for p in px) / len(px)
        check("tone 10 is brighter than tone 95 in the mark area", mark_brightness(im_l) > mark_brightness(im_d) + 40, f"{mark_brightness(im_l):.0f} vs {mark_brightness(im_d):.0f}")
        with page.expect_download() as dl_info:
            page.click("section[aria-labelledby=h-exp] a.button-link")
        check("download carries the tone", "wmTone=95" in dl_info.value.url)

        print("\n10. I-8: the default watermark is visible on a default (white) collage")
        page.goto(URL + "?image=sample&layout=grid-2x2&cells=sample&cells=sample&cells=&cells=&wm=1"); page.wait_for_load_state("networkidle")
        src = page.get_attribute(".preview img", "src")
        im = Image.open(io.BytesIO(urllib.request.urlopen(f"http://127.0.0.1:{PORT}{src}").read())).convert("RGB")
        band = [im.getpixel((x, y)) for x in range(880, 1078, 2) for y in range(1060, 1078, 2)]
        dark = [p for p in band if sum(p) < 450]
        check("mark pixels in the band are dark (a human can see them on white)", len(dark) > 150, f"{len(dark)} dark of {len(band)} sampled")
        check("the dark pixels are green", all(p[1] >= p[0] and p[1] >= p[2] for p in dark))
        check("status explains the automatic tone", "Green tone 100 (automatic" in page.locator(".wm-status").inner_text())
        check("no toast on the default", page.locator(".toast").count() == 0)
        page.check("input[name=wmToneOn]"); page.evaluate("() => { document.querySelector('input[type=range][name=wmTone]').value = 0; }")
        apply(page)
        check("a poor manual tone gets the low-contrast toast", any("low contrast" in t for t in page.locator(".toast").all_inner_texts()), str(page.locator(".toast").all_inner_texts()))

        browser.close()
finally:
    server.terminate()

print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
