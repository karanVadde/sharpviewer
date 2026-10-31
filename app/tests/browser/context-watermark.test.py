"""
Design review harness (optional, not part of `npm test`): render the In-context view for a matrix
of presets x scenes x watermark settings, save a contact sheet per scene to /tmp/ctx-gallery/, and
MEASURE for every combination how much of the watermark is actually visible in the rendered
thumbnail / post and how tall it is. The numbers answer "should the mark be there, and is it
visible?" without trusting anyone's eyes.

Requires: python3, pillow, playwright (+ Chromium). Run from the project root:
    python3 tests/browser/context-watermark.test.py
"""
import io, os, subprocess, sys, time, urllib.request
from PIL import Image, ImageDraw, ImageChops
from playwright.sync_api import sync_playwright

PROJECT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT = 3495
URL = f"http://127.0.0.1:{PORT}/"
OUT = "/tmp/ctx-gallery"
os.makedirs(OUT, exist_ok=True)

server = subprocess.Popen(["node", "src/server.ts"], cwd=PROJECT, env={**os.environ, "PORT": str(PORT)},
                          stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
for _ in range(150):
    try:
        urllib.request.urlopen(URL, timeout=1); break
    except Exception:
        time.sleep(0.2)

def fetch(path):
    try:
        return Image.open(io.BytesIO(urllib.request.urlopen(f"http://127.0.0.1:{PORT}{path}").read())).convert("RGB")
    except urllib.error.HTTPError as e:
        raise SystemExit(f"server rejected {path}: {e.code} {e.read().decode()[:200]}")

PRESETS = [("ig-square", "1:1"), ("ig-portrait", "4:5"), ("ig-story", "9:16"), ("yt-thumb", "16:9"), ("x-header", "3:1")]
MARKS = [("default", "wm=1"), ("20%", "wm=1&wmWidth=20%25"), ("40% tone auto", "wm=1&wmWidth=40%25&wmTone=100")]
SCENES = [("grid150", "150x150"), ("list64", "64x64"), ("feed470", "470x"), ("phone412", "412x")]

def mark_stats(base, thumb):
    """Visible fraction of the mark in the rendered thumb (pixels that differ from the unmarked render)."""
    marked = fetch(f"/image?image=photo&preset={base[0]}&{base[1]}&thumb={thumb}")
    plain = fetch(f"/image?image=photo&preset={base[0]}&thumb={thumb}")
    full_marked = fetch(f"/image?image=photo&preset={base[0]}&{base[1]}")
    full_plain = fetch(f"/image?image=photo&preset={base[0]}")
    def changed_box(a, b):
        diff = ImageChops.difference(a, b).convert("L").point(lambda v: 255 if v > 20 else 0)
        return diff.getbbox(), sum(1 for v in diff.getdata() if v)
    box_full, n_full = changed_box(full_marked, full_plain)
    box_thumb, n_thumb = changed_box(marked, plain)
    scale = (marked.width / full_marked.width) if thumb.endswith("x") else max(marked.width / full_marked.width, marked.height / full_marked.height)
    expected = n_full * scale * scale
    visible = min(1.0, n_thumb / expected) if expected else 0
    height = (box_thumb[3] - box_thumb[1]) if box_thumb else 0
    return marked, visible, height, box_thumb

rows = []
try:
    sheets = {}
    for scene, thumb in SCENES:
        cells = []
        for pid, aspect in PRESETS:
            for mlabel, mq in MARKS:
                img, visible, height, box = mark_stats((pid, mq), thumb)
                rows.append((scene, pid, aspect, mlabel, f"{visible * 100:5.0f}%", f"{height:3d} px"))
                cells.append((f"{pid} {mlabel}", img, box))
        # contact sheet
        cw = max(c[1].width for c in cells) + 12; ch = max(c[1].height for c in cells) + 28
        cols = len(MARKS); rws = (len(cells) + cols - 1) // cols
        sheet = Image.new("RGB", (cw * cols, ch * rws), "#f7f7f5"); d = ImageDraw.Draw(sheet)
        for i, (label, img, box) in enumerate(cells):
            x, y = (i % cols) * cw + 6, (i // cols) * ch + 22
            sheet.paste(img, (x, y)); d.text((x, y - 16), label, fill="#1c1917")
            if box: d.rectangle([x + box[0] - 1, y + box[1] - 1, x + box[2], y + box[3]], outline="#d00")
        sheet.save(f"{OUT}/{scene}.png"); sheets[scene] = sheet.size
finally:
    server.terminate()

# ---- Second pass: follow the page's own advice (fix chip + suggested width) and measure again.
import re, html as htmlmod
server = subprocess.Popen(["node", "src/server.ts"], cwd=PROJECT, env={**os.environ, "PORT": str(PORT)}, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
for _ in range(150):
    try:
        urllib.request.urlopen(URL, timeout=1); break
    except Exception:
        time.sleep(0.2)
advised = []
advised_cells = []
try:
    for scene, thumb in [("grid150", "150x150"), ("list64", "64x64")]:
        for pid, aspect in PRESETS:
            q = f"image=photo&preset={pid}&wm=1&view=context&scene={'grid' if scene == 'grid150' else 'list'}&row=64"
            page_html = urllib.request.urlopen(f"{URL}?{q}").read().decode()
            fix = re.search(r'<a class="chip fix" href="([^"]*)"', page_html)
            width = re.search(r'wmWidth=(\d+)%', page_html)
            extra = ""
            if fix:
                href = htmlmod.unescape(fix.group(1))
                tx = re.search(r"traverseX=(-?\d+)", href); ty = re.search(r"traverseY=(-?\d+)", href)
                extra += f"&traverseX={tx.group(1) if tx else 0}&traverseY={ty.group(1) if ty else 0}"
            mq = "wm=1" + extra + (f"&wmWidth={width.group(1)}%25" if width else "")
            img, visible, height, box = mark_stats((pid, mq), thumb)
            advised.append((scene, pid, aspect, "advised" + (" (no width works)" if not width else f" {width.group(1)}%"), f"{visible * 100:5.0f}%", f"{height:3d} px"))
            if scene == "grid150":
                advised_cells.append((f"{pid} advised", img, box))
    cw = 162; ch = 178
    sheet = Image.new("RGB", (cw * 5, ch), "#f7f7f5"); d = ImageDraw.Draw(sheet)
    for i, (label, img, box) in enumerate(advised_cells):
        x, y = i * cw + 6, 22
        sheet.paste(img, (x, y)); d.text((x, y - 16), label, fill="#1c1917")
        if box: d.rectangle([x + box[0] - 1, y + box[1] - 1, x + box[2], y + box[3]], outline="#d00")
    sheet.save(f"{OUT}/grid150-advised.png")
finally:
    server.terminate()

print(f"{'scene':9} {'preset':12} {'aspect':6} {'mark':15} {'visible':>8} {'height':>7}")
for r in rows:
    print(f"{r[0]:9} {r[1]:12} {r[2]:6} {r[3]:15} {r[4]:>8} {r[5]:>7}")
print("\ncontact sheets:", {k: v for k, v in sheets.items()})
bad = [r for r in rows if float(r[4].strip('%')) < 90 or int(r[5].split()[0]) < 8]
print(f"\ncombinations where the mark is cut off (<90% visible) or under 8 px tall: {len(bad)} of {len(rows)}")
print("\nAfter following the page's advice (fix chip + suggested width):")
for r in advised:
    print(f"{r[0]:9} {r[1]:12} {r[2]:6} {r[3]:22} {r[4]:>8} {r[5]:>7}")
ok = [r for r in advised if float(r[4].strip('%')) >= 90 and int(r[5].split()[0]) >= 8]
print(f"readable and uncut after the advice: {len(ok)} of {len(advised)} (the list-64 rows are expected to stay unreadable: no width works)")
sys.exit(0)
