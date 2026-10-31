# Sharp Viewer - Spec (v0.7.1)

One page to prepare an image for a feed or an app. Node built-in `http` + native TypeScript + `sharp`; no framework, no build step. This file is served at `/spec`; the non-technical guide at `/guide`. History and decisions: `CODE_REFACTOR.md`. Tests: `TESTING.md`.

## 1. At a glance

| Topic | Summary |
| --- | --- |
| What | Pick the built-in sample, a stock image or an upload (or build a **collage** from 11 templates); resize/rotate or a platform preset (Instagram, Facebook, X, LinkedIn, YouTube, Pinterest); sharpen, grayscale, rounded corners; a bottom-right text watermark (px or % sized, optional green tone); preview on desktop or in an emulated phone frame with safe-area guides; download PNG/JPEG/WebP with quality and a file-size target; Android density sets and launcher icons as a ZIP. Settings live in the URL and apply as you change them |
| Stack | Node >= 22.21, TypeScript 5.9 (type-check only), `sharp` 0.33.5 (pinned), Biome (lint/format) |
| Run | `npm ci` then `npm run dev` then open `http://127.0.0.1:3000` |
| Who | Node/TS devs evaluating `sharp`; Android devs (density sets, icons, upscale verdicts); a small, tested starting point for an image service. **Not** a hosted product: single-user, loopback, shared uploads and watermark |
| Principles | State in the URL (every control is a GET form field or a plain link); the server renders the whole page; JavaScript is progressive enhancement only (toasts, slider values, in-place live updates); byte-level golden fixtures guard behaviour |

## 2. HTTP API

| Method | Path | Response | Content-Type | Status |
| --- | --- | --- | --- | --- |
| GET, HEAD | `/` or `/index.html` | viewer page (`public/index.html` template) | `text/html` | 200 |
| GET, HEAD | `/` + optional query | viewer page; query is forwarded to the `<img>` and echoed into the form | `text/html` | 200 |
| GET, HEAD | `/image` + optional query | selected image (`image=` id), transformed, PNG | `image/png` | 200 |
| GET, HEAD | `/image` + invalid query | error message | `text/plain` | 400 |
| GET, HEAD | `/export` + query | the composed image encoded for download (`Content-Disposition: attachment`) | `image/png`, `image/jpeg`, `image/webp` | 200 |
| GET, HEAD | `/android.zip` + query | Android asset set (drawables or launcher icon) as a ZIP attachment | `application/zip` | 200 |
| GET, HEAD | `/android/icon-preview` + query | The adaptive icon as a launcher shows it, 432 px PNG | `image/png` | 200 |
| GET, HEAD | `/spec` | `SPEC.md` rendered as HTML (this page) | `text/html` | 200 |
| GET, HEAD | `/SPEC.md` | `SPEC.md` raw | `text/markdown` | 200 |
| GET, HEAD | `/guide` | `USER_GUIDE.md` rendered as HTML (spec and guide link to each other) | `text/html` | 200 |
| GET, HEAD | `/USER_GUIDE.md` | `USER_GUIDE.md` raw | `text/markdown` | 200 |
| GET, HEAD | anything else | `Not found` | `text/plain` | 404 |
| `POST` | `/watermark` | Set a custom text watermark (`text`, `action=set`) or restore the stock one (`action=restore`); redirects back to the page | - | 303 (400 + page on invalid text) |
| `POST` | `/upload` | multipart: add an image (`file`) and select it; urlencoded/multipart `action=remove&id=`: delete an upload. Redirects back to the page | - | 303 (400 + page on rejection) |
| other | any | `Method not allowed`, `Allow: GET, HEAD` (`Allow: POST` for `/watermark`, `/upload`) | - | 405 |
| GET, HEAD | `/image`, `/export`, `/android.zip`, `/android/icon-preview` when the render queue is full or a render exceeds the timeout | `...busy...` / `...timed out...`, `Retry-After: 1`; the page itself is never gated | `text/plain` | 503 |
| GET, HEAD | any of the above on I/O or sharp failure | `Unable to load the page or image.` | `text/plain` | 500 |

