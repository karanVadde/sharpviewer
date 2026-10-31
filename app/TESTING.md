# Sharp Viewer - Testing

How the project is tested, what each suite covers, and the test-by-test catalogue of the newer features (collage, watermark tone). The fast tier runs in `npm test`; the full tier and the browser suites are for CI and release checks.

## Running

| Goal | Command |
| --- | --- |
| Everything (what CI would run) | `npm test` |
| One file | `node --test tests/watermark.test.ts` |
| Tests whose name matches a pattern (regex, any file) | `node --test --test-name-pattern="opacity" "tests/**/*.test.ts"` |
| One suite by its `describe` name | `node --test --test-name-pattern="watermark: validation" tests/watermark.test.ts` |
| Readable tree output instead of TAP | add `--test-reporter=spec` |
| Re-run on file change | `node --test --watch "tests/**/*.test.ts"` |
| Type-check tests too | `npm run typecheck` (covers `tests/`) |
| Optional browser tests (need Python, pillow, playwright + Chromium) | `python3 tests/browser/outside-click.test.py`, `toast.test.py`, `devices.test.py`, `watermark-text.test.py`, `upload-ui.test.py`, `enhance.test.py`, `export.test.py`, `android.test.py`, `collage.test.py`, `live.test.py` |

| Note | Detail |
| --- | --- |
| Ports | Tests start the app on a random free port; no need to stop a running `npm run dev` |
| Paths | Project folders with spaces are fine: file paths are built with `fileURLToPath`, never `URL.pathname` |
| sharp cache | libvips caches file inputs by path; the watermark is read into a buffer before sharp sees it so regenerated files are never served stale |
| Node quirk | With a `--test-name-pattern` that matches nothing in a file, Node runs `before`/`after` hooks concurrently; the test servers are `unref()`ed so this cannot hang the run |

| Tier | Command | Scope |
| --- | --- | --- |
| fast | `npm test` | every suite; the preset x image export matrix is sampled (one render per preset) |
| full | `npm run test:full` | same with the whole 6 x 10 matrix (`SHARP_VIEWER_TEST_FULL=1`) |
| browser | `python3 tests/browser/<name>.test.py` | real Chromium via Playwright (needs python3, pillow, playwright); not part of `npm test` |
| pre-flight | `npm run preflight` | runs before `dev` / `start` / `typecheck` / `test`: dependencies installed, `sharp` version = the pin, native binary loads |

## Golden fixtures (`tests/fixtures/golden/`)

| Item | Detail |
| --- | --- |
| What | 31 page URLs (HTML, byte-exact with the CSP nonce normalised), 37 image/export URLs, 5 Android ZIPs, listed in `tests/golden.cases.ts` |
| Contract | Images are byte-identical on the platform that generated them (linux-x64, libvips 8.15.3) and **pixel-tolerant elsewhere** (max channel diff <= 2, < 0.5 % of pixels): libvips' SIMD paths are not bit-exact across CPU architectures (e.g. a 1080->279 Lanczos reduce differs by +-1 LSB on darwin-arm64). Fixtures that needed the tolerance are listed at the end of the run |
| Regenerate | `node tests/golden.update.ts` - only for an intended behaviour change; say why in the commit |

## Suites (`tests/*.test.ts`)

