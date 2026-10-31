# Sharp Viewer – User Guide

A plain-language guide to using Sharp Viewer. No programming knowledge needed.

---

## 1. What is it?

| Question | Answer |
| --- | --- |
| **What does it do?** | It is a small web page that gets a picture ready for social media or a mobile app. You pick a picture, tweak it (resize, rotate, sharpen, black-and-white, rounded corners, add a text watermark), see how it will look on a phone, and download the result. |
| **Who is it for?** | Anyone who needs a picture in "the right size for Instagram / Facebook / X / LinkedIn / YouTube / Pinterest", or app makers who need an image or app icon in all the sizes Android asks for. |
| **Where does it run?** | On your own computer only. Nothing is sent to the internet. Open it in your normal web browser. |
| **Do I need an account?** | No. There is no login and nothing to sign up for. |
| **Is it finished software?** | It is a demo / reference tool. It works well for one person at a time on their own machine, but it is not built to be shared publicly on the internet. |

---

## 2. Starting it

| Step | What to do |
| --- | --- |
| 1 | Make sure **Node.js** (version 22.21 or newer) is installed on the computer. Someone technical can help with this once; after that you never touch it again. |
| 2 | Open a terminal / command prompt in the project folder. |
| 3 | First time only: type `npm ci` and press Enter (this downloads the libraries it needs). If you skip this, the next step stops with the message *"Dependencies are not installed: run npm ci"* — that is the fix. |
| 4 | Type `npm run dev` and press Enter. You will see `Sharp Viewer: http://127.0.0.1:3000`. |
| 5 | Open your web browser and go to **http://127.0.0.1:3000**. |
| 6 | To stop it, go back to the terminal and press `Ctrl + C`. |

> **Tip:** If port 3000 is already in use, start it with `PORT=4000 npm run dev` and open http://127.0.0.1:4000 instead.

---

## 3. A tour of the page

The page is one long screen. The picture is at the top and the settings are below it, grouped into boxes ("cards"). You change settings, press **Apply**, and the picture at the top updates.

| Area | What it is for |
| --- | --- |
| **Header** | The name, a **Desktop / Mobile** switch (see section 8), a **Guide** link (this page) and a **Spec** link (the technical manual). |
| **Preview** | The big picture: this is exactly what you will download. |
| **Image** card | Choose which picture to work on, upload your own, or remove an upload. |
| **Watermark** card | Change the watermark text, turn it on or off, set its size and transparency. |
| **Enhance** card | Sharpen, make black-and-white, round the corners. |
| **Watermark position** card | Nudge the watermark away from its default bottom-right corner. |
| **Output** card | Set the width/height in pixels and rotate. |
| **Export** card | Pick a social-media size, a file type (PNG / JPEG / WebP), quality, a maximum file size, and **Download**. |
| **Android** card | For app makers: download all the Android sizes of an image or an app icon as one ZIP file. |
| **Action bar** (always visible at the bottom of the window) | **Apply** redraws the picture with your settings, **Reset** puts everything back to the defaults, **Open image only** shows just the picture. The **"Update as I change settings"** switch (on by default) makes every change take effect the moment you make it — pick from a dropdown, tick a box, leave a text field, release a slider — so you rarely need Apply at all. The page updates in place (no reload, no flash): the picture stays on screen until the new one is ready, and your scroll position and cursor stay where they were. The browser's Back button undoes a change. Turn it off when you want to change several things first (e.g. Width *and* Height) and apply them in one go; an "Unapplied changes" badge reminds you. |

**Golden rule: what you see at the top is what you download.** With live updates on, the picture follows your changes automatically; with it off, press **Apply** first. The Download buttons always give you the picture as it currently appears at the top.

Each card has a small grey line of text under its title (the "context line") that sums up what is currently in effect, e.g. *"photo.jpg · 1600×1200 · JPEG · stock"* or *"Sharpen off · Grayscale on · Rounded corners 40 → 216 px radius"*. Check these lines if you are unsure what is applied.

---

## 4. Choosing a picture (Image card)