| Rule | Detail |
| --- | --- |
| Unparsable request path (e.g. `//?x`) | 400 `Bad request` (it used to crash the process: B11) |
| Headers on 200 | `Content-Length`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`; HTML adds a `Content-Security-Policy` (scripts only with the response's nonce, styles inline, everything else same-origin, `frame-ancestors 'self'`) |
| HEAD | Same headers as GET, empty body (the render happens) |
| Unknown query params | Ignored |
| Invalid query on `/` | The page still renders and its `<img>` always loads (3.3) |

## 3. The image pipeline (`/image`)

### 3.1 Parameters

| Param | Accepts | Default | Effect |
| --- | --- | --- | --- |
| `image` | `sample`, `thumb`, `photo`, `fhd`, `portrait`, `panorama`, or an upload id `u-<16 hex>` | `sample` | Which image to render |
| `width` | integer 1-4096 | none | Resize to width, height auto (aspect kept) |
| `height` | integer 1-4096 | none | Resize to height, width auto (aspect kept) |
| `width` + `height` | both | none | Exact size, stretched (`fit: "fill"`) |
| `rotate` | 0, 90, 180, 270 | 0 | Clockwise rotation, applied BEFORE resize |
| `preset` | `ig-square`, `ig-portrait`, `ig-story`, `ig-landscape`, `fb-post`, `x-post`, `x-header`, `li-post`, `yt-thumb`, `pin` (or `none`) | none | Fixed platform output size (4i); overrides `width`/`height` |
| `fit` | `cover`, `contain` | `cover` | With a preset: crop to fill (sharp's attention strategy keeps the subject) or pad with `bg` |
| `bg` | `#rrggbb` | `#ffffff` | Padding colour for `contain`; flatten colour for JPEG exports with transparent corners |
| `sharpen` | 1, true, on (off: 0, false, off, omitted) | off | sharp's standard mild unsharp mask (`.sharpen()` defaults), applied to the resized output |
| `grayscale` | 1, true, on (off: 0, false, off, omitted) | off | Luminance-weighted conversion to grey (`.grayscale()`), applied before the watermark so the mark keeps its colour |
| `corners` | integer 0-100 | 0 | Rounded corners, linear: radius = `round(corners / 100 * min(width, height) / 2)` px. 100 = pill (circle for a square). Corners become transparent |
| `wm` | 1, true, on (off: 0, false, off, omitted) | off | Switch the watermark on |
| `wmWidth` | integer 1-4096 (px) or `1%`-`100%` of the output width | 200 if no height (clamped so mark + margin fits) | Watermark width, height auto. `20%` of the output width. Explicit sizes are never clamped (400 if they do not fit) |
| `wmHeight` | integer 1-4096 (px) or `1%`-`100%` of the output height | auto | Watermark height, width auto (aspect kept) |
| `wmWidth` + `wmHeight` | both | - | Exact watermark box, stretched |
| `wmText` | 1-80 characters the bundled font can show (no control characters) | active mark | Per-request mark text instead of the active stock/custom file (nothing is written). Same generator as **Set text** |
| `wmMargin` | integer 0-4096 | 16 (collage: automatic, see 4.7) | Inset from the bottom and right edges, px |
| `wmTone` | integer 0-100 | none (collage: automatic, see 4.7) | Recolour the mark on a linear light-to-dark green scale (hue 152, sat 60 %, lightness 88 % -> 18 %); the outline flips to light above 50. Omitted = the mark's own cream fill |
| `wmOpacity` | integer 0-100 | 70 | Watermark opacity, percent (0 = invisible) |
| `traverseX` | integer -4096..4096 | 0 | Shift the watermark horizontally from its bottom-right spot, px. +X right, -X left |
| `traverseY` | integer -4096..4096 | 0 | Shift the watermark vertically from its bottom-right spot, px. +Y down, -Y up |
| `thumb` | `N` (longest side), `WxH` (centre cover-crop to exactly WxH), `Wx` (width), `xH` (height); integers 16-1024 | none | **Display scale, applied last**: the finished composition (crop, corners, watermark, tone) is scaled down the way a platform renders a thumbnail, so small previews are honest about legibility. Used by the In-context view (4.9); exports honour it (`-thumb150` in the filename) |

### 3.2 Order of operations

| Pipeline step | Order | Note |
| --- | --- | --- |
| 1. rotate | first | - |
| 2. preset fit or resize | second | Preset: `cover`/`contain` to the preset size; otherwise both target dimensions come from `outputSize()` so the size is exact for every format |
| 3. sharpen, grayscale | third | In that order; on the resized output |
| 4. watermark | fourth | Sized against the FINAL output, always bottom-right of what you see |
| 5. rounded corners | last (preview) | Masks the whole composition, watermark included (toast when a corner clips the mark) |
| 6. encode (export only) | after 5 | JPEG: flatten onto `bg`; JPEG/WebP at `quality`, optional `maxKB` search; PNG lossless. Metadata stripped |
| 7. display scale (`thumb`) | after 5 | Third stage on the composed pixels: `fit: inside` for `N` / `Wx` / `xH`, centre `cover` for `WxH`. Never upscales |
| Two stages | - | libvips runs `composite` last and `greyscale` before resize, so stage 1 (rotate, resize, sharpen, grayscale) is rendered to raw pixels and stage 2 composites the watermark and the corner mask (`dest-in`) |
| Fit check | before 1 | `wmWidth + wmMargin <= width` and `wmHeight + wmMargin <= height`, else 400 - checked before sharp starts, with the same helpers the page uses |
| Position | after 4 | `left = width - wmWidth - wmMargin + traverseX`, `top = height - wmHeight - wmMargin + traverseY` |
| Bounds check | before 1 | Any part of the mark outside the image -> 400 (message names the overshoot per edge) |