| Suite | What it checks | How |
| --- | --- | --- |
| default | 200, `image/png`, 960x640 | PNG IHDR bytes |
| sizes | 5 widths, 5 heights, both, max 4096, 5 invalid -> 400 | PNG IHDR bytes |
| rotation | 90/180/270 sizes, pixel checks for 90 and 180, order, 4 invalid -> 400 | IHDR + sharp raw decode |
| other routes | `/` HTML + Guide/Spec links, `/spec`, `/SPEC.md`, `/guide`, `/USER_GUIDE.md` (cross-links, HEAD), 404, 405, image has `user-select: none` | fetch |
| markdown | headings, tables (padded too), code, lists, rules, blockquotes, inline marks, escaping, every SPEC.md and USER_GUIDE.md table | unit |
| watermark placement | asset is path-only + tight canvas, default, 3 widths, 3 heights, exact box, margin 50 and 0, after rotate+resize, off states | pixel diff box vs unmarked image |
| watermark traverse | 0/0 identical, 7 moves incl. into the margin and exact corner, top-left corner reach, stacks with margin, after rotate+resize, 9 rejects (each edge by 1 px, combined, non-integer, out of range), ignored when off | pixel diff box shifted by (X, Y) |
| placeWatermark (unit) | anchor, sign convention, overshoot messages | direct call |
| watermark opacity | 0 = identical, 25 < 50 < 100 change strength | pixel diff |
| watermark validation | oversize (incl. exact-fit and +1 px), bad ints, margin, opacity, `wm` flag -> 400 | fetch |
| viewer page form | fields present, values forwarded + echoed, error banner + fallback, HTML escaping | fetch |
| size calculator | `outputSize` (11 cases) and `watermarkSize` (8 cases) equal sharp's real output; traverse range extremes 200 / +1 px 400 | render + compare |
| page: toast + keep | in-bounds no toast, 11 out-of-bounds cases (each edge, with/without previous position, one axis valid, size changed, garbage hidden field, rotated+resized, custom margin) -> exact toast text + image src + hidden fields, served image byte-identical to the kept position, typed values echoed, markup/script present, oversize -> banner | fetch |
| page: never broken | 14 page queries (valid, invalid, extreme, bad hidden fields): the emitted `<img src>` returns 200 `image/png` | fetch |
| preview: devices | 10 devices (5+5), unique slugs, wrap-around neighbours, landscape swap, state parsing + 3 rejects | unit |
| preview: banner | desktop default (no frame), mobile (image-only frame, form + header on the page, 10 chips), hidden preview fields + simulated Apply keeps device, Reset keeps view, toasts/errors outside the frame, tabs keep settings + device, invalid -> banner + loads | fetch |
| preview: cycling | Next x10 visits every device in order and wraps, Prev wraps back, per-device caption/iframe/frame size/active chip, chips keep settings, orientation toggle, FRAME_MAX scaling | fetch |
| generator | default run == committed stock byte for byte, custom text -> path-only SVG with integer canvas that sharp rasterises and the paint fills, width grows with text, `--stroke 0` single path, colours, XML escaping, end-to-end composite, 5 rejects (empty, missing glyphs, bad font, size, stroke) | spawn python3 (skipped if unavailable) |
| images (x6) | per image: native size, 5 resize/rotate sizes vs `outputSize`, default mark bottom-right (pixel diff), `wmWidth=20%` scales with the image, % of the rotated+resized output, traverse bounds and fit errors quote the image's size, page shows it selected with correct toast bounds, Mobile frame URL loads | fetch + sharp pixel diff |
| uploads | isolated dir, PNG upload -> stored/selected/rendered/listed, EXIF orientation baked in, WebP/GIF, newest-first listing, 4 rejections with banner + kept selection, oversize dims, oversize body, remove (+ unknown / traversal ids), id safety, 405 / wrong content type | fetch multipart |
| enhance | parsing + 6 rejects, `cornerRadius` linearity, `boxClippedByCorners`; per image (4): grayscale R=G=B with real contrast, sharpen raises edge contrast, corners 1/25/100 (transparent corners, opaque centre, alpha boundary on the diagonal at the computed radius, edges opaque), 0 byte-identical, after rotate+resize; circle on a square, all three + watermark, mark keeps colour on grey, page echo/forwarding/context, clip toast on/off, invalid -> 400 + banner + loads | fetch + sharp pixels |
| export | PNG/JPEG/WebP magic bytes + headers + filename, default PNG == preview, quality monotonic, metadata stripped, JPEG flatten vs PNG/WebP alpha, HEAD; 10 presets x 6 images exact sizes + filenames, cover vs contain pixels, attention crop keeps the subject, preset overrides width/height; maxKB fits at the highest quality, already-satisfied, unreachable -> q30 + warning, PNG + maxKB 400; 7 rejects; `exportFilename`; Export card echo, preview uses the preset, Download link loads, invalid -> banner + disabled, every preset page's URLs load | fetch + sharp |
| android | B1 cap: `too-large` verdicts, skipped buckets in ZIP + README + page, 400 when none fits; CRC-32 vectors, ZIP round-trip (store/deflate/unicode/empty) + corruption detected; buckets, dp->px, DPR->bucket for all profiles, plans + verdicts, names + suggestions, option parsing + 5 rejects; drawable ZIP (sizes, README, headers, % watermark), subset + nodpi + WebP + warnings, px-watermark note, enhance per bucket, 4 rejects; icon ZIP (19 files, every size, XML, Play icon), safe-zone pixels, custom name, preview endpoint, determinism; page tables/verdicts/link/echoes, Pixel 7 + Galaxy S9+ rows, invalid name, icon mode + guides, device-frame guides per cut-out, story bands, exports unaffected | fetch + sharp + zip reader |
| watermark-svg | TrueType tables, simple/composite/empty glyphs, non-TTF rejected, `pyFloat` cases, TS output == committed stock, canvas filled, accents taller, options, escaping/round-trip, validation; 12 texts + options byte-identical with Python (skipped without it) | unit + sharp + spawn |
| watermark-text (UI) | stock state + passthrough fields, Set writes/redirects/changes image and bounds, pipeline, replace, 4 invalid inputs (400 page, text kept, image kept, mark untouched), Restore, no-op restore, 405/oversized body, no form on embed page, 5 concurrent writes vs 20 reads all 200 | fetch (isolated custom path) |
| preview: image-only | `embed=image` has no banner/header/form/toast/script and no visible text besides the image, same padding rules, every device's iframe src loads with only the watermarked image, old `embed=1` rejected | fetch |