| Option | Details |
| --- | --- |
| **Built-in pictures** | Six ready-made pictures to play with: `sample.png` (960×640, the default), `thumb.png` (tiny, 320×240), `photo.jpg` (a typical camera photo, 1600×1200), `fhd.jpg` (a widescreen 1920×1080 frame), `portrait.webp` (a tall phone photo, 1080×1920), `panorama.png` (very wide, 4000×1000). |
| **Your own picture** | Click **Choose File**, pick a file, click **Upload**. It appears under "Your uploads" in the Source list and is selected right away. |
| **Accepted files** | PNG, JPEG, WebP, GIF, TIFF, AVIF. Up to 25 MB, up to 8192 pixels on each side. |
| **Phone photos** | Photos taken sideways on a phone are automatically turned the right way up when uploaded. |
| **Removing an upload** | Select the upload in the Source list, then click **Remove this upload**. |
| **Do uploads stay?** | Yes. Uploads are kept in an `uploads` folder next to the program and are still there after a restart. Everyone using the same copy of the program sees the same uploads. |
| **If a file is refused** | A red message appears under the header (e.g. *"the file is not an image"* or *"file is 30.2 MB; the limit is 25 MB"*) and nothing changes. |

---

## 5. The watermark (Watermark + Watermark position cards)

The watermark is a line of text stamped over the picture, near the bottom-right corner. Out of the box it says **SHARP VIEWER**.

| Setting | What it does | Default |
| --- | --- | --- |
| **Text** + **Set text** | Type your own words (e.g. your brand name) and click **Set text**. The picture updates immediately. Your text is remembered until you click **Restore stock**, even after a restart. | SHARP VIEWER |
| **Restore stock** | Only shown while custom text is in use. Goes back to "SHARP VIEWER". | – |
| **Show watermark** | Tick to stamp it on, untick to leave the picture clean. | Off |
| **Width** | How wide the text is. Either pixels (`300`) or a percentage of the picture's width (`20%`). Percentages are best: the mark then scales with the picture. | 200 px |
| **Height** | Usually leave blank ("auto") so the text keeps its shape. If you set both width and height the text is stretched to fit. | auto |
| **Opacity (%)** | 100 = solid, 0 = invisible. | 70 |
| **Green tone** | Tick the box and drag the slider to recolour the mark on a scale from **light green** (left, for dark pictures) to **dark green** (right, for light pictures); the thin outline flips automatically so the text stays readable. Untick to get the original cream mark back. | off |
| **Margin (px)** | The gap between the text and the bottom/right edges. Blank = automatic (16, or the gap between collage pictures). | blank (16) |
| **traverseX / traverseY** | Move the text from its corner spot. Positive X = right, negative X = left, positive Y = down, negative Y = up. | 0 / 0 |

**Text rules:** 1–80 characters. Latin, Greek and Cyrillic letters (accents included), digits and punctuation all work. Characters the built-in font does not have (Chinese, Japanese, Arabic, most emoji…) are refused with a message listing the offending characters.

**What if the watermark doesn't fit?**

| Situation | What you will see |
| --- | --- |
| Text is wider than the picture allows | A red message, e.g. *"Watermark 960×87 plus margin 16 does not fit inside the 960×640 image."* Make it smaller or use a percentage. |
| You moved it off the edge with traverseX / Y | A yellow pop-up in the top-right, e.g. *"traverseX -800 is out of bounds for this size: allowed -744 to 16. Keeping 0."* The picture keeps the last good position. The pop-up closes itself after 6 seconds or when you click ×. |
| Rounded corners cut into the text | A yellow pop-up warns you; the picture still renders. Raise the margin or move the text inward. |

---

## 6. Touch-ups (Enhance + Output cards)

| Setting | What it does |
| --- | --- |
| **Sharpen** | A gentle crispness boost, applied after resizing. |
| **Grayscale** | Black-and-white. The watermark keeps its own colour. |
| **Rounded corners** (slider 0–100) | 0 = square corners, 100 = as round as possible (a pill shape, or a perfect circle if the picture is square). The number shown next to the slider is the setting; after Apply the context line tells you the radius in pixels. The rounded-off corners become transparent (see-through) in PNG and WebP; in JPEG they are filled with the Background colour. |
| **Width / Height (px)** | Resize. Fill in just one and the other is worked out automatically to keep the shape. Fill in both and the picture is stretched to exactly that size. The grey placeholder numbers show the picture's original size. Maximum 4096. |
| **Rotate** | 0°, 90°, 180° or 270° clockwise. Rotation happens before resizing, so "rotate 90 + width 320" gives a picture 320 wide after it has been turned. |

> Width and Height are ignored while a **Platform preset** (next section) is selected, because the preset decides the size. Rotate still applies.

---

## 7. Downloading (Export card)