### 3.3 How the page (`/`) handles bad input

| Input problem | Page | Image shown |
| --- | --- | --- |
| `traverseX` / `traverseY` out of bounds | Toast (one per axis): `traverseX -800 is out of bounds for this size: allowed -744 to 16. Keeping -100.` The form carries hidden `appliedTraverseX/Y` = the values actually used, so the mark stays where it was | Full transform with the kept position |
| Render impossible (mark + margin too large, bad numbers, unknown image, bad preview options) | Red banner under the header | Plain sample image |
| Export-only value invalid (`format`, `quality`, `maxKB`) | Error inside the Export card, Download disabled | As requested |
| Android value invalid (name, bucket, no bucket fits the 4096 px cap) | Error inside the Android card, ZIP disabled | As requested |
| Rejected upload / invalid watermark text | Red banner, page re-rendered (400) with the selection and settings kept | Unchanged |
| Rounded corners clip the watermark / watermark covers a collage cell / low contrast on the background | Toast with a concrete suggestion | As requested |

## 4. Features

Code comments cite the former section letters: 4b watermark = 4.2, 4c bad input = 3.3, 4d preview = 4.6, 4e custom text = 4.2, 4f sources = 4.1, 4g page = 4.8, 4h enhance = 4.3, 4i export = 4.4, 4j android = 4.5, 4k collage = 4.7, 4l live updates = 4.8, 4m in context = 4.9.

### 4.1 Image sources

| Id | File | Size | Format |
| --- | --- | --- | --- |
| `sample` | `public/sample.png` | 960x640 | PNG |
| `thumb` | `public/stock/thumb.png` | 320x240 | PNG |
| `photo` | `public/stock/photo.jpg` | 1600x1200 | JPEG |
| `fhd` | `public/stock/fhd.jpg` | 1920x1080 | JPEG |
| `portrait` | `public/stock/portrait.webp` | 1080x1920 | WebP |
| `panorama` | `public/stock/panorama.png` | 4000x1000 | PNG |

| Uploads | Detail |
| --- | --- |
| How | Image card: choose a file, **Upload** (multipart, parsed with `Response.formData()`); redirects back with the upload selected |
| Accepted | PNG, JPEG, WebP, GIF (first frame), TIFF, AVIF; <= 25 MB, <= 8192 px per side, <= 50 MP; decoded by sharp to prove it is an image |
| Orientation | EXIF orientation is baked in once at upload (JPEG q95 4:4:4 / WebP q95 / others lossless), so every render is upright without EXIF logic elsewhere |
| Storage | `uploads/` (git-ignored): `u-<16 hex>.<ext>` + `.json` sidecar (name, time), written atomically; in-memory index keyed on the directory mtime; quota `SHARP_VIEWER_UPLOAD_QUOTA_MB` (oldest evicted); ids validated before any disk access |
| Remove | **Remove this upload** deletes both files; the page falls back to the sample |

### 4.2 Watermark

| Item | Detail |
| --- | --- |
| Asset | `public/watermark.svg`: "SHARP VIEWER" as glyph outline paths (no fonts needed), 398x36 canvas cropped to the glyphs, cream fill `#f6f5f1` with a 2 px dark outline |
| Custom text | **Set text** (`POST /watermark`) generates an SVG with the bundled DejaVu Sans Bold (`src/ttf.ts` + `src/watermark-svg.ts`, byte-identical to `tools/make-watermark.py`) into `public/watermark.custom.svg`; it is the active mark until **Restore stock**. 1-80 characters the font can show. Writes are serialised (unique temp file + rename); a truncated file falls back to the stock mark with a warning |
| Per request | `wmText=` overrides the active file for one render; `wmTone=` recolours the fill (section 3.1) |
| Sizing | px or % of the output; default 200 px clamped to fit; position = bottom-right minus margin plus traverse; the mark is rendered after grayscale so it keeps its colour and before the corner mask |
| CLI | `npm run watermark -- --text "..."` (Python, needs fonttools) or `npm run watermark:node -- --text "..."`; options `--size 44 --letter-spacing 2 --stroke 2 --fill --stroke-color --font --out` |

