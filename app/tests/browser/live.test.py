"""
Optional browser test (not part of `npm test`): live updates (spec 4l). Changing a field applies
without clicking Apply; sliders apply on release; the scroll position and the focused field survive
the reload; the toggle turns it off (pending hint, Apply still works); Apply works with JS too.

Requires: python3, playwright (+ Chromium).  Run from the project root:
    python3 tests/browser/live.test.py
"""
import os, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright

PROJECT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT = 3497
URL = f"http://127.0.0.1:{PORT}/"
results = []

def check(name, ok, detail=""):
    results.append(ok)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" - {detail}" if detail else ""))

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
        page = browser.new_page(viewport={"width": 1200, "height": 800})

        nav_count = "() => performance.getEntriesByType('navigation').length"

        print("\n1. A select change applies in place: no navigation, URL updated, preview swapped after the new image loaded")
        page.goto(URL + "?image=photo"); page.wait_for_load_state("networkidle")
        check("action bar is pinned to the viewport bottom", page.evaluate("() => { const r = document.querySelector('.actions').getBoundingClientRect(); return Math.abs(r.bottom - innerHeight) < 2; }"))
        check("toggle on by default", page.is_checked("#live-toggle"))
        page.evaluate("() => { window.__loads = 0; window.addEventListener('beforeunload', () => { window.__loads++; }); }")
        page.select_option("[form=settings][name=preset]", "ig-square")
        page.wait_for_function("() => location.search.includes('preset=ig-square')"); page.wait_for_function("() => !document.querySelector('main').getAttribute('aria-busy')")
        check("URL updated via pushState (no reload: the window object survived)", page.evaluate("() => typeof window.__loads === 'number' && window.__loads === 0"))
        check("still the first navigation entry", page.evaluate(nav_count) == 1)
        check("preview is the preset size and fully loaded (no blank frame)", page.evaluate("() => { const i = document.querySelector('.preview img'); return i.complete && i.naturalWidth === 1080; }"))
        check("Export card re-rendered", "ig-square" in page.locator("section[aria-labelledby=h-exp] .context").inner_text())

        print("\n2. Checkbox, number field (on blur), slider (on release) - all in place")
        page.check("[form=settings][name=grayscale]")
        page.wait_for_function("() => location.search.includes('grayscale=1') && !document.querySelector('main').getAttribute('aria-busy')")
        check("checkbox applied", "Grayscale on" in page.locator("section[aria-labelledby=h-enh] .context").inner_text())
        page.fill("[form=settings][name=quality]", "55"); page.press("[form=settings][name=quality]", "Tab")
        page.wait_for_function("() => location.search.includes('quality=55') && !document.querySelector('main').getAttribute('aria-busy')")
        check("number field applied on blur", page.input_value("[form=settings][name=quality]") == "55" and "quality=55" in page.url)
        corners = page.locator("[form=settings][name=corners]"); corners.scroll_into_view_if_needed()
        corners.fill("30"); corners.dispatch_event("change")
        page.wait_for_function("() => location.search.includes('corners=30') && !document.querySelector('main').getAttribute('aria-busy')")
        check("slider applied on release", "Rounded corners 30" in page.locator("section[aria-labelledby=h-enh] .context").inner_text())
        check("still no reload", page.evaluate(nav_count) == 1 and page.evaluate("() => window.__loads") == 0)

        print("\n3. Scroll and focus do not move (nothing reloads); Enter applies in place too")
        page.focus("[form=settings][name=dp]"); page.fill("[form=settings][name=dp]", "200"); page.wait_for_timeout(100)
        before = page.evaluate("() => window.scrollY")
        page.press("[form=settings][name=dp]", "Enter")
        page.wait_for_function("() => location.search.includes('dp=200') && !document.querySelector('main').getAttribute('aria-busy')"); page.wait_for_timeout(100)
        check("scroll unchanged (exactly)", page.evaluate("() => window.scrollY") == before, f"{before} -> {page.evaluate('() => window.scrollY')}")
        check("focus kept on the edited field", page.evaluate("() => document.activeElement && document.activeElement.name") == "dp")
        check("Android card re-rendered with the new dp", "200 dp" in page.locator("section[aria-labelledby=h-and] .context").inner_text())
        check("Enter did not reload either", page.evaluate(nav_count) == 1)

        print("\n4. Back button restores the previous state in place")
        page.go_back(); page.wait_for_function("() => !location.search.includes('dp=200') && !document.querySelector('main').getAttribute('aria-busy')")
        check("popstate swapped the page back", "dp=200" not in page.url and "200 dp" not in page.locator("section[aria-labelledby=h-and] .context").inner_text())

        print("\n5. Toggle off: edits are pending, nothing applies until Apply (which is also in place)")
        page.uncheck("#live-toggle"); page.wait_for_timeout(50)
        url_before = page.url
        page.select_option("[form=settings][name=rotate]", "90"); page.wait_for_timeout(500)
        check("no update happened", page.url == url_before)
        check("pending hint shown, Apply highlighted", page.is_visible(".actions .pending") and "dirty" in page.get_attribute(".actions", "class"))
        page.click("button.primary")
        page.wait_for_function("() => location.search.includes('rotate=90') && !document.querySelector('main').getAttribute('aria-busy')")
        check("Apply applied in place", page.evaluate(nav_count) == 1 and not page.is_visible(".actions .pending"))
        check("preference remembered", not page.is_checked("#live-toggle"))
        page.check("#live-toggle")

        print("\n6. Collage cell pickers are live too; POST forms are not auto-submitted; busy indicator appears during a fetch")
        page.select_option("[form=settings][name=layout]", "split-h")
        page.wait_for_function("() => location.search.includes('layout=split-h') && !document.querySelector('main').getAttribute('aria-busy')")
        check("a template with rotate=90 still set -> the banner explains, in place", "rotate does not apply to a collage" in page.locator("main > .error").first.inner_text())
        page.select_option("[form=settings][name=rotate]", "0")
        page.wait_for_function("() => location.search.includes('rotate=0') && !document.querySelector('main').getAttribute('aria-busy')")
        ctx = page.locator("section[aria-labelledby=h-col] .context").inner_text()
        check("template applied live once rotate is back to 0; banner gone", "split-h" in ctx and page.locator("main > .error").count() == 0, ctx)
        url_before = page.url
        page.fill("form[action='/watermark'] input[name=text]", "LIVE"); page.wait_for_timeout(400)
        check("typing watermark text (a POST form) does not submit anything", page.url == url_before and page.input_value("form[action='/watermark'] input[name=text]") == "LIVE")
        check("busy text exists in the bar (hidden when idle)", page.locator(".actions .busy").count() == 1 and not page.is_visible(".actions .busy"))

        print("\n7. No flicker: sample every animation frame during six updates - the preview must never be missing or unloaded")
        page.goto(URL + "?image=photo"); page.wait_for_load_state("networkidle")
        page.evaluate("""() => { window.__frames = 0; window.__bad = 0; window.__stop = false;
          const tick = () => { window.__frames++; const i = document.querySelector('.preview img'); if (!i || !i.complete || i.naturalWidth === 0) window.__bad++; if (!window.__stop) requestAnimationFrame(tick); };
          requestAnimationFrame(tick); }""")
        for preset in ["ig-square", "ig-story", "yt-thumb", "x-header", "pin"]:
            page.select_option("[form=settings][name=preset]", preset)
            page.wait_for_function(f"() => location.search.includes('preset={preset}') && !document.querySelector('main').getAttribute('aria-busy')")
        page.check("[form=settings][name=grayscale]")
        page.wait_for_function("() => location.search.includes('grayscale=1') && !document.querySelector('main').getAttribute('aria-busy')")
        page.evaluate("() => { window.__stop = true; }")
        frames, bad = page.evaluate("() => window.__frames"), page.evaluate("() => window.__bad")
        check("zero frames without a fully loaded preview", frames > 50 and bad == 0, f"{bad} bad of {frames} frames")
        check("no reload during the whole session", page.evaluate(nav_count) == 1)

        print("\n8. Pending edits survive a swap: type in field B while field A is being applied")
        page.goto(URL + "?image=photo"); page.wait_for_load_state("networkidle")
        page.select_option("[form=settings][name=preset]", "yt-thumb")          # A: applies after the 250 ms debounce
        page.fill("[form=settings][name=quality]", "33")                          # B: typed meanwhile, not yet committed (no blur)
        page.wait_for_function("() => location.search.includes('preset=yt-thumb') && !document.querySelector('main').getAttribute('aria-busy')")
        check("A applied", "1280×720" in page.locator("section[aria-labelledby=h-exp] .context").inner_text())
        check("B's typed value survived the Export card swap", page.input_value("[form=settings][name=quality]") == "33")
        page.press("[form=settings][name=quality]", "Tab")
        page.wait_for_function("() => location.search.includes('quality=33') && !document.querySelector('main').getAttribute('aria-busy')")
        check("B applied on blur", "quality=33" in page.url)
        check("a submitted value takes the server's answer (no stale restore)", page.input_value("[form=settings][name=quality]") == "33" and page.evaluate("() => document.querySelector('[form=settings][name=quality]').defaultValue") == "33")

        browser.close()
finally:
    server.terminate()

print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