| Setting | What it does | Default |
| --- | --- | --- |
| **Platform preset** | Pick the social network and post type; the picture is made exactly that size. This also changes the preview, so what you see is what you get. "None" means use the Output card instead. | None |
| **Fit** | How the picture is made to fit the preset's shape. **Cover** crops the edges off (it automatically keeps the most interesting part of the picture). **Contain** keeps the whole picture and fills the leftover space with the Background colour. | Cover |
| **Background** | A colour such as `#ffffff` (white) or `#000000` (black). Used for Contain padding and for JPEG corners. | #ffffff |
| **Format** | **PNG** (perfect quality, larger files, keeps transparency), **JPEG** (small files, best for photos, no transparency), **WebP** (small files and keeps transparency; works in modern browsers and apps). | PNG |
| **Quality** | 1–100, for JPEG and WebP only. Higher = better looking and bigger file. | 82 |
| **Max size (KB)** | Optional. For JPEG/WebP, the tool lowers the quality automatically until the file fits under this size (it will not go below quality 30). Not available for PNG. | none |
| **Download** | Saves the file. The name tells you what is inside, e.g. `photo-ig-square-1080x1080-wm.jpg` (picture, preset, size, `grey` if black-and-white, `wm` if watermarked). | – |

Hidden information (camera model, location, date) is always removed from downloaded files.

**Preset sizes**

| Preset | Size (pixels) |
| --- | --- |
| Instagram post (square) | 1080 × 1080 |
| Instagram post (portrait) | 1080 × 1350 |
| Instagram story / Reel cover | 1080 × 1920 |
| Instagram post (landscape) | 1080 × 566 |
| Facebook link / post | 1200 × 630 |
| X post | 1600 × 900 |
| X header | 1500 × 500 |
| LinkedIn post | 1200 × 627 |
| YouTube thumbnail | 1280 × 720 |
| Pinterest pin | 1000 × 1500 |

If your picture is smaller than the preset, the Export context line says *"upscaled from …"* – a warning that it may look soft.

---

## 8. Seeing it on a phone (Desktop / Mobile switch)

| Feature | Details |
| --- | --- |
| **Desktop** | The normal view: the picture at the top, settings below. |
| **Mobile** | The picture is shown inside a drawing of a phone or tablet screen, at the size that device would really show it. Settings stay below. |
| **In context** | The picture among other pictures: gallery grid, list, or social feed (see section 8b). |
| **Choosing a device** | Click a device name, or **Prev / Next** to step through them, or **Rotate to landscape / portrait**. |
| **Devices available** | iPhone SE, iPhone 13, iPhone 14 Pro Max, iPad Mini, iPad Pro 11, Galaxy S9+, Galaxy S24, Pixel 5, Pixel 7, Galaxy Tab S4. |
| **Show guides** (tick box in the Android card) | Draws translucent overlays showing the phone's status bar, navigation bar and camera notch / hole, so you can see what would be covered. Guides are only drawn on screen – never in downloads. |
| **Open this view in a new tab** | A link under the phone that opens just the picture at that phone's size. |

Note: the watermark is stamped into the picture at a fixed pixel size, so on a small phone screen it looks proportionally small. Use a **percentage width** (e.g. `20%`) to keep it readable.

---

## 8b. Seeing it in context (In context view)

Nobody sees your picture big and alone — they see it small, next to other people's pictures. The **In context** switch in the header shows exactly that.

| Scene | What you see |
| --- | --- |
| **Grid** | Your picture as one tile in a 3×3 gallery (tile size 96 / 150 / 240 px), with sample pictures around it. The tile is *really* rendered at that size by the tool, so the watermark looks exactly as small as it would on a platform. |
| **List** | Your picture as a thumbnail in a list of rows (48 / 64 / 96 px). |
| **Feed** | Your picture as a post in a social feed between two sample posts — on a desktop column, or **On a phone** inside a phone frame (pick the device). |
| **Light / Dark** | Both themes, because the watermark's contrast flips with the background. |
| **Show guides** | Outlines your item and shows its exact pixel size. |

If the watermark would be unreadable at that size, a yellow message tells you (e.g. *"In the grid (150 px tiles) the watermark is 3 px tall — unreadable"*). Make it wider (a bigger %) or shorter, and the message goes away.

---

## 9. For app makers: Android sizes (Android card)

Android phones come in many screen densities, and an app needs the same picture at several sizes. This card makes them all at once and packs them into a ZIP with a README that says where to copy each folder.