### 4.3 Enhance

| Function | Rule |
| --- | --- |
| Sharpen | `sharp.sharpen()` defaults (mild unsharp mask) on the resized output |
| Grayscale | `sharp.grayscale()` (luminance), before the watermark |
| Rounded corners | `corners` 0-100 -> radius `round(corners / 100 * min(W, H) / 2)` px, SVG mask with `dest-in`; 100 = pill / circle; corners transparent in PNG/WebP, `bg` in JPEG |

### 4.4 Export

| Item | Detail |
| --- | --- |
| Endpoint | `/export` = the `/image` pipeline + encoding, served as an attachment. Export-only params `format` (`png` default, `jpeg`, `webp`), `quality` 1-100 (default 82), `maxKB` 1-50000 (JPEG/WebP only) |
| Presets | Drive the preview too. `fit=cover` crops with sharp's attention strategy; `fit=contain` pads with `bg` |
| File-size target | Encode at `quality`; if over `maxKB`, binary-search the highest quality in [min(30, quality), quality - 1] that fits; header `X-Export-Quality`. Unreachable: the lowest attempt is delivered with `X-Export-Warning` (never a bigger file than asked for) |
| Filename | `<image or collage-<layout>>-<preset or WxH>[-grey][-wm].<ext>`, e.g. `photo-ig-square-1080x1080-wm.jpg` |
| Metadata | Stripped; sRGB |

| Preset id | Platform | Size | Aspect |
| --- | --- | --- | --- |
| `ig-square` | Instagram post | 1080x1080 | 1:1 |
| `ig-portrait` | Instagram post | 1080x1350 | 4:5 |
| `ig-story` | Instagram story / Reel cover | 1080x1920 | 9:16 |
| `ig-landscape` | Instagram post | 1080x566 | 1.91:1 |
| `fb-post` | Facebook link / post | 1200x630 | 1.91:1 |
| `x-post` | X post | 1600x900 | 16:9 |
| `x-header` | X header | 1500x500 | 3:1 |
| `li-post` | LinkedIn post | 1200x627 | 1.91:1 |
| `yt-thumb` | YouTube thumbnail | 1280x720 | 16:9 |
| `pin` | Pinterest pin | 1000x1500 | 2:3 |

### 4.5 Android

| Item | Detail |
| --- | --- |
| Buckets | `mdpi` 1x, `hdpi` 1.5x, `xhdpi` 2x, `xxhdpi` 3x, `xxxhdpi` 4x (+ optional `nodpi` at the mdpi size); px = `round(dp x scale)`. A bucket whose side would exceed 4096 px is **skipped** (table verdict `too large (skipped)`, README warning); 400 only when no bucket fits |
| Drawable | `res/drawable-<bucket>/<name>.png|webp` through the full pipeline at each bucket's size; width dp with the height from the source aspect, or width + height dp with the Export fit |
| Icon | `res/mipmap-<bucket>/<name>.png` (48 dp, rounded), `<name>_foreground.png` (108 dp, image in the 66 dp safe zone), `<name>_background.png` (solid `bg`), `mipmap-anydpi-v26/<name>.xml` + `_round.xml`, `playstore/<name>-512.png`, README |
| Tables | Per bucket: px and `OK` / `upscaled xN` / `too large (skipped)`; per device profile: the bucket Android serves for its DPR and the verdict |
| Params | `androidMode` drawable/icon, `androidName` (`[a-z][a-z0-9_]*`, suggested from the image name), `dp` 1-4096, `dpHeight`, `buckets`, `nodpi`, `androidFormat` png/webp |
| Guides (`guides=1`) | Mobile view: status bar 24 dp, navigation bar 48 dp, the device's cut-out. Icon mode: 72 dp visible circle + 66 dp safe circle. `ig-story`: keep-clear bands 250 px. Collage: numbered cell outlines, empty cells labelled. Overlays only, never in any output |

### 4.6 Preview: Desktop / Mobile