| Property | Value |
| --- | --- |
| Runner | Node built-in `node:test` + `fetch` |
| Server under test | `createApp()` on an ephemeral port, in-process |
| Extra dependencies | None (sharp used only to decode pixels for rotation checks) |
| Doc pages | `/spec` and `/guide` are read from disk on each request, so edits show on reload |

## Browser suites (`tests/browser/*.test.py`)

| Suite | Covers |
| --- | --- |
| `upload-ui` | Redesigned UI end to end: layout, stock pick with %, upload via file input, Mobile, remove, rejection, phone width |
| `watermark-text` | Type -> Set text -> image changes; invalid; Mobile view; Restore |
| `enhance` | Enhance card, slider live value, radius after Apply, clip toast, Mobile |
| `export` | Preset drives the preview, real download (name/type/size/pixels), contain + PNG, invalid combo |
| `android` | Card, tables, ZIP download opened with `zipfile`, icon mode + guides, device-frame guides |
| `devices` | Real device emulation gallery (20 shots), banner / cycling |
| `toast` | Form round-trip, toast visible, image unchanged and not broken, dismiss + auto-dismiss |
| `outside-click` | Regression: text selection outside the image must not tint it |
| `collage` | Template + cells + gutter, preview pixels, guides, download, Mobile frame, bad gutter, gallery, shaped pickers, per-cell fit, nudge, green tone, visible default mark |
| `context-watermark` | **Design-review harness** (not pass/fail): renders presets x scenes x watermark settings, saves contact sheets to `/tmp/ctx-gallery/`, measures the visible fraction and height of the mark per combination, then re-measures after following the page's own advice |
| `context` | In-context view: switch, 9 tiles with ours at the real pixel size and the scaled watermark inside it, legibility toast appears / disappears, size chips, list + dark theme (computed background), feed (3 posts, scrolled into view), feed on a phone at the device width, live updates keep the scene, back to Desktop |
| `live` | In-place updates: no navigation, URL via pushState, scroll/focus kept, Back, toggle off/pending, POST forms untouched, pending edits survive a swap, **0 blank frames** across six updates |

## Catalogue: collage and watermark-tone tests

`tests/collage.test.ts` and `tests/watermark-tone.test.ts` (run by `npm test`) unless marked browser (`tests/browser/collage.test.py`, optional Playwright). 34 + 7 automated tests, 48 browser checks (phase 2 rows added in v0.4.0, phase 3 + tone rows in v0.5.0, I-8 rows in v0.5.1).