| Setting | What it does |
| --- | --- |
| **Mode** | **Drawable (image asset)** – an ordinary picture in every density. **Launcher icon** – a full app-icon set (adaptive + legacy + Play Store 512 px). |
| **Resource name** | The file name Android will use. Lowercase letters, digits and underscores only, starting with a letter (e.g. `banner`, `hero_image`). If you type something invalid, the message suggests a corrected name. |
| **Width (dp) / Height (dp)** | The size on screen in "density-independent pixels". Leave the height blank to keep the picture's shape. |
| **Format** | PNG or lossless WebP. |
| **Density boxes** | `mdpi` 1×, `hdpi` 1.5×, `xhdpi` 2×, `xxhdpi` 3×, `xxxhdpi` 4× – untick any you do not need. `nodpi` adds a copy that is never scaled. |
| **Density buckets table** | Shows the pixel size each density will get and an **OK** / **upscaled ×N** verdict. "Upscaled" (shown in red) means your source picture is too small for that size and will look blurry. |
| **Per device table** | For each phone in the device list: which density it picks and whether your picture is big enough for it. |
| **Download ZIP** | Saves everything. In Drawable mode all your other settings (watermark, grayscale, corners, preset fit) are applied to every size. |
| **Show guides** | In Launcher-icon mode the preview becomes the icon with two circles: the outer one is what launchers actually show, the inner one is the "safe zone" your artwork should stay inside. With the Instagram story preset it shades the top and bottom strips that Instagram covers with its own buttons. |

---

## 9b. Collages (Collage card)

Put several pictures on one canvas using a ready-made pattern.

| Setting | What it does |
| --- | --- |
| **Template** | The pattern: 2×2 grid, 3×3 grid, left/right or top/bottom split, one big + two small ("hero"), strips, three stacked rows, or 2–3 **phone screens** side by side (perfect for app-store screenshots). Pick it from the dropdown or click one of the little **picture buttons** below it. "None" goes back to a single picture. |
| **Cells** | The cell boxes are arranged **like the template itself**. In each box choose the picture (built-in or your uploads), how it fits (**Cover** crops to fill the slot, **Contain** shows the whole picture with Background bars), and a **nudge** (X, Y in pixels) to slide the crop — e.g. type `-200` in X to show more of the picture's left side, so a face isn't cut off. The tool never slides past the picture's edge and tells you if it had to stop early. Leave a cell "empty" to show the Background colour there. |
| **Gutter** | The gap between pictures and to the edge — pixels (`12`) or a percentage of the canvas (`2%`). |
| **Cell corners** | Round each picture's corners (0–100). The Enhance card's "Rounded corners" still rounds the whole collage. |
| **Canvas size** | The Platform preset if one is chosen; otherwise the Width and Height in the Output card (both needed); otherwise 1080×1080. Rotate does not apply to collages. |
| **Show guides** | Draws numbered outlines on the preview (empty slots say "empty") so you can see which box is which cell. Never in the download. |
| **Watermark on a collage** | Leave the watermark **Margin** blank and the mark tucks itself into the gap between pictures when it fits there — and, because that gap is the Background colour, it **automatically turns dark green on a light background or light green on a dark one** so you can see it (the Watermark card says "automatic"). Tick Green tone to choose your own shade. If the mark would cover a picture, a yellow message tells you which cell and what margin or gap would fix it; if your own colour choice is hard to read, another message suggests a better tone. |
| **Hints** | The card's grey line warns when cells would be very small on the chosen canvas, or when phone-screen cells are squeezed by a tall canvas. |

Everything else — sharpen, black-and-white, watermark, download, Android sizes, phone preview — works on the finished collage.

| I want to… | Do this |
| --- | --- |
| **Make an Instagram grid of four photos** | Collage card → Template "Grid 2 × 2" → pick four pictures → Export preset "Instagram post (square)" → Download (each choice shows up as you make it). |
| **Show three app screenshots side by side** | Upload your screenshots → Template "3 phone screens" → Cell fit **Contain** → Background a light grey → preset "Facebook link / post" or "X post" → Apply. |
| **Before / after** | Template "Split left / right" → Cell 1 before, Cell 2 after → Gutter `0` → Apply. |

---

## 10. Example scenarios