| Item | Detail |
| --- | --- |
| Switch | Header segmented control; both keep every setting |
| Mobile | The page shows a phone/tablet frame containing only the image (`embed=image` page in an `<iframe>` at the device's CSS viewport, scaled to fit 1040x720) with Prev / Next / device chips / Rotate links below. Page params `view`, `device`, `orientation`, `embed`, `guides` |
| Fidelity | CSS viewport only (desktop DPR and UA); `tests/browser/devices.test.py` renders under full Playwright descriptors |

| Device (slug) | Platform | Viewport (portrait) | DPR |
| --- | --- | --- | --- |
| iPhone SE (`iphone-se`) | iOS | 320x568 | 2 |
| iPhone 13 (`iphone-13`) | iOS | 390x664 | 3 |
| iPhone 14 Pro Max (`iphone-14-pro-max`) | iOS | 430x740 | 3 |
| iPad Mini (`ipad-mini`) | iOS | 768x1024 | 2 |
| iPad Pro 11 (`ipad-pro-11`) | iOS | 834x1194 | 2 |
| Galaxy S9+ (`galaxy-s9-plus`) | Android | 320x658 | 4.5 |
| Galaxy S24 (`galaxy-s24`) | Android | 360x780 | 3 |
| Pixel 5 (`pixel-5`) | Android | 393x727 | 2.75 |
| Pixel 7 (`pixel-7`) | Android | 412x839 | 2.625 |
| Galaxy Tab S4 (`galaxy-tab-s4`) | Android | 712x1138 | 2.25 |

### 4.7 Collage

| Item | Detail |
| --- | --- |
| What | N images on one canvas by a named template, then the normal pipeline. Canvas = preset, else `width` x `height` (both), else 1080x1080; `rotate` does not apply (400) |
| Templates | Cells are fractions of the canvas, so one template fits every canvas shape. `screens-*` cells are fitted to a 9:19.5 phone aspect |
| Cells | `cells` = comma list / repeated param of image ids in template order; empty = `bg`. Each cell is rendered at its own size: `cellFit` cover (attention crop) or contain (pad), one value or per cell; `cellCorners` per cell; `cellX`/`cellY` nudge a cover cell's crop window from the attention position, clamped inside the picture (toast on the page) |
| Gutter | `gutter` px (0-512) or `%` of the shorter side (0-20, default 2 %): gap between cells and to the edge |
| Watermark | Without `wmMargin` the mark is centred in the bottom-right margin band when it fits the gutter (`floor((gutter - markH) / 2)`), else margin 16; when it sits on the background without a `wmTone`, the tone is chosen for contrast (dark green on light `bg`, light on dark) and the status line says "automatic" |
| Card | Template select + gallery (SVG sketch per template, plain links), cell pickers laid out in the template's shape (Source, Fit, nudge X/Y per cell), Gutter, Cell corners; hints for small cells / narrow phone cells |
| Exports | `/export` and `/android.zip` accept the same parameters; drawables render the collage at each bucket's size |

| Template (id) | Cells | Layout (fractions of the canvas) | Typical use |
| --- | --- | --- | --- |
| `grid-2x2` | 4 | 2 columns x 2 rows | The classic |
| `grid-3x3` | 9 | 3 x 3 | Photo-dump tile |
| `split-h` | 2 | Left / right halves | Before / after |
| `split-v` | 2 | Top / bottom halves | Stories |
| `hero-3` | 3 | One big cell on the left (2/3 width), two stacked on the right | Product shots, screenshots |
| `hero-4` | 4 | One big cell on top (2/3 height), three small below | Thumbnails, headers |
| `strip-3` | 3 | Three equal columns | X header, banners |
| `strip-4` | 4 | Four equal columns | Banners |
| `story-3` | 3 | Three equal rows | IG story |
| `screens-2` | 2 | Two phone-aspect (9:19.5) cells centred side by side | App-store style screenshots |
| `screens-3` | 3 | Three phone-aspect cells centred side by side | App-store style screenshots |

| Param | Accepts | Default | Effect |
| --- | --- | --- | --- |
| `layout` | a template id above (or `none`) | none | Switches collage mode on |
| `cells` | comma list / repeated; each an image id or empty | empty | Cell sources in template order |
| `gutter` | integer 0-512 (px) or `0%`-`20%` of the shorter canvas side | `2%` | Gap between cells and to the edge |
| `cellCorners` | integer 0-100 | 0 | Rounded corners per cell (radius from the cell's own size) |
| `cellFit` | `cover`, `contain`; one value, or a comma list / repeated per cell | `cover` | How each image fills its cell (per cell when a list is given) |
| `cellX`, `cellY` | integer -4096..4096; comma list / repeated per cell (missing = 0) | 0 | Nudge a cover cell's crop window, px (clamped; toast on the page) |

### 4.8 Page layout and live updates

| Region | Content |
| --- | --- |
| Header | Title, Desktop / Mobile switch, Guide and Spec links; error banner below |
| Preview | The image (<= 72 vh) or the device frame; `<img>` carries its output size so the layout never shifts |
| Cards (2 columns from 720 px) | Image, Watermark (text, size, opacity, green tone), Enhance, Watermark position, Output (size, rotate), Export, Android (full width), Collage (full width) - each with a context line stating what is in effect |
| Action bar | Sticky at the bottom: **Apply**, "Unapplied changes" badge, Reset, Open image only, **Update as I change settings** toggle (`localStorage`) |
| Mechanics | One GET form `#settings` collects every field via `form="settings"`; Upload / Set text / Remove are small POST forms with hidden passthrough of the page state; all HTML is escaped by construction (`page/html.ts`: only `Safe` fragments carry markup) |

| Live updates | Detail |
| --- | --- |
| Trigger | `change` on any settings field (selects/checkboxes at once, text/number on blur or Enter, sliders on release), debounced 250 ms; the Apply button and Enter take the same path |
| In place | `fetch` the page, parse, pre-load **and decode** the new preview, then swap only the regions whose HTML changed; `history.pushState`; Back/Forward re-fetch (`popstate`). No blank frame: the pre-loaded `<img>` element itself is placed in the preview |
| Pending edits | Submitting commits the form baseline; fields edited after it keep the user's value across a swap, submitted ones take the server's answer |
| Off / no JS | Toggle off: edits show the badge until Apply. Without JS: the v0.5 behaviour (Apply navigates; scroll and focus restored from `sessionStorage`) |

### 4.9 In context: feed, grid, list

| Item | Detail |
| --- | --- |
| What | A third preview mode (`view=context`) that shows the finished image **the way people meet it**: as a tile in a gallery grid, a row thumbnail in a list, or a post in a social feed, among sample neighbours built from the stock images |
| Honesty | Every small image in a scene is a server render at its real display size via `thumb` (4 and 3.2), not a CSS downscale: a 200 px watermark really is a 28 px smudge at 150 px |
| Scenes | `scene=grid` (3x3 square tiles, ours in the centre; `tile` 96 / 150 / 240), `scene=list` (5 rows with square thumbnails, ours in the middle; `row` 48 / 64 / 96), `scene=feed` (a neutral feed column, 470 px wide: 3 posts with avatar, name, caption and action row, ours in the middle, neighbours through the same preset so shapes match). `theme=light` / `dark` |
| Neighbours | Deterministic: the stock images in a fixed order, skipping the selected one (a collage uses all six); neighbours get the preset and fit only, none of the user's transforms |
| Feed on a phone | `scene=feed&frame=1` renders the feed inside the Mobile device frame (`embed=scene` page in the iframe, `device` / `orientation` as in Mobile view); device chips appear under the frame. Feeds are capped at 72 vh and scroll, with our post scrolled into view |
| Placement review | With the watermark on, the page judges the mark **the way the scene shows it**. (1) **Crop**: grid tiles and list rows are centre square crops, which remove the bottom band of tall outputs and the right band of wide ones - exactly where a bottom-right mark sits. The toast states the cut fraction and the single traverse that moves the mark into the centre square (`thumbnailSafeTraverse`: up by the bottom band or left by the right band); a **fix chip** under the scene applies it. If the mark is wider than the square itself, the toast gives the largest width that fits (`maxSafeWidthPercent`). (2) **Legibility**: below 8 px tall at the scene's scale the toast gives the `wmWidth` that would reach 8 px (`requiredWidthPercent`) - or, when that exceeds 100 % or the width the square allows, says honestly that the size cannot carry a text mark. A tip recommends the green tone when none is set. In the feed on a phone the maths uses the device width. Nothing here changes the render: Desktop / Mobile output is untouched |
| Guides | `guides=1` outlines our item and labels it with its exact pixel size |
| Controls | Chips under the scene (plain links): Grid / List / Feed, the size, Light / Dark, and in the feed the device. The settings form carries `view`, `scene`, `tile`, `row`, `theme`, `device` as hidden fields so Apply / live updates keep the scene |
| Params | `view=context`, `scene` grid (default) / list / feed, `tile` 96 / 150 / 240 (default 150), `row` 48 / 64 / 96 (default 64), `theme` light (default) / dark, `frame` 1 (feed in the device frame); unknown values -> banner, Desktop view |

## 5. Examples (sample image is 960x640)

| Request | Result |
| --- | --- |
| `/image?width=480` | 480x320 |
| `/image?rotate=90&width=320` | 320x480 |
| `/image?wm=1&wmWidth=300` | 300x27 mark, 16 px from bottom-right, 70 % opacity |
| `/image?image=photo&wm=1&wmWidth=20%` | 1600x1200, 320x29 mark |
| `/image?wm=1&wmWidth=200&traverseX=-744&traverseY=-606` | Mark in the top-left corner (exact fit) |
| `/image?wm=1&wmWidth=200&traverseX=-745` | 400 `... would extend 1 px past the left edge ...` |
| `/image?wm=1&wmWidth=960` | 400 `Watermark 960x87 plus margin 16 does not fit inside the 960x640 image.` |
| `/image?image=photo&width=300&height=300&corners=100` | A 300 px circle |
| `/image?image=photo&preset=ig-story` | 1080x1920, attention-cropped |
| `/export?image=photo&preset=ig-square&format=jpeg&maxKB=60` | `photo-ig-square-1080x1080.jpg`, highest quality under 60 KB (`X-Export-Quality: 57`) |
| `/export?image=photo&format=png&maxKB=100` | 400 `maxKB applies to JPEG and WebP only (PNG is lossless).` |
| `/android.zip?image=photo&androidName=banner&dp=360` | 360/540/720/1080/1440 px PNGs + README |
| `/android.zip?image=photo&androidMode=icon&bg=%231f2933` | 19 files: 5 x (legacy, foreground, background), 2 XML, Play Store 512, README |
| `/image?layout=grid-2x2&cells=photo,fhd,portrait,panorama&preset=ig-square` | 1080x1080, four attention-cropped cells, 22 px white gutter |
| `/image?layout=screens-3&cells=portrait,portrait,portrait&preset=fb-post&cellFit=contain` | Three phone-shaped cells with the tall photo letter-boxed |
| `/image?layout=grid-2x2&cells=photo&wm=1` | Mark centred in the bottom margin band, dark green automatically (white `bg`) |
| `/?wm=1&traverseX=-800&appliedTraverseX=-100` | Page with a toast "Keeping -100"; image uses `traverseX=-100` |
| `/?view=mobile&device=iphone-13&guides=1` | iPhone frame with status bar, nav bar and notch guides |
| `/image?image=photo&preset=ig-square&wm=1&wmWidth=20%&thumb=150x150` | The finished post as a 150 px gallery tile (the mark is ~3 px tall) |
| `/?view=context&scene=list&row=48&wm=1` | List scene with 48 px thumbnails; toast: the watermark is unreadable at this size |

## 6. Configuration and runtime

| Setting | Value | Note |
| --- | --- | --- |
| `PORT` env var | default `3000` | Integer 1-65535, else process throws at startup |
| `HOST` env var | default `127.0.0.1` | Bind address. Anything that is not loopback prints a loud startup WARNING (no auth, no TLS, shared state) |
| `SHARP_VIEWER_UPLOAD_QUOTA_MB` | default `500` | Total size of `uploads/`; the oldest uploads are evicted to make room, a single file over the quota is a 400 |
| `SHARP_VIEWER_CONCURRENCY` | default = CPU count (`os.availableParallelism()`) | Pixel renders running at once (`renderLimits.concurrency`) |
| `SHARP_VIEWER_QUEUE` | default `32` | Renders allowed to wait for a slot; beyond that -> 503 immediately |
| `SHARP_VIEWER_RENDER_TIMEOUT_MS` | default `30000` | A render over this answers 503 (the work keeps its slot until sharp finishes) |
| `SHARP_VIEWER_CACHE_ENTRIES` / `SHARP_VIEWER_CACHE_MB` | default `64` / `256` | Server-side LRU of rendered outputs keyed on the parsed options + source/watermark file keys; responses stay `Cache-Control: no-store` |
| Bind address | `HOST` (default `127.0.0.1`) | Loopback by default |
| Startup log | `Sharp Viewer: http://127.0.0.1:<port>` | - |
| Listen error | logged, exit code 1 | e.g. port already in use |

## 7. Project layout

| Path | Role |
| --- | --- |
| `src/server.ts` | Entry point: `PORT` / `HOST`, loud warning when not loopback, listens |
| `src/app.ts` | Facade re-exporting the public API of the modules below (tests import from here) |
| `src/router.ts` | `createApp()`: routes, POST body parsing, status codes, security headers + CSP nonce, render admission |
| `src/params.ts` | Query parsing and option types for image / export / Android / collage / preview; parameter registries (`IMAGE_PARAMS`, `EXPORT_PARAMS`, `ANDROID_PARAMS`, `PASSTHROUGH_PARAMS`) |
| `src/geometry.ts` | Size maths: output size, watermark size and placement, traverse range, corner radius and clipping |
| `src/collage.ts` | Templates as canvas fractions, cell rectangles with gutter, nudge range, canvas rules |
| `src/pipeline.ts` | Native-size cache, `compose()` (rotate -> fit/resize or collage -> sharpen -> grayscale -> watermark -> corners), PNG preview, export + size search, effective watermark (collage margin / auto tone) |
| `src/watermark.ts` | Active mark (stock / custom / per-request), serialised writes, rasterisation, green tone scale, contrast helpers |
| `src/watermark-svg.ts`, `src/ttf.ts` | Text -> glyph-outline SVG generator and the minimal TrueType reader it needs |
| `src/android-zip.ts` | Bucket plans (4096 px cap), drawable and icon renders, ZIP + README |
| `src/images.ts` | Image registry: sample, stock, uploads (validation, EXIF bake-in, quota, cached index) |
| `src/cache.ts`, `src/limits.ts` | Render LRU; `MAX_DIMENSION`, render semaphore / queue / timeout (503) |
| `src/page/` | `html.ts` (escape-by-construction `Safe`), `context.ts` (all page validation once), `cards.ts` (one function per card), `preview.ts` (switch, device frame, guides), `render.ts` (fills `public/index.html`) |
| `src/docs.ts`, `src/markdown.ts` | `/spec` and `/guide` pages; Markdown-subset renderer |
| `src/zip.ts`, `src/devices.ts`, `src/presets.ts`, `src/errors.ts`, `src/host.ts` | ZIP writer/reader, device profiles, platform presets + limits, `BadRequestError`, loopback check |
| `public/` | `index.html` template (inline CSS + one nonced script), `sample.png`, `stock/`, `watermark.svg` (+ git-ignored `watermark.custom.svg`) |
| `tools/` | `check-install.ts` (pre-flight), `make-watermark.py` / `.ts`, `make-stock-images.ts`, bundled DejaVu font |
| `tests/` | `*.test.ts` (node:test), `golden.*` + `fixtures/golden/` (byte-level fixtures), `browser/*.test.py` (Playwright). See `TESTING.md` |
| `SPEC.md`, `USER_GUIDE.md`, `TESTING.md`, `CODE_REFACTOR.md` | This spec; the non-technical guide; how it is tested; history, decisions and incidents |

## 8. Scripts and dependencies

| Script | Purpose |
| --- | --- |
| `npm ci` | Install from the lockfile (required first: `node_modules/` is not in git) |
| `npm run dev` / `npm start` | Start the server (`node src/server.ts`) |
| `npm test` / `npm run test:full` | Fast tier / full tier (see `TESTING.md`) |
| `npm run typecheck` | `tsc --noEmit` over `src/`, `tests/`, `tools/` |
| `npm run lint` / `npm run lint:fix` | Biome check / fix |
| `npm run check` | typecheck + lint + test |
| `npm run preflight` | Runs before dev/start/typecheck/test: dependencies present, `sharp` = pinned version, native binary loads |
| `npm run watermark[:node] -- --text "..."` | Generate a watermark SVG from the CLI |

| Package | Version | Why |
| --- | --- | --- |
| `sharp` | 0.33.5 (pinned) | Decode, resize, composite, encode. Types are imported by name (compiles against 0.33 and 0.35 typings); the pin is enforced by the pre-flight because pixel fixtures are verified for 0.33.5 |
| `typescript` | 5.9.3 (pinned) | Type-checking only |
| `@biomejs/biome` | 2.5.14 (pinned) | Lint + format |
| `@types/node` | ^22 | Node typings |

CI (`.github/workflows/ci.yml`): `npm ci`, typecheck, lint, `test:full` on Node 22.21 and 24, on ubuntu (x64) and macos (arm64).

## 9. Limitations

| Area | Current state |
| --- | --- |
| Scope | Single-user local tool: uploads and the persisted custom watermark are shared by everyone using the server (per-request `wmText` avoids the latter); loopback by default, no auth, no TLS |
| Performance | One render per request, bounded by the semaphore and a 30 s timeout; identical requests served from the LRU; a 4000x1000 render takes ~0.5 s |
| Transforms | No manual crop, free angles, blur or colour adjustments; collages are fixed templates (per-cell fit and nudge, no freeform drag) |
| Watermark | Text only (no logo/image marks); one persisted custom mark at a time |
| Export | PNG/JPEG/WebP (no AVIF); one file at a time; the unreachable-`maxKB` warning is a response header |
| Android | One asset per ZIP; no vector drawables or notification icons; guides use typical bar heights (24/48 dp) |
| Mobile preview | 10 fixed profiles, CSS-viewport emulation only in-page; the `<iframe>` reload is visible during live updates |
| In context | One neutral feed/gallery/list look (no platform-specific chrome); neighbours are the stock images only |
| Platforms | Rendered pixels differ by +-1 LSB between CPU architectures (libvips SIMD); the golden tests tolerate it and list the affected fixtures |
| Docs renderer | Markdown subset: headings, tables, code, lists, rules, single-level quotes, inline marks |
