/**
 * The control cards (spec 4g). Each function turns the PageContext into the template values of
 * one card. Plain strings are escaped when inserted; markup is built with `html`/`raw` so that
 * user text (upload names, watermark text, error messages) is escaped at the point of use.
 */

import { BUCKETS, type BucketPlan, dpToPx, formatFactor, ICON, planDevices, suggestResourceName } from "../android.ts";
import { cellRects, findLayout, LAYOUTS, type Layout } from "../collage.ts";
import { type ImageSource, listImages, UPLOAD_ACCEPT } from "../images.ts";
import { escapeHtml } from "../markdown.ts";
import { ALLOWED_ROTATIONS, DEFAULT_WATERMARK_MARGIN, DEFAULT_WATERMARK_OPACITY, parseColourLoose, TRUTHY } from "../params.ts";
import { PRESETS, type Preset } from "../presets.ts";
import { toneColour } from "../watermark.ts";
import { WATERMARK_TEXT_MAX_LENGTH } from "../watermark-svg.ts";
import type { AndroidInfo, PageContext } from "./context.ts";
import { html, join, raw, type Safe, type Value } from "./html.ts";
import { pageUrl } from "./preview.ts";

export type Values = Record<string, Value>;

/** Hidden inputs that every POST form carries (page state for the redirect back). */
export function hiddenFields(params: URLSearchParams): Safe {
  return join([...params.entries()].map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`));
}

// ---------------------------------------------------------------------------
// Image card

async function imageOptions(selected: ImageSource): Promise<Safe> {
  const images = await listImages();
  const option = (i: ImageSource) =>
    html`<option value="${i.id}"${raw(i.id === selected.id ? " selected" : "")}>${i.label}${i.kind === "upload" ? " (upload)" : i.kind === "stock" ? " (stock)" : ""}</option>`;
  const groups: Array<[string, ImageSource[]]> = [
    ["Built-in", images.filter((i) => i.kind !== "upload")],
    ["Your uploads", images.filter((i) => i.kind === "upload")],
  ];
  return join(groups.filter(([, list]) => list.length > 0).map(([label, list]) => html`<optgroup label="${label}">${list.map(option)}</optgroup>`));
}

export async function imageCard(ctx: PageContext, passthroughHidden: Safe): Promise<Values> {
  const { selectedImage, nativeImage, imageFormat } = ctx;
  const kind = selectedImage.kind === "upload" ? " &middot; uploaded" : selectedImage.kind === "stock" ? " &middot; stock" : " &middot; built-in sample";
  return {
    IMAGE_OPTIONS: await imageOptions(selectedImage),
    IMAGE_CONTEXT: html`${selectedImage.label} &middot; ${nativeImage.width}&times;${nativeImage.height} &middot; ${imageFormat.toUpperCase()}${raw(kind)}`,
    IMAGE_ALT: `${selectedImage.label} with watermark preview`,
    NATIVE_WIDTH: String(nativeImage.width),
    NATIVE_HEIGHT: String(nativeImage.height),
    UPLOAD_ACCEPT,
    REMOVE_UPLOAD:
      selectedImage.kind === "upload"
        ? html`<form method="post" action="/upload" class="row"><input type="hidden" name="action" value="remove"><input type="hidden" name="id" value="${selectedImage.id}"><button type="submit" class="danger">Remove this upload</button>${passthroughHidden}</form>`
        : "",
  };
}

// ---------------------------------------------------------------------------
// Watermark + position cards

export function watermarkCard(ctx: PageContext, passthroughHidden: Safe): Values {
  const { active, forwarded, shownMark, applied, extras } = ctx;
  const markContext = shownMark ? ` &middot; ${shownMark.width}&times;${shownMark.height} px on this image` : " &middot; hidden";
  return {
    WM_TEXT: extras.watermarkTextInput ?? active.text ?? "",
    WM_TEXT_MAX: String(WATERMARK_TEXT_MAX_LENGTH),
    WM_STATUS: html`"${active.text ?? (active.custom ? "custom" : "SHARP VIEWER")}" (${active.perRequest ? "this request" : active.custom ? "custom" : "stock"})${raw(markContext)}${ctx.toneOn && forwarded.has("wmTone") ? raw(` &middot; Green tone ${escapeHtml(forwarded.get("wmTone") ?? "")}`) : ctx.autoToneInfo ? raw(` &middot; Green tone ${ctx.autoToneInfo.tone} (automatic: ${ctx.autoToneInfo.tone === 100 ? "dark green on the light" : "light green on the dark"} background)`) : ""}`,
    RESTORE_BUTTON: active.custom ? raw('<button type="submit" name="action" value="restore" style="align-self: end">Restore stock</button>') : "",
    PASSTHROUGH_HIDDEN: passthroughHidden,
    WM_CHECKED: TRUTHY.has((forwarded.get("wm") ?? "").toLowerCase()) ? "checked" : "",
    WM_WIDTH: forwarded.get("wmWidth") ?? "",
    WM_HEIGHT: forwarded.get("wmHeight") ?? "",
    // Blank means "automatic": 16 px, or on a collage the gutter-derived margin (4k). The placeholder shows which.
    WM_MARGIN: forwarded.get("wmMargin") ?? "",
    WM_MARGIN_AUTO: String(ctx.effectiveMargin ?? DEFAULT_WATERMARK_MARGIN),
    WM_OPACITY: forwarded.get("wmOpacity") ?? String(DEFAULT_WATERMARK_OPACITY),
    TRAVERSE_X: forwarded.get("traverseX") ?? "0",
    TRAVERSE_Y: forwarded.get("traverseY") ?? "0",
    APPLIED_TRAVERSE_X: String(applied.X),
    APPLIED_TRAVERSE_Y: String(applied.Y),
    WM_TONE_ON: ctx.toneOn ? "checked" : "",
    WM_TONE: ctx.params.get("wmTone") ?? "50",
    TONE_LIGHT: toneColour(0),
    TONE_DARK: toneColour(100),
  };
}

// ---------------------------------------------------------------------------
// Enhance + output cards

export function enhanceCard(ctx: PageContext): Values {
  const { enhance } = ctx;
  return {
    SHARPEN_CHECKED: enhance.sharpen ? "checked" : "",
    GRAYSCALE_CHECKED: enhance.grayscale ? "checked" : "",
    CORNERS: String(enhance.corners),
    ENHANCE_CONTEXT: raw(
      [
        `Sharpen ${enhance.sharpen ? "on" : "off"}`,
        `Grayscale ${enhance.grayscale ? "on" : "off"}`,
        enhance.corners > 0 ? `Rounded corners ${enhance.corners} &rarr; ${enhance.radius} px radius` : "Square corners",
      ].join(" &middot; "),
    ),
  };
}

export function outputCard(ctx: PageContext): Values {
  const { forwarded } = ctx;
  const values: Values = { WIDTH: forwarded.get("width") ?? "", HEIGHT: forwarded.get("height") ?? "" };
  const rotate = forwarded.get("rotate") ?? "0";
  for (const angle of ALLOWED_ROTATIONS) values[`ROTATE_${angle}`] = String(angle) === rotate ? "selected" : "";
  return values;
}

// ---------------------------------------------------------------------------
// Export card

function presetOptions(selected?: Preset): Safe {
  const groups = new Map<string, Preset[]>();
  for (const p of PRESETS) groups.set(p.platform, [...(groups.get(p.platform) ?? []), p]);
  return raw(
    `<option value="none"${selected ? "" : " selected"}>None (keep size / Output card)</option>` +
      [...groups.entries()]
        .map(
          ([platform, list]) =>
            `<optgroup label="${escapeHtml(platform)}">${list
              .map((p) => `<option value="${p.id}"${p === selected ? " selected" : ""}>${escapeHtml(p.label)} &middot; ${p.width}&times;${p.height}</option>`)
              .join("")}</optgroup>`,
        )
        .join(""),
  );
}

export function exportCard(ctx: PageContext): Values {
  const { exportInfo, exportOptions, error, exportError, forwarded, imageQuery, exportQuery } = ctx;
  const exportHref = `/export?${new URLSearchParams([...imageQuery.entries(), ...exportQuery.entries()]).toString()}`;
  const ready = exportInfo && !error && !exportError;
  const context = exportError
    ? "Fix the export settings to enable the download"
    : exportInfo
      ? [
          exportInfo.preset
            ? `${exportInfo.preset.id} &middot; ${exportInfo.output.width}&times;${exportInfo.output.height} &middot; ${exportInfo.fit}`
            : `${exportInfo.output.width}&times;${exportInfo.output.height}`,
          `${exportOptions.format.toUpperCase()}${exportOptions.format === "png" ? "" : ` q${exportOptions.quality}`}`,
          exportOptions.maxKB !== undefined ? `&le; ${exportOptions.maxKB} KB` : null,
          exportInfo.upscaledFrom ? `upscaled from ${exportInfo.upscaledFrom.width}&times;${exportInfo.upscaledFrom.height}` : null,
        ]
          .filter(Boolean)
          .join(" &middot; ")
      : "Fix the settings above to enable the download";
  return {
    PRESET_OPTIONS: presetOptions(exportInfo?.preset),
    FIT_COVER: (exportInfo?.fit ?? "cover") === "cover" ? "selected" : "",
    FIT_CONTAIN: exportInfo?.fit === "contain" ? "selected" : "",
    BG: exportInfo?.bg ?? parseColourLoose(forwarded.get("bg")),
    FORMAT_PNG: exportOptions.format === "png" ? "selected" : "",
    FORMAT_JPEG: exportOptions.format === "jpeg" ? "selected" : "",
    FORMAT_WEBP: exportOptions.format === "webp" ? "selected" : "",
    QUALITY: String(exportOptions.quality),
    MAX_KB: exportOptions.maxKB === undefined ? "" : String(exportOptions.maxKB),
    EXPORT_HREF: ready ? exportHref : "",
    EXPORT_DISABLED: ready ? raw("") : raw('aria-disabled="true"'),
    EXPORT_CONTEXT: raw(context),
    EXPORT_ERROR: exportError ? html`<p class="error" role="alert">${exportError}</p>` : "",
  };
}

// ---------------------------------------------------------------------------
// Android card

function androidTables(android: AndroidInfo): { density: Safe; devices: Safe; summary: Safe } {
  const { options, source } = android;
  const verdict = (v: BucketPlan["verdict"], factor: number) =>
    v === "ok"
      ? `<td class="ok">OK</td>`
      : v === "too-large"
        ? `<td class="warn">too large (skipped)</td>`
        : `<td class="warn">upscaled ${formatFactor(factor)}</td>`;
  let density: string, summary: string;
  if (options.mode === "drawable") {
    const { fit, skipped } = android.plan!;
    const plans = [...fit, ...skipped].sort((a, b) => a.bucket.scale - b.bucket.scale);
    density = `<table class="mini"><thead><tr><th>Bucket</th><th>Scale</th><th>Output px</th><th>Verdict</th></tr></thead><tbody>${plans
      .map(
        (p) =>
          `<tr><td>${p.bucket.id}</td><td>${p.bucket.scale}&times;</td><td>${p.output.width}&times;${p.output.height}</td>${verdict(p.verdict, p.factor)}</tr>`,
      )
      .join("")}</tbody></table>`;
    const bad = plans.filter((p) => p.verdict === "upscaled");
    summary = `${options.name} &middot; ${options.dpWidth}${options.dpHeight ? `&times;${options.dpHeight}` : ""} dp &middot; ${fit.map((p) => p.output.width).join("/")} px &middot; ${options.format.toUpperCase()}${bad.length ? ` &middot; <strong>${bad.length} of ${plans.length} buckets upscaled</strong>` : skipped.length ? "" : " &middot; source sufficient"}${skipped.length ? ` &middot; <strong>${skipped.length} of ${plans.length} buckets too large (skipped)</strong>` : ""}`;
  } else {
    density = `<table class="mini"><thead><tr><th>Bucket</th><th>Legacy 48 dp</th><th>Adaptive 108 dp</th><th>Safe zone 66 dp</th></tr></thead><tbody>${options.buckets
      .map(
        (b) => `<tr><td>${b.id}</td><td>${dpToPx(ICON.legacyDp, b)} px</td><td>${dpToPx(ICON.adaptiveDp, b)} px</td><td>${dpToPx(ICON.safeDp, b)} px</td></tr>`,
      )
      .join("")}</tbody></table>`;
    const safe = dpToPx(ICON.safeDp, BUCKETS[BUCKETS.length - 1]!);
    const small = source.width < safe && source.height < safe;
    summary = `${options.name} &middot; adaptive + legacy + Play Store 512 &middot; background ${options.image.bg}${small ? ` &middot; <strong>source smaller than the xxxhdpi safe zone (${safe} px)</strong>` : ""}`;
  }
  const dpW = options.mode === "icon" ? ICON.adaptiveDp : options.dpWidth;
  const dpH = options.mode === "icon" ? ICON.adaptiveDp : options.dpHeight;
  const devices = `<table class="mini"><thead><tr><th>Device</th><th>DPR</th><th>Bucket</th><th>Needs px</th><th>Verdict</th></tr></thead><tbody>${planDevices(
    source,
    dpW,
    dpH,
  )
    .map(
      (d) =>
        `<tr><td>${escapeHtml(d.device.name)}</td><td>${d.device.dpr}</td><td>${d.bucket.id}</td><td>${d.needs.width}&times;${d.needs.height}</td>${verdict(d.verdict, d.factor)}</tr>`,
    )
    .join("")}</tbody></table>`;
  // name, bg and ids are regex-validated (resource name, #rrggbb, bucket ids), so the fragments are safe.
  return { density: raw(density), devices: raw(devices), summary: raw(summary) };
}

export function androidCard(ctx: PageContext): Values {
  const { android, androidError, androidMode, androidQuery, selectedImage, error, state } = ctx;
  const tables = android ? androidTables(android) : undefined;
  return {
    ANDROID_MODE_DRAWABLE: androidMode === "drawable" ? "selected" : "",
    ANDROID_MODE_ICON: androidMode === "icon" ? "selected" : "",
    ANDROID_NAME: androidQuery.get("androidName") ?? "",
    ANDROID_NAME_PLACEHOLDER: androidMode === "icon" ? "ic_launcher" : suggestResourceName(selectedImage.label),
    DP: androidQuery.get("dp") ?? "",
    DP_HEIGHT: androidQuery.get("dpHeight") ?? "",
    ANDROID_FORMAT_PNG: (androidQuery.get("androidFormat") ?? "png") === "png" ? "selected" : "",
    ANDROID_FORMAT_WEBP: androidQuery.get("androidFormat") === "webp" ? "selected" : "",
    NODPI_CHECKED: TRUTHY.has((androidQuery.get("nodpi") ?? "").toLowerCase()) ? "checked" : "",
    BUCKET_CHECKS: raw(
      BUCKETS.map((b) => {
        const chosen = androidQuery.getAll("buckets").flatMap((v) => v.split(","));
        const on = chosen.length === 0 || chosen.includes(b.id);
        return `<label class="check"><input type="checkbox" name="buckets" value="${b.id}" form="settings"${on ? " checked" : ""}> ${b.id} <span class="hint">${b.scale}&times;</span></label>`;
      }).join(""),
    ),
    ANDROID_CONTEXT: tables ? tables.summary : androidError || "Fix the settings above to enable the ZIP",
    ANDROID_DENSITY_TABLE: tables ? tables.density : "",
    ANDROID_DEVICE_TABLE: tables ? tables.devices : "",
    ANDROID_HREF: android ? android.href : "",
    ANDROID_DISABLED: android ? raw("") : raw('aria-disabled="true"'),
    ANDROID_ERROR: androidError && !error ? html`<p class="error" role="alert">${androidError}</p>` : "",
    GUIDES_CHECKED: state.guides ? "checked" : "",
    GUIDES_HIDDEN: state.guides ? raw('<input type="hidden" name="guides" value="1">') : "",
  };
}

// ---------------------------------------------------------------------------
// Collage card (4k)

/** Inline SVG sketch of a template's cells (fractions -> a 30x22 box). */
function templateSketch(layout: Layout | undefined): Safe {
  const rects = layout
    ? layout.cells
        .map((c) => `<rect x="${(c.x * 30).toFixed(1)}" y="${(c.y * 22).toFixed(1)}" width="${(c.w * 30).toFixed(1)}" height="${(c.h * 22).toFixed(1)}"/>`)
        .join("")
    : '<rect x="0" y="0" width="30" height="22"/>';
  return raw(`<svg class="tsketch" viewBox="0 0 30 22" aria-hidden="true">${rects}</svg>`);
}

export async function collageCard(ctx: PageContext): Promise<Values> {
  const { collage, forwarded, selectedImage } = ctx;
  const images = await listImages();
  // The template as validated, else as typed (so an unrelated error does not reset the dropdown).
  const chosenLayout = collage?.options.layout ?? findLayout(forwarded.get("layout") ?? "");
  const shape = chosenLayout ?? findLayout("grid-2x2")!;
  const cellCount = chosenLayout ? chosenLayout.cells.length : 4;
  const canvas = collage?.canvas ?? { width: 1080, height: 1080 };
  // Cell ids / fits as typed (so the pickers echo even when the layout is invalid), else cell 1 = the selected image.
  const typed = (forwarded.get("cells") ?? "").split(",").map((v) => v.trim());
  const ids = collage ? collage.options.cells.map((c) => c ?? "") : forwarded.has("cells") ? typed : [selectedImage.id];
  const typedFits = (forwarded.get("cellFit") ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const fits = collage ? collage.options.cellFits : Array.from({ length: cellCount }, (_, i) => typedFits[i] ?? typedFits[0] ?? "cover");

  const sourcePicker = (i: number) => {
    const current = ids[i] ?? "";
    const options = [
      html`<option value=""${raw(current === "" ? " selected" : "")}>${"empty (background)"}</option>`,
      ...images.map(
        (img) =>
          html`<option value="${img.id}"${raw(img.id === current ? " selected" : "")}>${img.label}${img.kind === "upload" ? " (upload)" : img.kind === "stock" ? " (stock)" : ""}</option>`,
      ),
    ];
    return html`<select name="cells" form="settings" aria-label="Cell ${String(i + 1)} source">${options}</select>`;
  };
  const fitPicker = (i: number) => {
    const current = fits[i] ?? "cover";
    return html`<select name="cellFit" form="settings" aria-label="Cell ${String(i + 1)} fit"><option value="cover"${raw(current === "cover" ? " selected" : "")}>Cover</option><option value="contain"${raw(current === "contain" ? " selected" : "")}>Contain</option></select>`;
  };
  const typedX = (forwarded.get("cellX") ?? "").split(",").map((v) => v.trim());
  const typedY = (forwarded.get("cellY") ?? "").split(",").map((v) => v.trim());
  const nudgeField = (i: number, axis: "X" | "Y") => {
    const applied = collage?.nudges[i];
    const value = applied ? String(axis === "X" ? applied.x : applied.y) : ((axis === "X" ? typedX : typedY)[i] ?? "0") || "0";
    return html`<input type="number" name="cell${axis}" form="settings" aria-label="Cell ${String(i + 1)} nudge ${axis}" min="-4096" max="4096" value="${value}" title="Nudge the crop window (${axis === "X" ? "+ shows more of the right" : "+ shows more of the bottom"}; cover cells only)">`;
  };
  const pct = (v: number) => String(Number((v * 100).toFixed(2)));
  const cellGrid = html`<div class="cell-grid" style="aspect-ratio: ${String(canvas.width)} / ${String(canvas.height)}; --ar: ${(canvas.width / canvas.height).toFixed(4)}">${shape.cells.map(
    (c, i) =>
      html`<div class="cell-box${raw((ids[i] ?? "") !== "" ? " filled" : "")}" style="left:${pct(c.x)}%;top:${pct(c.y)}%;width:${pct(c.w)}%;height:${pct(c.h)}%"><div class="inner"><span class="cell-no">${String(i + 1)}</span>${sourcePicker(i)}${fitPicker(i)}<span class="nudge">${nudgeField(i, "X")}${nudgeField(i, "Y")}</span></div></div>`,
  )}</div>`;

  // Template gallery: plain links that keep every other setting (state lives in the URL).
  const chip = (layout: Layout | undefined) => {
    const active = layout === chosenLayout;
    const href = pageUrl(forwarded, { layout: layout?.id });
    return html`<a class="tchip${raw(active ? " active" : "")}" href="${href}"${raw(active ? ' aria-current="true"' : "")} title="${layout ? `${layout.cells.length} cells` : "single image"}">${templateSketch(layout)}${layout ? layout.label : "None"}</a>`;
  };

  // Hints: tiny cells, or phone cells squeezed by a tall canvas.
  const hints: string[] = [];
  if (collage) {
    const rects = cellRects(collage.options.layout, collage.canvas, collage.gutterPx);
    const shortest = Math.min(...rects.map((r) => Math.min(r.width, r.height)));
    if (shortest < 120) hints.push(`cells are small on this canvas (shortest side ${shortest} px)`);
    if (collage.options.layout.id.startsWith("screens-") && collage.canvas.height > collage.canvas.width)
      hints.push("phone cells are narrow on this tall canvas; try a wide preset (fb-post, x-post, yt-thumb)");
  }
  const fitLabel = collage ? (collage.options.cellFits.every((f) => f === collage.options.cellFits[0]) ? collage.options.cellFits[0]! : "mixed") : "";
  const context = collage
    ? [
        collage.options.layout.id,
        `${collage.canvas.width}&times;${collage.canvas.height}`,
        `${collage.options.cells.length} cells (${collage.options.cells.filter(Boolean).length} filled)`,
        `gutter ${collage.gutterPx} px`,
        fitLabel,
        collage.options.cellCorners ? `cell corners ${collage.options.cellCorners}` : null,
        ...hints.map((h) => `<strong>${escapeHtml(h)}</strong>`),
      ]
        .filter(Boolean)
        .join(" &middot; ")
    : "Single image &middot; pick a template to build a collage";
  return {
    LAYOUT_OPTIONS: join([
      html`<option value="none"${raw(chosenLayout ? "" : " selected")}>None (single image)</option>`,
      ...LAYOUTS.map(
        (l) => html`<option value="${l.id}"${raw(l === chosenLayout ? " selected" : "")}>${l.label} &middot; ${String(l.cells.length)} cells</option>`,
      ),
    ]),
    LAYOUT_GALLERY: join([chip(undefined), ...LAYOUTS.map((l) => chip(l))]),
    CELL_GRID: cellGrid,
    COLLAGE_CONTEXT: raw(context),
    GUTTER: forwarded.get("gutter") ?? "2%",
    CELL_CORNERS: forwarded.get("cellCorners") ?? "0",
  };
}

// ---------------------------------------------------------------------------
// Page chrome: body class, header, preview, banner, toasts, form actions

export function chrome(ctx: PageContext, overlay: { overlay: Safe; legend: Safe }, modeSwitch: Safe, mobilePreview: Safe | ""): Values {
  const { state, error, extras, warnings, viewState, imageQuery, androidQuery, android, androidMode } = ctx;
  const hasView = Object.keys(viewState).length > 0;
  const query = imageQuery.toString();
  // A watermark-text error only affects the banner; the image keeps its (valid) settings.
  const bannerError = [error, extras.watermarkError ?? ""].filter(Boolean).join(" ");
  return {
    NONCE: extras.nonce ?? "",
    BODY_CLASS: state.embed ? `embed${state.embed === "scene" ? " embed-scene" : ""}` : state.view,
    MODE_SWITCH: state.embed ? "" : modeSwitch,
    MOBILE_PREVIEW: mobilePreview,
    // In Mobile view the form re-renders the frame: carry the preview state with the submit.
    VIEW_HIDDEN: hasView ? join(Object.entries(viewState).map(([k, v]) => html`<input type="hidden" name="${raw(k)}" value="${v}">`)) : "",
    RESET_HREF: hasView ? pageUrl(new URLSearchParams(), viewState) : "/",
    IMAGE_SRC:
      androidMode === "icon" && android && !error
        ? `/android/icon-preview?${new URLSearchParams([...imageQuery.entries(), ...androidQuery.entries()]).toString()}`
        : error || query === ""
          ? "/image"
          : `/image?${query}`,
    ERROR: bannerError ? html`<p class="error" role="alert">${bannerError}</p>` : "",
    TOASTS: warnings.length
      ? html`<div class="toasts" role="status" aria-live="polite">${warnings.map((w) => html`<div class="toast"><span>${w}</span><button type="button" class="toast-close" aria-label="Dismiss">&times;</button></div>`)}</div>`
      : "",
    // Intrinsic size of the preview (the output size) so the layout does not shift when the image loads.
    IMAGE_DIMENSIONS:
      ctx.exportInfo && !error && !(androidMode === "icon" && android)
        ? raw(` width="${ctx.exportInfo.output.width}" height="${ctx.exportInfo.output.height}"`)
        : androidMode === "icon" && android && !error
          ? raw(' width="432" height="432"')
          : raw(' width="960" height="640"'),
    PREVIEW_OVERLAY: overlay.overlay,
    PREVIEW_LEGEND: overlay.legend,
  };
}