| I want to… | Do this |
| --- | --- |
| **Post a photo on Instagram with my brand name on it** | 1. Image card → Choose File → Upload. 2. Watermark card → type your brand in **Text** → **Set text**. 3. Tick **Show watermark**, Width `20%`. 4. Export card → Preset "Instagram post (square)", Format JPEG. 5. **Apply**, check the preview, **Download**. |
| **Make a YouTube thumbnail that must be under 200 KB** | Upload → Export preset "YouTube thumbnail" → Format JPEG → Max size `200` → Apply → Download. The tool picks the best quality that fits. |
| **Turn a square logo into a round profile picture** | Upload → Output card Width `400`, Height `400` → Enhance card slider to `100` → Format PNG (keeps the transparent corners) → Apply → Download. |
| **Put a tall photo in a story without cropping it** | Preset "Instagram story / Reel cover" → Fit **Contain** → Background `#000000` → Apply. The photo is centred on black bars. Tick **Show guides** to see the strips Instagram covers. |
| **Fix a photo that is lying on its side** | Output card → Rotate 90° or 270° → Apply. (Uploaded phone photos are usually fixed automatically already.) |
| **Move the watermark away from a busy corner** | Watermark position card → traverseX `-150` (moves it 150 px left) or traverseY `-100` (100 px up) → Apply. If you go too far, a yellow pop-up tells you the allowed range. |
| **Check how the picture looks on an iPhone and a Pixel** | Click **Mobile** in the header → click **iPhone 13**, then **Pixel 7** → try **Rotate to landscape**. Your settings stay as they were. |
| **Give my Android developer a banner in every size** | Android card → Mode Drawable → Resource name `banner` → Width `360` → Apply → check that every row says **OK** → **Download ZIP**. Send them the ZIP. |
| **Make an app icon from my logo** | Android card → Mode **Launcher icon** → Background colour in the Export card (e.g. `#1f2933`) → tick **Show guides** → Apply. Keep the logo inside the inner circle. **Download ZIP** gives 19 files ready to drop into the app. |
| **Start over** | Click **Reset** (bottom of the page). Uploads and custom watermark text are kept; everything else goes back to the defaults. |

---

## 11. Messages you may see

| Message | Meaning | What to do |
| --- | --- | --- |
| **Red box under the header** | A setting is impossible (e.g. watermark larger than the picture, a number out of range, a refused upload, invalid watermark text). The preview falls back to the plain sample picture. | Read the message; it says exactly which setting and which range is allowed. Fix it and Apply. |
| **Yellow pop-up, top-right** | A warning, not an error: the watermark was pushed off the edge (it stays where it was) or rounded corners clip it. | Optional: adjust and Apply. The pop-up disappears on its own after 6 seconds. |
| **Download / Download ZIP looks greyed out** | The current settings are invalid, so there is nothing valid to download. | Fix the red message first, then Apply. |
| **"Fix the settings above to enable the download"** | Same as above, shown in the Export card's context line. | As above. |
| **"The server is busy rendering other images; try again in a moment"** or **"Rendering timed out"** | Too many big pictures were requested at the same time, or one took more than 30 seconds. | Wait a moment and reload, or use a smaller size. |
| **"upscaled from 800×600"** in the Export card | The picture is being enlarged to reach the preset size and may look soft. | Use a bigger original if you can. |
| **"upscaled ×2.5"** in red in the Android tables | The source is too small for that density. | Use a bigger original, or untick that density. |

---

## 12. Good to know

| Topic | Details |
| --- | --- |
| **Nothing is saved by accident** | Settings live in the page address (the URL). Bookmark the address to come back to the same settings later. Only uploads and custom watermark text are stored on disk. |
| **Private** | The program listens only on your own computer (127.0.0.1). Other people on the network cannot reach it. |
| **Shared by all users of this copy** | If two people use the same running copy, they share the uploaded pictures and the custom watermark text. Uploads are capped at 500 MB in total; when full, the oldest ones are removed automatically. |
| **Speed** | Every change re-draws the picture from scratch. Very large pictures (e.g. 4000 px wide) take about half a second. |
| **Animated GIFs** | Only the first frame is used. |
| **What it cannot do** | Free-hand cropping, rotation by arbitrary angles, blur, brightness/colour adjustments, picture or logo watermarks (text only), AVIF downloads, free-form collage layouts (templates only). |
| **This guide** | Click **Guide** in the header (or open http://127.0.0.1:3000/guide) to read it in the browser at any time. |
| **Technical manual** | Click **Spec** in the header (or open http://127.0.0.1:3000/spec) for the complete technical description. |