| Test | What it checks (technical) | What it means (plain English) |
| --- | --- | --- |
| templates: 11 layouts, unique ids, cells inside, no overlap | Every template's fraction cells lie within 0..1 and no two cells intersect; ids unique; exact cell counts per template; `findLayout("nope")` is undefined | Every collage pattern is well-formed: nothing hangs off the edge and no two picture slots sit on top of each other |
| cellRects: grid-2x2 on 1080, gutter 22 | Exact pixel rects (`22,22,507,507` ...), gap between neighbours = 22, right margin = 22; gutter 0 gives four 540 px quarters | The maths that cuts the canvas into cells gives exactly the expected numbers, including even gaps |
| cellRects: every layout x 4 canvases x 3 gutters | Cells inside the margin, >= 1 px, pairwise non-overlapping; immediate horizontal/vertical neighbour gap equals the gutter +-1 px (phone templates excluded from the gap rule by design) | The same maths holds for all patterns on square, wide, tall and banner canvases, with small and large gaps |
| screens-*: phone aspect and gutter maths | `screens-3` cells have aspect 9:19.5 within 2%, middle cell centred; `gutterPx` = 2% of the shorter side, px passthrough, capped at a quarter of the shorter side | The "app-store screenshots" template really makes phone-shaped slots, and the gap can never swallow the canvas |
| collageCanvas precedence | preset > width+height > 1080x1080; one side alone throws the documented message | The collage is the preset's size, else the size you typed, else a square; half-typed sizes are refused with a clear message |
| parsing: defaults, list / repeated, rejects | `layout` alone -> 4 empty cells, gutter 2%, corners 0, cover; comma list keeps empty slots and drops extras; repeated `cells` params; `layout=none`; collage params ignored without a layout; 9 invalid inputs each produce their spec'd message | The settings are read exactly as documented, and every wrong value is refused with the message the manual promises |
| rendering: grid-2x2 pixels | Four solid-colour uploads; centre of each cell has its colour, empty cell / gutters / margins are `bg`, cell 1 spans exactly px 22..528, px 529 is gutter | Each picture lands in its own cell, empty cells and gaps show the background, and the cell edges are pixel-exact |
| rendering: every layout at a preset size | All 11 layouts x a preset each: output size = preset; the centre pixel of every cell is that cell's colour (via `cellRects`) | Every template renders at the right size with the right picture in every slot |
| rendering: contain / cellCorners / attention crop | `cellFit=contain` letter-boxes with `bg` and `cover` fills edge to edge; `cellCorners=100` makes cell corners `bg` but keeps the edge midpoint; the beach photo's red umbrella survives a story-shaped cell crop | "Fit inside" pads, "fill" crops, per-cell rounding works, and smart cropping keeps the subject |
| rendering: watermark / grayscale / corners / custom size | Mark changes pixels, grayscale gives R=G=B in cells, `corners=100` makes the collage corner transparent, `width=300&height=200` canvas honoured | Everything that worked on a single picture works on top of the collage |
| export + android with a layout | `/export` -> `collage-split-h-x-header-1500x500.jpg`, 1500x500; `/android.zip` drawables are square for a 1:1 canvas (360 / 720 px) | You can download a collage and ship it as Android assets in every density |
| render cache with cells | Swapped cell order = different bytes; same request twice = identical bytes | Caching cannot serve the wrong collage |
| unknown cell id | 400 `Cell 2: Unknown image "nope"` | A wrong picture name says which cell is wrong |
| page: card without a layout | Card present after Android, all template options, "Single image" context, 4 pickers with cell 1 = selected image, default gutter/corners | The Collage card shows up ready to use, pre-filled sensibly |
| page: card with a layout | Context line `hero-3 - 1280x720 - 3 cells (2 filled) - gutter 12 px - contain - cell corners 30`, one picker per cell echoing ids, `<img src>` carries only the collage params that matter, preview URL loads | What you chose is shown back to you and the preview uses exactly those settings |
| page: guides | `guides=1` draws 4 `<rect class="cell-guide">` + 4 labels and a legend; absent without the flag; the export bytes with and without `guides=1` are identical | Numbered outlines help you map pickers to cells, and never end up in the downloaded file |
| page: invalid values + Mobile | Unknown layout / bad gutter / half size -> banner + plain fallback image; Mobile frame src keeps `layout` and the dropdown stays selected | Mistakes are explained without breaking the page; the phone preview shows the collage too |
| page: repeated `cells` form fields (found by the browser test) | `cells=photo&cells=fhd&...` -> all kept: "3 filled", forwarded as `photo,fhd,portrait,`, pickers echo, passthrough hidden field joined, Mobile frame src joined | Choosing pictures in the dropdowns actually fills all the cells, not just the first |
| page: template survives an unrelated error | Bad gutter keeps `hero-3` selected, 3 pickers, typed gutter in the field | One typo does not reset the rest of your collage choices |
| page: POST passthrough | Watermark form carries `layout`, `cells`, `gutter` hidden fields | Changing the watermark text brings you back to the same collage |
| phase 2 · per-cell fit (parse) | One value for all cells, comma list or repeated `cellFit`, missing entries take the first, `stretch` rejected | Each slot can fill or fit its picture independently, and wrong values are refused |
| phase 2 · per-cell fit (render) | Same tall image left (contain) and right (cover) in one `split-h`: left shows bars, right fills edge to edge | Mixed fits really render differently side by side |
| phase 2 · per-cell fit (page) | Image URL carries one `cellFit` when all agree and the list when they differ; context says `mixed`; each cell's Fit select echoes | The page remembers and shows your per-cell choices |
| phase 2 · watermark margin (unit) | `collageWatermarkMargin(22,18)=2`, `(40,18)=11`, `(18,18)=0`, `(8,18)=16` | The maths that tucks the mark into the gap is exactly right |
| phase 2 · watermark margin (render) | With the default gutter the 200x18 mark's pixels are all inside the bottom band, none over the cells; explicit `wmMargin=100` puts it over a cell; single-image margin stays 16 | The watermark lands in the gap by default, over a picture only when you say so, and nothing changes for single pictures |
| phase 2 · watermark margin (page) | Toast names the covered cell and suggests a margin / gutter; no toast when in the band or when the covered cell is empty; Margin field blank with placeholder = effective value | You are told which picture the mark covers and how to fix it |
| phase 2 · gallery | None + 11 chips, each with an SVG sketch whose `<rect>` count equals the cell count; links keep preset/wm/gutter/cells; active chip marked | Clickable picture-buttons for every template, without losing other settings |
| phase 2 · shaped pickers | `.cell-grid` with the canvas aspect; each `.cell-box` at the template's fraction (`0/0/66.67/100` ...); Source + Fit select per cell in cell order; default shape 2x2 without a layout | The dropdowns are arranged like the collage itself |
| phase 2 · hints | `grid-3x3` on 300x300 → "cells are small (shortest side N px)"; `screens-3` on `pin` → "phone cells are narrow on this tall canvas"; none on `fb-post` | The page warns when a template and a canvas do not suit each other |
| phase 2 · empty guides | `guides=1` labels each empty cell "empty" | You can see at a glance which slots are still unfilled |
| phase 3 · nudge (parse) | `cellX`/`cellY` lists / repeated, missing = 0, -4096..4096 enforced, ignored without a layout | Each slot's crop can be nudged by a number of pixels, with bad values refused |
| phase 3 · nudge (maths) | `nudgeRange` for the panorama in a 507 px cell = X -1394..127, Y 0..0; `clampNudge` | The allowed movement is exactly "until the picture's edge" |
| phase 3 · nudge (render) | Zero nudge is byte-identical to the default; a half-red/half-blue image nudged far left shows red, far right shows blue; clamped at the edges (no background leaks); `contain` ignores it | Nudging really moves the crop, never past the picture, and leaves fit-inside cells alone |
| phase 3 · nudge (page) | Fields per cell echo; out-of-range → toast `Cell 1 nudge X -4000 is out of range for this cell: allowed -992 to 0. Using -992.` and the image URL carries the clamped value; all-zero lists dropped; no-layout pages drop the form's default cell fields (bug found by the browser test) | The page tells you when it had to hold a nudge back, and never pollutes the picture address with unused fields |
| tone · scale (unit) | Lightness 88 % → 18 % linear at hue 152 / sat 60 %; G dominant at every tone; outline dark ≤ 50, light > 50; `recolourMark` rewrites exactly the generator's fill/stroke; `wmTone` 0-100 parsed, 101 rejected | The green scale is truly linear and always green, and the outline swaps so the mark stays readable |
| tone · render | Tone 0 mark is light green, tone 100 dark green, original is neutral cream; brightness decreases with the tone; custom `wmText` marks recolour too; size unchanged; cache keys on the tone | Light green for dark pictures, dark green for light pictures - and it works on your own text |
| tone · page | Slider alone (checkbox off) is not forwarded; checkbox on → `wmTone` in the image and Download URLs, echoed slider, context `Green tone N`, gradient preview; 101 → banner | The switch and slider behave exactly as shown |
| I-8 · auto-contrast (unit) | `autoTone("#ffffff") = 100`, `("#000000") = 0`; `contrastRatio` symmetric, 21:1 black/white; dark green on white > 7:1; the cream fill on white < 1.2:1 (the bug, quantified) | The colour choice is made by measured contrast, not by guesswork |
| I-8 · default collage visible | On the default white collage with `wm=1`, > 300 mark pixels differ strongly from white and their average colour is dark green; explicit `wmTone=0` still wins; the single-image default render is byte-identical to its golden | The first collage a new user makes has a watermark they can actually see; nothing changed for single pictures |
| I-8 · page | Status `Green tone 100 (automatic: dark green on the light background)` / `0 (... dark background)`; no auto tone when the mark is over a picture; manual tone 0 on white → toast `low contrast (1.x:1): try Green tone 100`; tone 100 → no toast | The page explains the automatic choice and warns about a poor manual one |
| browser (48 checks) | Real Chromium: sections 1-9 plus 10 (I-8: dark green mark pixels in the band of a default white collage, status text, no toast, low-contrast toast for tone 0). Sections 1-7 as before plus 8 (nudge: field echo + forward, top cell changes while the bottom cell is unchanged, out-of-range toast + clamped field) and 9 (tone: controls present, unchecked = not forwarded, live slider value, checked = forwarded + context, tone 10 brighter than tone 95 in the mark area, Download carries the tone). Sections 1-7: click a gallery chip (template + preset kept), cell boxes at 0/67/67 with 16:9 aspect, per-cell Contain → `mixed` + list in the URL + white bars in the cell, overlap toast names cell 3, Margin blank by default, 40 px gutter → no toast and placeholder 11 | A scripted person clicks through the whole feature in a real browser and everything behaves as a user would expect | pick template + cells + gutter + bg, Apply; URL has one `cells=` per picker; preview 1080x1080 with `bg` in empty cell and gutter; guides 4 rects + labels "1234"; Download `collage-grid-2x2-ig-square-1080x1080.jpg` 1080x1080 JPEG; Mobile frame shows the collage; bad gutter -> banner, fallback image, typed value kept, template kept; None -> `layout=none`, image src without collage | A scripted person clicks through the whole feature in a real browser and everything behaves as a user would expect |

## Catalogue: in-context view and `thumb` (v0.7.0)

All in `tests/context.test.ts` (13 tests) and `tests/browser/context.test.py` (20 checks).

| Test | What it checks (technical) | What it means (plain English) |
| --- | --- | --- |
| thumb grammar + maths | `N` / `WxH` / `Wx` / `xH` parse; 16-1024 enforced; `thumbSize` keeps the aspect, never upscales, `cover` exact | The "show it small" instruction is read exactly, and never blows a picture up |
| thumb render | Output sizes for all four forms; no `thumb` = byte-identical to before; the scaled mark is in the tile's corner **and nothing else differs**; corners and grayscale survive; `-thumb150x150` in the export filename; collages work | Small previews are the real finished picture shrunk - watermark, corners, grey and all |
| mode switch + validation | Three tabs; `In context` keeps the settings; bad `scene` / `tile` / `row` / `theme` -> banner + Desktop | The new view is one click away and bad addresses are refused politely |
| grid scene | 9 tiles at the chosen size, ours in the centre with the full settings + `thumb=WxH`, 8 neighbours = stock images through the preset only (never the selected image), every tile URL renders at the right size | Your post sits among sample posts of the same shape, each really rendered at tile size |
| list scene + chips | 5 rows, ours in the middle, square thumbnails at the row size; Grid / List / Feed, size and theme chips are links that keep the settings; the form carries `view` / `scene` / `row` so Apply keeps the scene | Switching scenes and sizes never loses your work |
| dark theme + guides | `dark` class; `guides=1` outlines ours and labels `150x150 px` | You can see exactly how big your item is in the scene |
| legibility toast | Mark height at the scene scale < 8 px -> `In the grid (150 px tiles) the watermark is 3 px tall - unreadable...`; list variant; none when legible, outside the view, or without a watermark | The page tells you when your watermark would be pointless at that size |
| collage in context | Ours = the collage at thumb size; all six stock images serve as neighbours | Collages get the same treatment |
| feed (desktop) | 3 posts, ours in the middle with `thumb=470x` and explicit dimensions; neighbours via the preset render 470 px wide; Where chips | Your post in a feed between two sample posts of the same shape |
| feed (phone) | `frame=1`: iframe of the scene-only page with device + orientation; device chips; form carries `frame` / `device`; the scene-only page has no chrome / form / script and renders our post at the **device width** (412 on a Pixel 7) | The feed inside a phone frame, with pixels rendered at that phone's real width |
| browser (20) | Real Chromium: tile is 150 CSS px *and* a 150 px render; scaled mark present by pixel diff; toast appears and disappears with a 60 % mark on 240 px tiles; list 48 px; dark background is `rgb(17,17,17)`; feed 470 px and scrolled into view; phone frame at 412 px; live update keeps the scene; Desktop tab returns | A scripted person uses the whole view in a browser and everything matches the promises above |

## Catalogue: watermark placement review (v0.7.1)

`tests/context.test.ts` (+7) and `tests/browser/context.test.py` (+3), `tests/image.test.ts` (+1).

| Test | What it checks (technical) | What it means (plain English) |
| --- | --- | --- |
| safeSquare / markVisibleFraction | The centre square of 4:5, 16:9, 1:1 outputs; a bottom-right mark on a 16:9 is 0 % inside it, a centred one 100 %, a straddling one 50 % | The maths knows exactly what a thumbnail crop keeps |
| thumbnailSafeTraverse | `{0,-135}` for 4:5, `{0,-420}` for 9:16, `{-280,0}` for 16:9, `{-500,0}` for 3:1, `{0,0}` for a square; no `-0` | One number moves the mark to where every crop keeps it |
| requiredWidthPercent / maxSafeWidthPercent | 59 % for 150 px tiles on 1080; null for 64 px rows; 53 % is the widest mark a 720 px square holds | Honest numbers instead of "make it bigger" |
| crop toast + fix chip | 4:5 in the grid → "cuts off 100 % ... bottom band ... traverseY -135", chip link carries the values; after it no crop toast; 16:9 in the list → 52 % cut, `traverseX -280`; square → no toast; feed → no toast | The page tells you your mark will vanish in thumbnails, and fixes it in one click |
| consistent advice | A 78 % mark on 16:9 cannot fit the 720 px square: no contradictory "move it" + "widen it"; the toast says what *can* work | The advice never asks for two things that cannot both be true |
| numeric legibility | "needs about 59 % (wmWidth=59%)" for 150 px tiles; "no width under 100 %" for 64 px rows; phone feed computed at 412 px; tone tip only without a tone | You get a number, or an honest "this size cannot carry text" |
| golden rule | Desktop and Mobile pages carry none of the review toasts/chips; their goldens differ only in the shared stylesheet | Nothing outside the In-context tab changed |
| B11 | `GET //?x`, `//`, `///spec`, `//evil.example/` → 400 and the server stays up | A malformed address can no longer crash the tool (it used to) |
| browser (+3) | Real Chromium: 4:5 post shows the crop toast; clicking the fix chip adds `traverseY=-135`, removes the toast, and the tile now contains the mark by pixel diff (it did not before) | The one-click fix really puts the watermark back in the thumbnail |
| harness (measured) | Before: 37 of 60 combinations cut or unreadable, 24 of 30 grid/list combinations 0 % visible. After following the page's advice: every grid-150 combination 97-100 % visible and >= 8 px; list-64 honestly "no width works" | The numbers say the review fixed what it set out to fix |
